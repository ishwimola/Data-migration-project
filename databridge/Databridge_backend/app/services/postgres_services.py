"""
PostgreSQL service — all persistent metadata operations.
Swap credentials by editing .env only.
"""

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from app.config.settings import DATABASE_URL
import json

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    connect_args={"connect_timeout": 10},
)
SessionLocal = sessionmaker(bind=engine)
#=============META DATA PERSISTENCE ==============

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ── Projects  ──────────────────────────────────────────────────────────────────

def create_project(db, project_id: str, project_name: str, client_name: str,
                   source_type: str, target_entity: str, duckdb_path: str) -> str:
    db.execute(text("""
        INSERT INTO metadata.projects
        (id, project_name, client_name, source_type, target_entity, duckdb_path)
        VALUES (:id, :name, :client, :source, :entity, :path)
    """), {
        "id": project_id, "name": project_name, "client": client_name,
        "source": source_type, "entity": target_entity, "path": duckdb_path,
    })
    db.commit()
    return project_id


def get_all_projects(db) -> list:
    result = db.execute(text("""
        SELECT id, project_name, client_name, target_entity,
               status, total_source_records, created_at
        FROM metadata.projects
        ORDER BY created_at DESC
    """))
    rows = []
    for r in result:
        row = dict(r._mapping)
        row["id"] = str(row["id"])
        row["created_at"] = row["created_at"].isoformat() if row["created_at"] else None
        rows.append(row)
    return rows


def get_project(db, project_id: str):
    result = db.execute(text(
        "SELECT * FROM metadata.projects WHERE id = :id"
    ), {"id": project_id}).fetchone()
    if not result:
        return None
    row = dict(result._mapping)
    row["id"] = str(row["id"])
    row["created_at"] = row["created_at"].isoformat() if row["created_at"] else None
    row["updated_at"] = row["updated_at"].isoformat() if row["updated_at"] else None
    return row


def update_project_status(db, project_id: str, status: str) -> None:
    db.execute(text("""
        UPDATE metadata.projects
        SET status = :status, updated_at = NOW()
        WHERE id = :id
    """), {"status": status, "id": project_id})
    db.commit()


def update_project_records(db, project_id: str, total: int) -> None:
    db.execute(text("""
        UPDATE metadata.projects
        SET total_source_records = :total, updated_at = NOW()
        WHERE id = :id
    """), {"total": total, "id": project_id})
    db.commit()


# ── Upload audit ──────────────────────────────────────────────────────────────

def log_upload_audit(db, project_id: str, file_name: str,
                     file_size: int, status: str, error_msg: str = None) -> None:
    db.execute(text("""
        INSERT INTO metadata.upload_audit
        (project_id, file_name, file_size_bytes, upload_status, error_message)
        VALUES (:pid, :fname, :fsize, :status, :error)
    """), {
        "pid": project_id, "fname": file_name,
        "fsize": file_size, "status": status, "error": error_msg,
    })
    db.commit()


# ── Field mappings ────────────────────────────────────────────────────────────

def save_field_mappings(db, project_id: str, mappings: list) -> None:
    db.execute(text(
        "DELETE FROM metadata.field_mappings WHERE project_id = :pid"
    ), {"pid": project_id})
    for m in mappings:
        db.execute(text("""
            INSERT INTO metadata.field_mappings
            (project_id, source_column, d365_field, d365_display_name,
             confidence_score, mapping_method, is_approved, is_mandatory_target, notes)
            VALUES (:pid, :src, :d365, :disp, :conf, :method, :approved, :mandatory, :notes)
        """), {
            "pid": project_id,
            "src": m["source_column"],
            "d365": m["d365_field"],
            "disp": m.get("d365_display_name", ""),
            "conf": m.get("confidence_score", 0),
            "method": m.get("mapping_method", "manual"),
            "approved": m.get("is_approved", False),
            "mandatory": m.get("is_mandatory_target", False),
            "notes": m.get("notes", ""),
        })
    db.commit()


def get_approved_mappings(db, project_id: str) -> list:
    """
    Returns approved field mappings for a project.
    Falls back to ALL non-excluded mappings if none are explicitly approved,
    so that a project where the user never clicked 'approve' still migrates.
    """
    result = db.execute(text("""
        SELECT source_column, d365_field, d365_display_name,
               confidence_score, is_mandatory_target
        FROM metadata.field_mappings
        WHERE project_id = :pid
         AND is_approved = TRUE
         AND d365_field IS NOT NULL
         AND d365_field != 'no_match'
    """), {"pid": project_id})
    rows = [dict(r._mapping) for r in result]

    # Fallback: if nothing is explicitly approved, use all mappings that have
    # a real d365 target (i.e. not excluded / no_match).
    # This handles the case where process-job ran but the user never visited
    # the Mapping page to approve.
    if not rows:
        result2 = db.execute(text("""
            SELECT source_column, d365_field, d365_display_name,
                   confidence_score, is_mandatory_target
            FROM metadata.field_mappings
            WHERE project_id = :pid
              AND d365_field IS NOT NULL
              AND d365_field != 'no_match'
        """), {"pid": project_id})
        rows = [dict(r._mapping) for r in result2]

    return rows


def update_mapping_master(db, mappings: list) -> None:
    for m in mappings:
        existing = db.execute(text("""
            SELECT id FROM metadata.mapping_master
            WHERE source_column_pattern = :pattern
        """), {"pattern": m["source_column"]}).fetchone()

        if existing:
            db.execute(text("""
                UPDATE metadata.mapping_master
                SET usage_count = usage_count + 1,
                    last_used_at = NOW(),
                    average_confidence = (average_confidence + :conf) / 2
                WHERE source_column_pattern = :pattern
            """), {"conf": m.get("confidence_score", 0), "pattern": m["source_column"]})
        else:
            db.execute(text("""
                INSERT INTO metadata.mapping_master
                (source_column_pattern, d365_field, d365_display_name, average_confidence)
                VALUES (:pattern, :d365, :disp, :conf)
            """), {
                "pattern": m["source_column"],
                "d365": m["d365_field"],
                "disp": m.get("d365_display_name", ""),
                "conf": m.get("confidence_score", 0),
            })
    db.commit()


# ── Cleansing playbook ────────────────────────────────────────────────────────

def save_playbook_step(db, project_id: str, instruction: str,
                       sql: str, affected_rows: int) -> None:
    max_step = db.execute(text("""
        SELECT COALESCE(MAX(step_number), 0)
        FROM metadata.cleansing_playbook
        WHERE project_id = :pid
    """), {"pid": project_id}).scalar()

    db.execute(text("""
        INSERT INTO metadata.cleansing_playbook
        (project_id, step_number, instruction_text, generated_sql, affected_rows)
        VALUES (:pid, :step, :instr, :sql, :rows)
    """), {
        "pid": project_id, "step": max_step + 1,
        "instr": instruction, "sql": sql, "rows": affected_rows,
    })
    db.commit()


def get_playbook(db, project_id: str) -> list:
    result = db.execute(text("""
        SELECT id, step_number, instruction_text, generated_sql,
               affected_rows, executed_at, is_active
        FROM metadata.cleansing_playbook
        WHERE project_id = :pid AND is_active = TRUE
        ORDER BY step_number ASC
    """), {"pid": project_id})
    rows = []
    for r in result:
        row = dict(r._mapping)
        row["id"] = str(row["id"])
        row["executed_at"] = row["executed_at"].isoformat() if row["executed_at"] else None
        rows.append(row)
    return rows


# ── Audit log ─────────────────────────────────────────────────────────────────

def log_audit(db, project_id: str, action: str,
              details: dict = None, status: str = "success") -> None:
    db.execute(text("""
        INSERT INTO metadata.audit_log (project_id, action, details, status)
        VALUES (:pid, :action, :details, :status)
    """), {
        "pid": project_id, "action": action,
        "details": json.dumps(details) if details else None,
        "status": status,
    })
    db.commit()


def get_audit_log(db, project_id: str) -> list:
    result = db.execute(text("""
        SELECT action, action_at, details, status
        FROM metadata.audit_log
        WHERE project_id = :pid
        ORDER BY action_at DESC
        LIMIT 100
    """), {"pid": project_id})
    rows = []
    for r in result:
        row = dict(r._mapping)
        row["action_at"] = row["action_at"].isoformat() if row["action_at"] else None
        rows.append(row)
    return rows


# ── Validation errors ─────────────────────────────────────────────────────────

def save_validation_errors(db, project_id: str, errors: list) -> None:
    db.execute(text(
        "DELETE FROM errors.validation_failures WHERE project_id = :pid"
    ), {"pid": project_id})
    for e in errors:
        db.execute(text("""
            INSERT INTO errors.validation_failures
            (project_id, row_number, source_column, rule_type, error_message, original_value)
            VALUES (:pid, :row, :col, :rule, :msg, :val)
        """), {
            "pid": project_id,
            "row": e["row_number"],
            "col": e["source_column"],
            "rule": e["rule_type"],
            "msg": e["error_message"],
            "val": str(e.get("original_value", "")),
        })
    db.commit()


# ── Migration stats ───────────────────────────────────────────────────────────

def save_migration_stats(db, project_id: str, total: int, loaded: int,
                         failed: int, entity: str) -> None:
    success_rate = round(loaded / total * 100, 2) if total > 0 else 0
    # Delete any existing row for this project first (no unique constraint on project_id)
    db.execute(text(
        "DELETE FROM reporting.migration_stats WHERE project_id = :pid"
    ), {"pid": project_id})
    db.execute(text("""
        INSERT INTO reporting.migration_stats
        (project_id, total_records, loaded_records, failed_records,
         success_rate, started_at, completed_at, target_entity)
        VALUES (:pid, :total, :loaded, :failed, :rate, NOW(), NOW(), :entity)
    """), {
        "pid": project_id, "total": total, "loaded": loaded,
        "failed": failed, "rate": success_rate, "entity": entity,
    })
    db.commit()


# ── Migration load errors (per-row) ──────────────────────────────────────────

def save_migration_errors(db, project_id: str, errors: list) -> None:
    """Save per-row Dataverse load errors so they can be exported."""
    db.execute(text(
        "DELETE FROM reporting.migration_errors WHERE project_id = :pid"
    ), {"pid": project_id})
    for e in errors:
        # row_number must be an integer — coerce any non-int values
        raw_row = e.get("row_number")
        try:
            row_num = int(raw_row) if raw_row is not None else 0
        except (ValueError, TypeError):
            row_num = 0
        db.execute(text("""
            INSERT INTO reporting.migration_errors
            (project_id, row_number, error_type, error_message)
            VALUES (:pid, :row, :etype, :emsg)
        """), {
            "pid":   project_id,
            "row":   row_num,
            "etype": e.get("error_type", "unknown"),
            "emsg":  e.get("error_message", ""),
        })
    db.commit()

# ── Project deletion ──────────────────────────────────────────────────────────

def delete_project(db, project_id: str) -> bool:
    """
    Hard-delete a project and all its related data from every schema.
    Returns True if the project existed and was deleted.
    """
    exists = db.execute(text(
        "SELECT 1 FROM metadata.projects WHERE id = :pid"
    ), {"pid": project_id}).fetchone()

    if not exists:
        return False

    # Delete in dependency order (child tables first)
    db.execute(text("DELETE FROM reporting.migration_stats  WHERE project_id = :pid"), {"pid": project_id})
    db.execute(text("DELETE FROM reporting.migration_errors WHERE project_id = :pid"), {"pid": project_id})
    db.execute(text("DELETE FROM errors.validation_failures WHERE project_id = :pid"), {"pid": project_id})
    db.execute(text("DELETE FROM metadata.cleansing_playbook    WHERE project_id = :pid"), {"pid": project_id})
    db.execute(text("DELETE FROM metadata.field_mappings        WHERE project_id = :pid"), {"pid": project_id})
    db.execute(text("DELETE FROM metadata.audit_log             WHERE project_id = :pid"), {"pid": project_id})
    db.execute(text("DELETE FROM metadata.upload_audit          WHERE project_id = :pid"), {"pid": project_id})
    db.execute(text("DELETE FROM metadata.projects              WHERE id         = :pid"), {"pid": project_id})
    db.commit()
    return True

# ── Mapping corrections history ───────────────────────────────────────────────

def get_mapping_correction(db, source_column: str, target_entity: str) -> dict | None:
    """
    Look up a human-confirmed correction for this source column + entity.
    Returns the correction dict or None if no history exists.
    """
    result = db.execute(text("""
        SELECT d365_field, d365_display_name, times_confirmed
        FROM metadata.mapping_corrections
        WHERE source_column = :col
          AND target_entity = :entity
    """), {
        "col": source_column.lower().strip(),
        "entity": target_entity.lower().strip(),
    }).fetchone()

    if not result:
        return None

    return dict(result._mapping)


def save_mapping_correction(
    db,
    source_column: str,
    target_entity: str,
    d365_field: str,
    d365_display_name: str,
) -> None:
    """
    Upsert a human-confirmed mapping correction.
    If the column was corrected before, increment times_confirmed.
    If it's new, insert it.
    """
    existing = db.execute(text("""
        SELECT id FROM metadata.mapping_corrections
        WHERE source_column = :col AND target_entity = :entity
    """), {
        "col": source_column.lower().strip(),
        "entity": target_entity.lower().strip(),
    }).fetchone()

    if existing:
        db.execute(text("""
            UPDATE metadata.mapping_corrections
            SET d365_field        = :field,
                d365_display_name = :disp,
                times_confirmed   = times_confirmed + 1,
                last_confirmed_at = NOW()
            WHERE source_column = :col AND target_entity = :entity
        """), {
            "field":  d365_field,
            "disp":   d365_display_name,
            "col":    source_column.lower().strip(),
            "entity": target_entity.lower().strip(),
        })
    else:
        db.execute(text("""
            INSERT INTO metadata.mapping_corrections
            (source_column, target_entity, d365_field, d365_display_name)
            VALUES (:col, :entity, :field, :disp)
        """), {
            "col":    source_column.lower().strip(),
            "entity": target_entity.lower().strip(),
            "field":  d365_field,
            "disp":   d365_display_name,
        })

    db.commit()