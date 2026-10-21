"""
EPIC-07 — Reporting & Audit
US-20: Migration summary report + exports
US-21: Audit log with filtering
"""

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy.orm import Session
from sqlalchemy import text
from typing import Optional
from functools import lru_cache
import json
import datetime
import os

from app.services.postgres_services import get_db, get_audit_log, delete_project
from app.services.exporter import (
    generate_error_excel,
    generate_migration_excel,
    generate_full_report_excel,
)

router = APIRouter(tags=["Reporting & Audit"])


# ── Delete project ────────────────────────────────────────────────────────────

@router.delete(
    "/projects/{project_id}",
    summary="Delete a project and all its data",
)
def delete_project_endpoint(project_id: str, db: Session = Depends(get_db)):
    """
    Hard-deletes a project and all related data:
    mappings, validation errors, cleansing playbook, audit log, migration stats.
    """
    deleted = delete_project(db, project_id)
    if not deleted:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Project not found")
    return {"deleted": True, "project_id": project_id}


# ── Bulk delete projects ──────────────────────────────────────────────────────

@router.delete(
    "/projects",
    summary="Bulk delete multiple projects",
)
def bulk_delete_projects(project_ids: list[str], db: Session = Depends(get_db)):
    """Delete multiple projects by ID list."""
    results = {}
    for pid in project_ids:
        results[pid] = delete_project(db, pid)
    return {"deleted": results}

@router.get(
    "/entities/{entity}/fields",
    summary="Get all mappable fields for a D365 entity",
)
@lru_cache(maxsize=20)
def get_entity_fields_list(entity: str):
    """
    Returns all mappable, non-read-only fields for the given entity
    from d365_fields.json. TASK-019: cached with lru_cache to avoid
    re-reading the file on every request.
    """
    fields_path = os.path.join(
        os.path.dirname(__file__), "..", "config", "d365_fields.json"
    )
    with open(fields_path) as f:
        data = json.load(f)

    entity_data = data.get("entities", {}).get(entity.lower(), {})
    all_fields  = entity_data.get("fields", [])

    mappable = [
        {"api": fld["logical_name"], "display": fld["display_name"]}
        for fld in all_fields
        if fld.get("mappable") and not fld.get("read_only")
    ]

    # Always prepend the "no match" option
    return {
        "entity": entity.lower(),
        "fields": [{"api": "no_match", "display": "— No Match / Exclude —"}] + mappable,
    }

@router.get(
    "/projects/{project_id}/mappings",
    summary="Get all saved field mappings for a project (reflects manual overrides)",
)
def get_project_mappings(project_id: str, db: Session = Depends(get_db)):
    """
    Returns all field mappings from the DB — including any manual overrides
    the user made in the Mapping page. Used by the Report page to show
    the actual mappings used, not the original AI suggestions.
    """
    rows = db.execute(text("""
        SELECT source_column, d365_field, d365_display_name,
               confidence_score, mapping_method, is_approved, notes
        FROM metadata.field_mappings
        WHERE project_id = :pid
        ORDER BY source_column ASC
    """), {"pid": project_id}).fetchall()

    return {"mappings": [dict(r._mapping) for r in rows]}


@router.put(
    "/projects/{project_id}/mappings",
    summary="Save user-approved field mappings from the Mapping page",
)
def save_project_mappings(project_id: str, body: dict, db: Session = Depends(get_db)):
    """
    Called when the user clicks 'Save and Proceed' on the Mapping page.
    Persists the full mapping list (including manual overrides and approvals)
    back to PostgreSQL so migration can use them.

    Body: { "mappings": [ { source, d365Field, display, confidence, method, status, excluded, notes } ] }
    """
    from app.services.postgres_services import save_field_mappings, log_audit

    raw_mappings = body.get("mappings", [])
    if not raw_mappings:
        return {"error": "No mappings provided"}

    # Normalise from frontend format → DB format
    normalised = []
    for m in raw_mappings:
        status   = m.get("status", "")
        excluded = m.get("excluded", False)
        d365     = m.get("d365Field") or m.get("d365_field") or "no_match"

        # A mapping is approved when:
        #   - status is auto_approved or needs_review (user reviewed it)
        #   - it is NOT excluded
        #   - it has a real d365 target
        is_approved = (
            not excluded
            and d365 not in ("no_match", "", None)
            and status in ("auto_approved", "needs_review", "Auto Approved", "Needs Review")
        )

        normalised.append({
            "source_column":      m.get("source") or m.get("source_column", ""),
            "d365_field":         d365,
            "d365_display_name":  m.get("display") or m.get("d365_display_name", ""),
            "confidence_score":   m.get("confidence", 0),
            "mapping_method":     m.get("method") or m.get("mapping_method", "manual"),
            "is_approved":        is_approved,
            "is_mandatory_target": False,
            "notes":              m.get("notes", ""),
        })

    save_field_mappings(db, project_id, normalised)

    approved_count = sum(1 for m in normalised if m["is_approved"])
    log_audit(db, project_id, "mappings_saved", {
        "total": len(normalised),
        "approved": approved_count,
    })

    return {
        "saved": len(normalised),
        "approved": approved_count,
        "message": f"Saved {len(normalised)} mappings ({approved_count} approved)",
    }


@router.get(
    "/projects/{project_id}/report",
    summary="US-20 — Full migration summary report",
)
def get_project_report(project_id: str, db: Session = Depends(get_db)):
    """
    Returns the complete migration summary:
    - Project metadata
    - Approved field mappings used
    - Validation error breakdown
    - Migration stats (loaded / failed / success rate)
    """
    project = db.execute(text(
        "SELECT * FROM metadata.projects WHERE id = :pid"
    ), {"pid": project_id}).fetchone()

    if not project:
        return {"error": "Project not found"}

    project_dict = dict(project._mapping)
    project_dict["id"] = str(project_dict["id"])
    project_dict["created_at"] = project_dict["created_at"].isoformat() if project_dict.get("created_at") else None
    project_dict["updated_at"] = project_dict["updated_at"].isoformat() if project_dict.get("updated_at") else None

    mappings = db.execute(text("""
        SELECT source_column, d365_field, d365_display_name,
               confidence_score, mapping_method
        FROM metadata.field_mappings
        WHERE project_id = :pid AND is_approved = TRUE
    """), {"pid": project_id}).fetchall()

    validation_breakdown = db.execute(text("""
        SELECT rule_type, COUNT(*) as count
        FROM errors.validation_failures
        WHERE project_id = :pid
        GROUP BY rule_type
    """), {"pid": project_id}).fetchall()

    validation_totals = db.execute(text("""
        SELECT
            (SELECT COUNT(DISTINCT row_number) FROM errors.validation_failures WHERE project_id = :pid) AS invalid_count,
            (SELECT total_source_records FROM metadata.projects WHERE id = :pid) AS total_count
    """), {"pid": project_id}).fetchone()

    migration_stats = db.execute(text("""
        SELECT total_records, loaded_records, failed_records, success_rate,
               started_at, completed_at, target_entity
        FROM reporting.migration_stats
        WHERE project_id = :pid
        ORDER BY started_at DESC LIMIT 1
    """), {"pid": project_id}).fetchone()

    stats_dict = None
    if migration_stats:
        stats_dict = dict(migration_stats._mapping)
        stats_dict["started_at"]   = stats_dict["started_at"].isoformat()   if stats_dict.get("started_at")   else None
        stats_dict["completed_at"] = stats_dict["completed_at"].isoformat() if stats_dict.get("completed_at") else None

    total_count   = validation_totals[1] or 0
    invalid_count = validation_totals[0] or 0
    valid_count   = total_count - invalid_count

    breakdown_dict = {r[0]: r[1] for r in validation_breakdown}

    return {
        "project":              project_dict,
        "mappings":             [dict(r._mapping) for r in mappings],
        "validation_breakdown": breakdown_dict,
        "validation_summary": {
            "total_count":   total_count,
            "valid_count":   valid_count,
            "invalid_count": invalid_count,
        },
        "migration_stats": stats_dict,
    }


# ── US-20: Export validation errors as Excel ─────────────────────────────────

@router.get(
    "/projects/{project_id}/report/validation-errors/export",
    summary="US-20 — Export validation errors as Excel",
    response_class=Response,
)
def export_validation_errors(project_id: str, db: Session = Depends(get_db)):
    rows = db.execute(text("""
        SELECT rule_type, source_column, error_message, row_number, original_value
        FROM errors.validation_failures
        WHERE project_id = :pid
        ORDER BY row_number ASC
    """), {"pid": project_id}).fetchall()

    error_list  = [dict(r._mapping) for r in rows]
    excel_bytes = generate_error_excel(error_list)

    return Response(
        content=excel_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=validation_errors_{project_id[:8]}.xlsx"},
    )


# ── US-20: Export migration errors as Excel ───────────────────────────────────

@router.get(
    "/projects/{project_id}/report/migration-errors/export",
    summary="US-20 — Export migration failed records as Excel",
    response_class=Response,
)
def export_migration_errors(project_id: str, db: Session = Depends(get_db)):
    # Read real per-row errors saved during migration
    rows = db.execute(text("""
        SELECT row_number, error_type, error_message, logged_at
        FROM reporting.migration_errors
        WHERE project_id = :pid
        ORDER BY row_number ASC
    """), {"pid": project_id}).fetchall()

    load_errors = [
        {
            "row_number":    r[0],
            "error_type":    r[1],
            "error_message": r[2],
        }
        for r in rows
    ]

    # If no per-row errors stored, fall back to summary from migration_stats
    if not load_errors:
        stats = db.execute(text("""
            SELECT total_records, loaded_records, failed_records
            FROM reporting.migration_stats
            WHERE project_id = :pid
            ORDER BY started_at DESC LIMIT 1
        """), {"pid": project_id}).fetchone()
        if stats and stats[2] > 0:
            load_errors.append({
                "row_number":    "N/A",
                "error_type":    "migration_failed",
                "error_message": f"{stats[2]} records failed during Dataverse load — per-row details not available",
            })

    excel_bytes = generate_migration_excel(load_errors)
    return Response(
        content=excel_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=migration_errors_{project_id[:8]}.xlsx"},
    )


# ── US-20: Export mapping config as JSON ─────────────────────────────────────

@router.get(
    "/projects/{project_id}/report/mappings/export",
    summary="US-20 — Export approved mapping config as JSON",
)
def export_mapping_config(project_id: str, db: Session = Depends(get_db)):
    mappings = db.execute(text("""
        SELECT source_column, d365_field, d365_display_name,
               confidence_score, mapping_method
        FROM metadata.field_mappings
        WHERE project_id = :pid AND is_approved = TRUE
    """), {"pid": project_id}).fetchall()
    return {"mappings": [dict(r._mapping) for r in mappings]}


# ── Full professional Excel report ───────────────────────────────────────────

@router.get(
    "/projects/{project_id}/report/full/export",
    summary="Export full professional migration report as Excel (AI-generated executive summary)",
    response_class=Response,
)
def export_full_report(project_id: str, db: Session = Depends(get_db)):
    """
    Generates a multi-sheet professional Excel report:
      Sheet 1 — Cover (branding, KPIs, AI executive summary)
      Sheet 2 — Migration Summary (detailed metrics)
      Sheet 3 — Field Mappings (confidence, method)
      Sheet 4 — Validation (error breakdown + per-row list)
      Sheet 5 — Audit Trail (full chronological log)
    """
    # ── Project ───────────────────────────────────────────────────────────────
    project_row = db.execute(text(
        "SELECT * FROM metadata.projects WHERE id = :pid"
    ), {"pid": project_id}).fetchone()

    if not project_row:
        return Response(content=b"Project not found", status_code=404)

    project = dict(project_row._mapping)
    project["id"] = str(project["id"])

    # ── Mappings ──────────────────────────────────────────────────────────────
    mappings = [
        dict(r._mapping)
        for r in db.execute(text("""
            SELECT source_column, d365_field, d365_display_name,
                   confidence_score, mapping_method
            FROM metadata.field_mappings
            WHERE project_id = :pid AND is_approved = TRUE
        """), {"pid": project_id}).fetchall()
    ]

    # ── Validation ────────────────────────────────────────────────────────────
    val_breakdown_rows = db.execute(text("""
        SELECT rule_type, COUNT(*) as count
        FROM errors.validation_failures
        WHERE project_id = :pid
        GROUP BY rule_type
    """), {"pid": project_id}).fetchall()
    validation_breakdown = {r[0]: r[1] for r in val_breakdown_rows}

    val_errors = [
        dict(r._mapping)
        for r in db.execute(text("""
            SELECT row_number, source_column, rule_type, error_message, original_value
            FROM errors.validation_failures
            WHERE project_id = :pid
            ORDER BY row_number ASC
        """), {"pid": project_id}).fetchall()
    ]

    total_count   = project.get("total_source_records") or 0
    invalid_count = db.execute(text("""
        SELECT COUNT(DISTINCT row_number) FROM errors.validation_failures
        WHERE project_id = :pid
    """), {"pid": project_id}).scalar() or 0
    valid_count = total_count - invalid_count

    validation_summary = {
        "total_count":   total_count,
        "valid_count":   valid_count,
        "invalid_count": invalid_count,
    }

    # ── Migration stats ───────────────────────────────────────────────────────
    stats_row = db.execute(text("""
        SELECT total_records, loaded_records, failed_records,
               success_rate, started_at, completed_at, target_entity
        FROM reporting.migration_stats
        WHERE project_id = :pid
        ORDER BY started_at DESC LIMIT 1
    """), {"pid": project_id}).fetchone()

    stats: dict = {}
    if stats_row:
        stats = dict(stats_row._mapping)
        stats["started_at"]   = stats["started_at"].isoformat()   if stats.get("started_at")   else None
        stats["completed_at"] = stats["completed_at"].isoformat() if stats.get("completed_at") else None
    else:
        stats = {
            "total_records": total_count, "loaded_records": 0,
            "failed_records": 0, "success_rate": 0,
            "target_entity": project.get("target_entity", "account"),
        }

    # ── Audit log ─────────────────────────────────────────────────────────────
    audit_rows = db.execute(text("""
        SELECT action, action_at, details, status
        FROM metadata.audit_log
        WHERE project_id = :pid
        ORDER BY action_at ASC
    """), {"pid": project_id}).fetchall()

    audit_log = []
    for r in audit_rows:
        row = dict(r._mapping)
        row["action_at"] = row["action_at"].isoformat() if row.get("action_at") else None
        if isinstance(row.get("details"), str):
            try:
                row["details"] = json.loads(row["details"])
            except Exception:
                pass
        audit_log.append(row)

    # ── Generate ──────────────────────────────────────────────────────────────
    excel_bytes = generate_full_report_excel(
        project=project,
        stats=stats,
        mappings=mappings,
        validation_breakdown=validation_breakdown,
        validation_errors=val_errors,
        validation_summary=validation_summary,
        audit_log=audit_log,
    )

    project_name = project.get("project_name", project_id[:8])
    safe_name    = "".join(c if c.isalnum() or c in "-_" else "_" for c in project_name)
    filename     = f"DataBridge_Report_{safe_name}_{datetime.date.today().isoformat()}.xlsx"

    return Response(
        content=excel_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── US-21: Audit log with filtering ──────────────────────────────────────────

@router.get(
    "/projects/{project_id}/audit",
    summary="US-21 — View and filter the complete audit log",
)
def get_project_audit_log(
    project_id: str,
    status: Optional[str] = Query(None, description="Filter: success | warning | failed"),
    search: Optional[str] = Query(None, description="Search in action name"),
    limit:  int           = Query(100, le=500),
    db: Session = Depends(get_db),
):
    query  = "SELECT action, action_at, details, status FROM metadata.audit_log WHERE project_id = :pid"
    params: dict = {"pid": project_id}

    if status:
        query += " AND status = :status"
        params["status"] = status

    if search:
        query += " AND action ILIKE :search"
        params["search"] = f"%{search}%"

    query += " ORDER BY action_at DESC LIMIT :limit"
    params["limit"] = limit

    rows = db.execute(text(query), params).fetchall()
    audit_log = []
    for r in rows:
        row = dict(r._mapping)
        row["action_at"] = row["action_at"].isoformat() if row["action_at"] else None
        if isinstance(row.get("details"), str):
            try:
                row["details"] = json.loads(row["details"])
            except Exception:
                pass
        audit_log.append(row)

    counts_rows = db.execute(text("""
        SELECT status, COUNT(*) as cnt
        FROM metadata.audit_log
        WHERE project_id = :pid
        GROUP BY status
    """), {"pid": project_id}).fetchall()
    counts = {r[0]: r[1] for r in counts_rows}

    return {
        "audit_log": audit_log,
        "total":     len(audit_log),
        "summary": {
            "success": counts.get("success", 0),
            "warning": counts.get("warning", 0),
            "failed":  counts.get("failed",  0),
        },
    }
