from fastapi import APIRouter, UploadFile, File, Form, HTTPException

from app.services.profiling_service import generate_schema_profile
from app.services.ai_mapper import process_mapping
from app.services.duckdb_service import get_conn
from app.services.postgres_services import (
    create_project,
    get_db,
    log_upload_audit,
    update_project_records,
    save_field_mappings,
    log_audit,
    save_mapping_correction,
)
from app.config.settings import TARGET_ENTITY, MAX_FILE_SIZE_MB
from sqlalchemy import text as sa_text
from pydantic import BaseModel
from typing import List, Optional

import re
import shutil
import os
import pandas as pd
import uuid


class ConfirmMappingItem(BaseModel):
    source_column: str
    d365_field: str
    d365_display_name: str


class ConfirmMappingRequest(BaseModel):
    mappings: List[ConfirmMappingItem]
    entity: Optional[str] = "account"


def _sanitise_table_name(name: str) -> str:
    safe = re.sub(r"[^a-zA-Z0-9_]", "_", name)
    if not safe:
        raise HTTPException(status_code=400, detail="Invalid table name derived from filename.")
    return safe


router = APIRouter()

UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)


# ── Upload file ───────────────────────────────────────────────────────────────

@router.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    entity: str = Form("account"),
    project_name: str = Form(""),
    client_name: str = Form("Demo Client"),
):
    import traceback
    import logging
    logger = logging.getLogger(__name__)
    file_path = None

    try:
        filename_lower = file.filename.lower()
        if not (filename_lower.endswith(".csv") or
                filename_lower.endswith(".xlsx") or
                filename_lower.endswith(".xls")):
            return {"error": "Only CSV and Excel (.xlsx / .xls) files are allowed"}

        if file.size and MAX_FILE_SIZE_MB:
            max_bytes = MAX_FILE_SIZE_MB * 1024 * 1024
            if file.size > max_bytes:
                raise HTTPException(
                    status_code=413,
                    detail=f"File too large. Maximum allowed size is {MAX_FILE_SIZE_MB} MB."
                )

        file_path = f"{UPLOAD_DIR}/{file.filename}"
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        if filename_lower.endswith(".csv"):
            df = pd.read_csv(file_path)
        else:
            df = pd.read_excel(file_path, sheet_name=0)
            df.columns = [str(c).strip().replace(" ", "_").replace("/", "_") for c in df.columns]

        if df.empty:
            return {"error": "File is empty"}

        schema_profile = generate_schema_profile(df)

        base_name          = file.filename.rsplit(".", 1)[0].replace(" ", "_")
        final_project_name = project_name.strip() if project_name.strip() else base_name
        final_client_name  = client_name.strip()  if client_name.strip()  else "Demo Client"
        project_id         = str(uuid.uuid4())
        safe_base          = _sanitise_table_name(base_name)
        table_name         = f"{safe_base}_{uuid.uuid4().hex[:4]}"

        conn = get_conn(project_id)
        conn.execute(f"CREATE TABLE {table_name} AS SELECT * FROM df")
        conn.execute(f"CREATE OR REPLACE TABLE raw_data AS SELECT * FROM {table_name}")
        conn.close()

        db = next(get_db())
        create_project(
            db=db, project_id=project_id, project_name=final_project_name,
            client_name=final_client_name, source_type="csv",
            target_entity=entity.lower(),
            duckdb_path=f"projects/project_{project_id}.duckdb"
        )
        update_project_records(db, project_id, len(df))
        log_upload_audit(db, project_id, file.filename, os.path.getsize(file_path), "uploaded")
        log_audit(db, project_id, "file_uploaded", {
            "filename": file.filename, "rows": len(df), "columns": len(df.columns)
        })

        return {
            "message": "File uploaded successfully",
            "project_id": project_id,
            "filename": file.filename,
            "table_name": table_name,
            "columns": list(df.columns),
            "rows": len(df),
            "schema_profile": schema_profile,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Upload failed: {str(e)}")
        logger.error(traceback.format_exc())
        return {"error": f"Upload failed: {str(e)}", "detail": "Check server logs"}


# ── Process job (AI mapping) ──────────────────────────────────────────────────

@router.post("/process-job")
async def process_job(data: dict):
    project_id = data.get("project_id")
    table_name = data.get("table_name")

    if not table_name:
        return {"error": "table_name is required"}
    if not project_id:
        return {"error": "project_id is required"}

    conn = get_conn(project_id)
    try:
        df = conn.execute(f"SELECT * FROM {table_name}").fetchdf()
    except Exception:
        conn.close()
        return {"error": "Table not found"}

    schema_profile = generate_schema_profile(df)

    db_for_entity = next(get_db())
    proj_row = db_for_entity.execute(
        sa_text("SELECT target_entity FROM metadata.projects WHERE id = :pid"),
        {"pid": project_id}
    ).fetchone()
    project_entity = proj_row[0] if proj_row and proj_row[0] else "account"

    # Keep db_for_entity open — Tier 1 history_match needs it
    mapping_results = process_mapping(df, schema_profile, project_entity, db=db_for_entity)
    db_for_entity.close()
    conn.close()

    formatted_mappings = []
    for mapping in mapping_results["mappings"]:
        target = mapping.get("suggested_target")
        formatted_mappings.append({
            "source_column":     mapping["source_column"],
            "d365_field":        target["logical_name"]  if target else "no_match",
            "d365_display_name": target["display_name"]  if target else "",
            "confidence_score":  mapping["confidence"],
            "mapping_method":    mapping["method"],
            "is_approved":       mapping["status"] == "Auto Approved",
            "is_mandatory_target": False,
            "notes":             mapping["notes"],
        })

    db = next(get_db())
    save_field_mappings(db, project_id, formatted_mappings)
    auto_count = sum(1 for m in formatted_mappings if m["is_approved"])
    log_audit(db, project_id, "ai_mapping_completed", {
        "total_mappings": len(formatted_mappings),
        "auto_approved":  auto_count,
        "needs_review":   len(formatted_mappings) - auto_count,
    })

    return {
        "message": "Processing completed",
        "project_id": project_id,
        "table_name": table_name,
        "total_rows": len(df),
        "mapping_results": mapping_results,
    }


# ── Confirm mappings (save human corrections to history) ──────────────────────

@router.post("/projects/{project_id}/mappings/confirm")
async def confirm_mappings(project_id: str, body: ConfirmMappingRequest):
    import logging
    logger = logging.getLogger(__name__)

    db = next(get_db())
    proj_row = db.execute(
        sa_text("SELECT target_entity FROM metadata.projects WHERE id = :pid"),
        {"pid": project_id},
    ).fetchone()
    entity = proj_row[0] if proj_row and proj_row[0] else (body.entity or "account")

    saved = 0
    for m in body.mappings:
        if not m.d365_field or m.d365_field == "no_match":
            continue
        try:
            save_mapping_correction(
                db=db,
                source_column=m.source_column,
                target_entity=entity,
                d365_field=m.d365_field,
                d365_display_name=m.d365_display_name,
            )
            saved += 1
        except Exception as e:
            logger.warning(f"Could not save correction for {m.source_column}: {e}")

    log_audit(db, project_id, "mappings_confirmed", {"corrections_saved": saved, "entity": entity})

    return {
        "confirmed": saved,
        "entity": entity,
        "message": f"Saved {saved} mapping correction(s) to history",
    }
