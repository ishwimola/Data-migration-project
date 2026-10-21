"""
EPIC-06 — Migration Execution
US-18: Run pre-flight checks and confirm migration readiness
US-19: Monitor migration progress with a live terminal log (WebSocket)
"""

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
from sqlalchemy import text, create_engine
from sqlalchemy.orm import sessionmaker
from app.services.postgres_services import (
    get_db, get_approved_mappings, log_audit,
    save_migration_stats, update_project_status, save_migration_errors,
)
from app.services.duckdb_service import execute_query
from app.services.dataverse_loader import load_to_dataverse
from app.config.settings import is_dataverse_configured, USE_STUBS, DATABASE_URL
from pydantic import BaseModel
import asyncio
import json
import logging

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Migration"])


class MigrateRequest(BaseModel):
    table_name: str = "raw_data"


# ── US-18: Pre-flight checks ──────────────────────────────────────────────────

@router.get(
    "/projects/{project_id}/migration/preflight",
    summary="US-18 — Run pre-flight checks before migration",
)
def preflight_check(project_id: str, db: Session = Depends(get_db)):
    """
    Checks all conditions required before migration can run:
    - Mappings approved
    - D365 credentials configured
    - Records available in DuckDB
    - Validation has been run
    - Cleansing playbook exists
    """
    mappings        = get_approved_mappings(db, project_id)
    d365_configured = is_dataverse_configured()

    try:
        df            = execute_query(project_id, "SELECT COUNT(*) as cnt FROM raw_data")
        total_records = int(df["cnt"].iloc[0]) if len(df) > 0 else 0
    except Exception:
        total_records = 0

    # Check if validation was run — look at audit log, not failure count
    # (a project with 0 failures still ran validation)
    validation_run = db.execute(text("""
        SELECT COUNT(*) FROM metadata.audit_log
        WHERE project_id = :pid AND action = 'validation_completed'
    """), {"pid": project_id}).scalar() or 0

    cleansing_steps = db.execute(text("""
        SELECT COUNT(*) FROM metadata.cleansing_playbook
        WHERE project_id = :pid AND is_active = TRUE
    """), {"pid": project_id}).scalar() or 0

    all_checks_pass = (
        len(mappings) > 0 and
        total_records > 0
    )

    return {
        "checks": {
            "mappings_approved":    len(mappings) > 0,
            "d365_configured":      d365_configured,
            "records_available":    total_records > 0,
            "validation_completed": validation_run > 0,
            "cleansing_complete":   cleansing_steps > 0,
        },
        "total_records":     total_records,
        "approved_mappings": len(mappings),
        "simulation_mode":   not d365_configured,
        "ready_to_migrate":  all_checks_pass,
        "d365_url":          "https://orgf6d34902.crm6.dynamics.com" if d365_configured else "Not configured",
    }


# ── US-19: WebSocket live terminal log ────────────────────────────────────────

@router.websocket("/projects/{project_id}/migration/stream")
async def migration_stream(project_id: str, websocket: WebSocket):
    """
    US-19 — Live terminal log via WebSocket.
    Each message: {"message": "...", "level": "info|warning|error|success", "ts": "HH:MM:SS"}
    Final message: {"done": true, "result": {...}}
    """
    import datetime

    await websocket.accept()

    async def send(msg: str, level: str = "info"):
        try:
            await websocket.send_text(json.dumps({
                "message": msg,
                "level":   level,
                "ts":      datetime.datetime.now().strftime("%H:%M:%S"),
            }))
        except Exception as ws_err:
            logger.warning(f"WS send failed: {ws_err}")

    # TASK-017: context manager guarantees session cleanup even on exception
    _ssl_args = {"sslmode": "require"} if "neon.tech" in DATABASE_URL else {}
    _engine   = create_engine(DATABASE_URL, pool_pre_ping=True, connect_args=_ssl_args)
    _Session  = sessionmaker(bind=_engine)

    try:
        with _Session() as db:
            # ── Step 1: Load mappings ─────────────────────────────────────────
            await send("Connecting to PostgreSQL...")
            mappings = get_approved_mappings(db, project_id)

            if not mappings:
                await send("No approved mappings found. Complete the Mapping step first.", "error")
                await websocket.close()
                return

            await send(f"Loaded {len(mappings)} approved field mappings")

            # ── Step 2: Resolve target entity ─────────────────────────────────
            project_row = db.execute(text(
                "SELECT target_entity FROM metadata.projects WHERE id = :pid"
            ), {"pid": project_id}).fetchone()
            entity = project_row[0] if project_row else "lead"
            await send(f"Target entity: {entity}")

            # ── Step 3: Read source data ──────────────────────────────────────
            await send("Reading source data from DuckDB...")
            try:
                df = execute_query(project_id, "SELECT * FROM raw_data")
            except Exception as e:
                await send(f"Failed to read data: {e}", "error")
                await websocket.close()
                return

            await send(f"Loaded {len(df)} records from raw_data")

            # ── Step 4: Exclude validation failures ───────────────────────────
            invalid_rows_q = db.execute(text("""
                SELECT DISTINCT row_number FROM errors.validation_failures
                WHERE project_id = :pid
            """), {"pid": project_id}).fetchall()
            invalid_set = {r[0] for r in invalid_rows_q}
            if invalid_set and "_row_number" in df.columns:
                before = len(df)
                df = df[~df["_row_number"].isin(invalid_set)].copy()
                await send(
                    f"Excluded {before - len(df)} invalid rows — "
                    f"{len(df)} valid records to migrate"
                )

            # ── Step 5: Apply field mappings ──────────────────────────────────
            await send("Applying field mappings and transformations...")
            col_lower_map = {c.lower(): c for c in df.columns}

            rename_map: dict = {}
            skipped: list = []
            for m in mappings:
                src  = m["source_column"]
                d365 = m.get("d365_field", "")
                if not d365 or d365 == "no_match":
                    continue
                if src in df.columns:
                    rename_map[src] = d365
                elif src.lower() in col_lower_map:
                    actual = col_lower_map[src.lower()]
                    rename_map[actual] = d365
                    await send(f"Column name fix: '{src}' matched as '{actual}'", "info")
                else:
                    skipped.append(src)

            if skipped:
                await send(
                    f"Warning: {len(skipped)} mapping(s) skipped — columns not found: "
                    f"{', '.join(skipped[:5])}{'...' if len(skipped) > 5 else ''}",
                    "warning"
                )

            logger.info(
                f"[{project_id}] rename_map={len(rename_map)} | "
                f"DB cols={[m['source_column'] for m in mappings]} | "
                f"DF cols={list(df.columns)}"
            )

            if not rename_map:
                await send(
                    f"No source columns matched. "
                    f"DB has: {[m['source_column'] for m in mappings[:5]]} | "
                    f"Data has: {list(df.columns[:5])}",
                    "error"
                )
                await websocket.close()
                return

            transformed_df = df.rename(columns=rename_map)
            d365_cols      = list(dict.fromkeys(rename_map.values()))
            transformed_df = transformed_df[[c for c in d365_cols if c in transformed_df.columns]]
            await send(f"Transformation complete — {len(transformed_df)} records, {len(d365_cols)} D365 fields")

            # ── Step 6: Determine mode ────────────────────────────────────────
            sim   = not is_dataverse_configured()
            total = len(transformed_df)

            if sim:
                await send("⚠ SIMULATION MODE — D365 credentials not configured", "warning")
                await send("Records will be counted locally only — nothing sent to Dataverse", "warning")
            else:
                await send("Connecting to Dataverse API...")

            update_project_status(db, project_id, "migrating")
            log_audit(db, project_id, "migration_started", {
                "total_records": total, "entity": entity,
            })

            success = 0
            failed  = 0

            await send(f"Starting batch 1/1 ({total} records)...")
            await asyncio.sleep(0.1)

            # ── Step 7: Execute migration ─────────────────────────────────────
            if sim:
                success = total
                failed  = 0
                await send(f"Simulation: {total} records processed locally (no D365 call)")
                await send(f"Batch 1/1 complete — {total} loaded, 0 failed")
            else:
                log_lines: list[str] = []

                def progress_cb(processed: int, total_r: int, s: int, f: int):
                    log_lines.append(
                        f"Progress: {processed}/{total_r} — {s} loaded, {f} failed"
                    )

                result_data = load_to_dataverse(
                    df=transformed_df,
                    entity=entity,
                    project_id=project_id,
                    approved_mappings=mappings,
                    progress_callback=progress_cb,
                )

                # Stream all accumulated progress lines
                for line in log_lines:
                    await send(line)

                if result_data.get("error") and result_data.get("total_success", 0) == 0:
                    err_msg = result_data["error"]
                    await send(f"Migration error: {err_msg}", "error")
                    update_project_status(db, project_id, "failed")
                    log_audit(db, project_id, "migration_failed", {"error": err_msg})
                    await websocket.send_text(json.dumps({
                        "done": True,
                        "result": {
                            "total_attempted": total,
                            "total_success":   0,
                            "total_failed":    total,
                            "success_rate":    0,
                            "simulation_mode": False,
                            "error":           err_msg,
                        },
                    }))
                    return

                success = result_data["total_success"]
                failed  = result_data["total_failed"]

                if result_data.get("errors"):
                    save_migration_errors(db, project_id, result_data["errors"])
                    for err in result_data["errors"][:5]:
                        raw_msg   = err.get("error_message", "")
                        clean_msg = raw_msg if not raw_msg.startswith("--batch") else f"HTTP {err.get('error_type', 'error')}"
                        await send(f"Row {err.get('row_number')}: {clean_msg[:150]}", "error")

            # ── Step 8: Persist results ───────────────────────────────────────
            # TASK-018: "completed" only when 0 failures; "partial" when mixed; "failed" otherwise
            final_status = "completed" if failed == 0 else "partial" if success > 0 else "failed"
            save_migration_stats(
                db, project_id,
                total=total, loaded=success, failed=failed, entity=entity,
            )
            update_project_status(db, project_id, final_status)
            log_audit(db, project_id, "migration_completed", {
                "total_attempted": total,
                "total_success":   success,
                "total_failed":    failed,
            })

            rate = round(success / total * 100, 1) if total > 0 else 0
            await send(f"Migration complete — {success} loaded, {failed} failed", "success")
            await send(f"Success rate: {rate}%", "success")
            if sim:
                await send("[SIMULATION MODE — no records were sent to D365]", "warning")

            await websocket.send_text(json.dumps({
                "done": True,
                "result": {
                    "total_attempted": total,
                    "total_success":   success,
                    "total_failed":    failed,
                    "success_rate":    rate,
                    "simulation_mode": sim,
                },
            }))

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for project {project_id}")
    except Exception as e:
        logger.error(f"Migration stream error for project {project_id}: {e}", exc_info=True)
        try:
            await send(f"Unexpected error: {str(e)}", "error")
        except Exception:
            pass


# ── Synchronous migrate (HTTP fallback) ───────────────────────────────────────

@router.post(
    "/projects/{project_id}/migrate",
    summary="US-19 — Execute migration (HTTP fallback, no live log)",
)
def start_migration(
    project_id: str,
    body: MigrateRequest,
    db: Session = Depends(get_db),
):
    """HTTP fallback when WebSocket is not available."""
    mappings = get_approved_mappings(db, project_id)
    if not mappings:
        return {"error": "No approved mappings. Complete mapping step first."}

    project = db.execute(text(
        "SELECT target_entity FROM metadata.projects WHERE id = :pid"
    ), {"pid": project_id}).fetchone()
    entity = project[0] if project else "lead"

    try:
        df = execute_query(project_id, f"SELECT * FROM {body.table_name}")
    except Exception as e:
        return {"error": f"Could not read data: {str(e)}"}

    if len(df) == 0:
        return {"error": "No records found in source data."}

    # Exclude rows that failed validation
    invalid_rows = db.execute(text("""
        SELECT DISTINCT row_number FROM errors.validation_failures
        WHERE project_id = :pid
    """), {"pid": project_id}).fetchall()
    invalid_set = {r[0] for r in invalid_rows}
    if invalid_set and "_row_number" in df.columns:
        df = df[~df["_row_number"].isin(invalid_set)].copy()
        log_audit(db, project_id, "invalid_rows_excluded", {"excluded": len(invalid_set)})

    # Case-insensitive column matching (same as WebSocket path)
    col_lower_map = {c.lower(): c for c in df.columns}
    rename_map: dict = {}
    for m in mappings:
        src  = m["source_column"]
        d365 = m.get("d365_field", "")
        if not d365 or d365 == "no_match":
            continue
        if src in df.columns:
            rename_map[src] = d365
        elif src.lower() in col_lower_map:
            rename_map[col_lower_map[src.lower()]] = d365

    logger.info(
        f"[{project_id}] HTTP migrate rename_map={len(rename_map)} | "
        f"DB cols={[m['source_column'] for m in mappings]} | "
        f"DF cols={list(df.columns)}"
    )

    if not rename_map:
        return {
            "error": (
                f"No source columns matched the approved mappings. "
                f"DB has: {[m['source_column'] for m in mappings[:5]]}. "
                f"Data has: {list(df.columns[:5])}."
            )
        }

    transformed_df = df.rename(columns=rename_map)
    d365_cols      = list(dict.fromkeys(rename_map.values()))  # deduplicated
    transformed_df = transformed_df[[c for c in d365_cols if c in transformed_df.columns]]

    total = len(transformed_df)

    update_project_status(db, project_id, "migrating")
    log_audit(db, project_id, "migration_started", {"total_records": total, "entity": entity})

    if not is_dataverse_configured():
        # Simulation mode — instant, no external calls
        success = total
        failed  = 0
        logger.info(f"[{project_id}] Simulation mode — {total} records counted locally")
    else:
        logger.info(f"[{project_id}] Starting real Dataverse migration — {total} records, entity={entity}")
        result_data = load_to_dataverse(
            df=transformed_df,
            entity=entity,
            project_id=project_id,
            approved_mappings=mappings,
        )
        success = result_data["total_success"]
        failed  = result_data["total_failed"]
        if result_data.get("errors"):
            save_migration_errors(db, project_id, result_data["errors"])
        if result_data.get("error") and success == 0:
            update_project_status(db, project_id, "failed")
            log_audit(db, project_id, "migration_failed", {"error": result_data["error"]})
            return {
                "total_attempted": total,
                "total_success":   0,
                "total_failed":    total,
                "success_rate":    0,
                "simulation_mode": False,
                "error":           result_data["error"],
            }

    # TASK-018: "completed" only when 0 failures; "partial" when mixed; "failed" otherwise
    final_status = "completed" if failed == 0 else "partial" if success > 0 else "failed"
    save_migration_stats(db, project_id, total=total, loaded=success, failed=failed, entity=entity)
    update_project_status(db, project_id, final_status)
    log_audit(db, project_id, "migration_completed", {
        "total_attempted": total, "total_success": success, "total_failed": failed,
    })

    rate = round(success / total * 100, 1) if total > 0 else 0
    logger.info(f"[{project_id}] Migration done — {success}/{total} loaded ({rate}%)")

    return {
        "total_attempted": total,
        "total_success":   success,
        "total_failed":    failed,
        "success_rate":    rate,
        "simulation_mode": not is_dataverse_configured(),
    }


@router.get("/projects/{project_id}/migration/results")
def get_migration_results(project_id: str, db: Session = Depends(get_db)):
    result = db.execute(text("""
        SELECT total_records, loaded_records, failed_records,
               success_rate, started_at, completed_at, target_entity
        FROM reporting.migration_stats
        WHERE project_id = :pid
        ORDER BY started_at DESC LIMIT 1
    """), {"pid": project_id}).fetchone()

    if not result:
        return {"status": "no_migration_run"}

    row = dict(result._mapping)
    row["started_at"]   = row["started_at"].isoformat()   if row["started_at"]   else None
    row["completed_at"] = row["completed_at"].isoformat() if row["completed_at"] else None
    return row


@router.get("/projects/{project_id}/migration/debug-payload")
def debug_payload(project_id: str, db: Session = Depends(get_db)):
    """
    Returns the first 3 rows as they would be sent to Dataverse.
    Use this to diagnose 'Error in Payload' rejections without running a full migration.
    """
    from app.services.duckdb_service import execute_query
    from app.services.dataverse_loader import _row_to_payload, _ensure_required_fields

    mappings = get_approved_mappings(db, project_id)
    if not mappings:
        return {"error": "No approved mappings"}

    project_row = db.execute(text(
        "SELECT target_entity FROM metadata.projects WHERE id = :pid"
    ), {"pid": project_id}).fetchone()
    entity = project_row[0] if project_row else "account"

    try:
        df = execute_query(project_id, "SELECT * FROM raw_data LIMIT 3")
    except Exception as e:
        return {"error": str(e)}

    # Apply rename
    rename_map = {
        m["source_column"]: m["d365_field"]
        for m in mappings
        if m.get("d365_field") and m["d365_field"] != "no_match"
        and m["source_column"] in df.columns
    }
    df = df.rename(columns=rename_map)
    d365_cols = list(dict.fromkeys(rename_map.values()))
    df = df[[c for c in d365_cols if c in df.columns]]

    payloads = []
    for _, row in df.iterrows():
        payload = _row_to_payload(row, entity)
        payload = _ensure_required_fields(payload, entity)
        payloads.append(payload)

    return {
        "entity": entity,
        "rename_map": rename_map,
        "sample_payloads": payloads,
        "fields_sent": list(payloads[0].keys()) if payloads else [],
    }
