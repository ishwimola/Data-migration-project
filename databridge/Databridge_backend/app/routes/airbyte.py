"""
Data Source Import Routes

ALL connectors go through PyAirbyte — including Google Sheets.
No separate connector services. One path for everything.

Supported: Salesforce, HubSpot, Zoho CRM, Google Sheets, MySQL,
PostgreSQL, SQL Server, MongoDB, Oracle, Stripe, Zendesk, Jira,
GitHub, Shopify, Mailchimp, and more.
"""

import logging
import uuid
from typing import Any

from fastapi import APIRouter, Depends, Form, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.services.airbyte_service import (
    SUPPORTED_SOURCES,
    get_connector_name,
    get_default_streams,
    get_popular_sources,
    health_check,
    list_streams,
    normalise_config,
    read_database_direct,
    read_source_to_dataframe,
)
from app.services.duckdb_service import get_conn
from app.services.profiling_service import generate_schema_profile
from app.services.postgres_services import (
    create_project,
    get_db,
    log_audit,
    update_project_records,
)

router = APIRouter()
logger = logging.getLogger(__name__)

# Sources where we use direct SQLAlchemy instead of PyAirbyte (faster for
# simple full-table reads and avoids CDC/replication setup requirements).
_DIRECT_DB_SOURCES = {"mysql", "postgresql", "mssql", "microsoftsqlserver"}


# =====================================================
# REQUEST MODELS
# =====================================================

class ConnectRequest(BaseModel):
    """Connect to any source and import a stream."""
    source_name: str           # UI display name, e.g. "Google Sheets"
    config: dict[str, Any]    # Connector credentials (flat key/value from the UI)
    stream: str = ""           # Stream / table / sheet to import (empty = use table_name from config)
    project_name: str = ""
    client_name: str = "Demo Client"
    target_entity: str = "account"


class ListStreamsRequest(BaseModel):
    """Discover available streams for a source."""
    source_name: str
    config: dict[str, Any] = {}  # empty dict allowed — returns static defaults


# =====================================================
# HEALTH CHECK
# =====================================================

@router.get("/health")
async def check_health():
    """Check if PyAirbyte is installed and ready."""
    result = health_check()
    return result


# =====================================================
# SOURCE CATALOGUE
# =====================================================

@router.get("/sources/popular")
async def get_sources():
    """Return the full source catalogue for the UI grid."""
    sources = get_popular_sources()
    return {"sources": sources, "total": len(sources)}


@router.get("/sources/available")
async def list_available_sources():
    """Alias for /sources/popular — returns all supported connectors."""
    sources = get_popular_sources()
    return {
        "airbyte_available": True,
        "mode": "pyairbyte",
        "total_sources": len(sources),
        "sources": sources,
    }


# =====================================================
# DISCOVER STREAMS
# =====================================================

@router.post("/sources/streams")
async def discover_streams(request: ListStreamsRequest):
    """
    Discover available streams (tables / sheets / objects) for any source.

    Two-tier strategy:
    - If credentials are incomplete → return static default streams instantly
    - If full credentials provided  → call PyAirbyte for live discovery
    - If live discovery fails       → fall back to static defaults
    """
    # DEBUG: Log what we received
    logger.info(f"discover_streams called for: {request.source_name}")
    logger.info(f"Config keys received: {list(request.config.keys())}")
    logger.info(f"Config (sanitized): {', '.join(f'{k}={len(str(v))} chars' for k, v in request.config.items())}")
    
    connector = get_connector_name(request.source_name)
    if not connector:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown source: '{request.source_name}'. Check /sources/popular for valid names.",
        )

    try:
        normalised = normalise_config(request.source_name, request.config, validate=False)
        streams = list_streams(
            connector,
            normalised,
            ui_name=request.source_name,
            raw_config=request.config,   # pass raw so completeness check uses UI field names
        )
        return {
            "source": request.source_name,
            "streams": streams,
            "total": len(streams),
            "live": bool(request.config),  # tells UI whether these are live or static
        }
    except ValueError as e:
        # Missing credentials — return defaults if any
        defaults = get_default_streams(request.source_name)
        if defaults:
            return {
                "source": request.source_name,
                "streams": defaults,
                "total": len(defaults),
                "live": False,
                "note": "Static streams (enter credentials and click Discover for live list)",
            }
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        # Live discovery failed — return defaults if any
        defaults = get_default_streams(request.source_name)
        if defaults:
            return {
                "source": request.source_name,
                "streams": defaults,
                "total": len(defaults),
                "live": False,
                "note": f"Using static streams (live discovery failed: {str(e)[:100]})",
            }
        raise HTTPException(
            status_code=500,
            detail=f"Failed to discover streams: {str(e)[:300]}",
        )


# =====================================================
# MAIN IMPORT ENDPOINT — works for ALL sources
# =====================================================

@router.post("/connect")
async def connect_and_import(request: ConnectRequest, db: Session = Depends(get_db)):
    """
    Connect to any supported source, pull one stream, and create a DataBridge project.

    Flow:
      1. Resolve source name → PyAirbyte connector name
      2. Pull data:
         - Direct SQLAlchemy for MySQL / PostgreSQL / SQL Server (faster for table reads)
         - PyAirbyte for everything else (Google Sheets, Salesforce, HubSpot, etc.)
      3. Store raw data in project DuckDB file
      4. Profile the schema
      5. Create project record in PostgreSQL
      6. Return project_id → frontend navigates to /schema
    """
    # DEBUG: Log what we received
    logger.info(f"connect_and_import called for: {request.source_name}")
    logger.info(f"Config keys received: {list(request.config.keys())}")
    logger.info(f"Config (sanitized): {', '.join(f'{k}={len(str(v))} chars' for k, v in request.config.items())}")
    logger.info(f"Stream: {request.stream}")
    
    source_key = request.source_name.lower().replace(" ", "")
    project_id = str(uuid.uuid4())

    # Resolve effective stream — for direct-DB sources the "stream" is the table name.
    # Accept it either as request.stream or inside config["table_name"].
    effective_stream = (
        request.stream.strip()
        or str(request.config.get("table_name", "")).strip()
    )

    # ── Step 1: Pull data ──────────────────────────────────────────────────────
    try:
        if source_key in _DIRECT_DB_SOURCES:
            if not effective_stream:
                raise HTTPException(
                    status_code=400,
                    detail="Table Name is required for database sources.",
                )
            conn_str = _build_connection_string(source_key, request.config)
            df = read_database_direct(source_key, conn_str, effective_stream)
        else:
            # PyAirbyte path: all other connectors including Google Sheets
            connector = get_connector_name(request.source_name)
            if not connector:
                raise HTTPException(
                    status_code=400,
                    detail=f"Unknown source: '{request.source_name}'. Check /api/airbyte/sources/popular.",
                )
            if not effective_stream:
                raise HTTPException(
                    status_code=400,
                    detail="Stream / Object is required. Select one from the dropdown.",
                )
            normalised = normalise_config(request.source_name, request.config)

            # Validate connectivity before attempting a full read.
            # source.check() causes Windows temp-file locking errors with PyAirbyte
            # (config not flushed before subprocess reads it → false "required property"
            # errors).  get_selected_streams() exercises the connector config in-process
            # without spawning a subprocess, giving us a clean early-exit on bad creds.
            try:
                from app.services.airbyte_service import get_connector_name as _gcn
                import airbyte as _ab
                _test_source = _ab.get_source(
                    connector,
                    config=normalised,
                    install_if_missing=True,
                )
                available_streams = _test_source.get_selected_streams()
                logger.info(f"Pre-flight stream check passed: {available_streams}")
            except Exception as _e:
                raise HTTPException(
                    status_code=400,
                    detail=f"Connection failed: {str(_e)}",
                )

            df = read_source_to_dataframe(connector, normalised, effective_stream)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Import failed: {str(e)}")

    if df.empty:
        raise HTTPException(status_code=400, detail="No data returned from source.")

    # ── Step 2: Store in DuckDB ────────────────────────────────────────────────
    try:
        duck = get_conn(project_id)
        duck.execute("CREATE TABLE raw_data AS SELECT * FROM df")
        duck.close()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to store data: {str(e)}")

    # ── Step 3: Schema profile ─────────────────────────────────────────────────
    schema_profile = generate_schema_profile(df)

    # ── Step 4: Create project in PostgreSQL ───────────────────────────────────
    project_name = request.project_name.strip() or f"{request.source_name} — {effective_stream}"

    create_project(
        db=db,
        project_id=project_id,
        project_name=project_name,
        client_name=request.client_name,
        source_type=request.source_name.lower(),
        target_entity=request.target_entity.lower(),
        duckdb_path=f"projects/project_{project_id}.duckdb",
    )
    update_project_records(db, project_id, len(df))
    log_audit(db, project_id, "data_imported", {
        "source": request.source_name,
        "stream": effective_stream,
        "rows": len(df),
        "columns": len(df.columns),
    })

    return {
        "message": "Data imported successfully",
        "project_id": project_id,
        "source": request.source_name,
        "stream": effective_stream,
        "rows": len(df),
        "columns": list(df.columns),
        "schema_profile": schema_profile,
    }


# =====================================================
# LEGACY FORM-BASED IMPORT (kept for backward compatibility)
# =====================================================

@router.post("/import")
async def import_legacy(
    source_type: str = Form(...),
    connection_string: str = Form(...),
    table_name: str = Form(...),
    project_name: str = Form(""),
    client_name: str = Form("Demo Client"),
    target_entity: str = Form("account"),
    db: Session = Depends(get_db),
):
    """
    Legacy form-based import for MySQL / PostgreSQL / SQL Server.
    Kept for backward compatibility with the existing SourceSelection.tsx form.
    New sources should use POST /api/airbyte/connect instead.
    """
    project_id = str(uuid.uuid4())
    source_key = source_type.lower().replace(" ", "")

    if source_key not in _DIRECT_DB_SOURCES:
        raise HTTPException(
            status_code=400,
            detail=f"Use POST /api/airbyte/connect for {source_type}.",
        )

    try:
        df = read_database_direct(source_key, connection_string, table_name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Import failed: {str(e)}")

    if df.empty:
        raise HTTPException(status_code=400, detail="No data found in source table.")

    duck = get_conn(project_id)
    duck.execute("CREATE TABLE raw_data AS SELECT * FROM df")
    duck.close()

    schema_profile = generate_schema_profile(df)

    create_project(
        db=db,
        project_id=project_id,
        project_name=project_name or f"{source_type} — {table_name}",
        client_name=client_name,
        source_type=source_type,
        target_entity=target_entity.lower(),
        duckdb_path=f"projects/project_{project_id}.duckdb",
    )
    update_project_records(db, project_id, len(df))
    log_audit(db, project_id, "data_imported", {
        "source_type": source_type,
        "table_name": table_name,
        "rows": len(df),
        "columns": len(df.columns),
    })

    return {
        "message": "Data imported successfully",
        "project_id": project_id,
        "source_type": source_type,
        "table_name": table_name,
        "rows": len(df),
        "columns": list(df.columns),
        "schema_profile": schema_profile,
    }


# =====================================================
# HELPERS
# =====================================================

def _build_connection_string(source_key: str, config: dict[str, Any]) -> str:
    """Build a SQLAlchemy connection URL from a config dict."""
    from urllib.parse import quote_plus
    
    h  = config.get("host", "localhost")
    p  = config.get("port")
    db = config.get("database", "")
    u  = quote_plus(str(config.get("username", "")))
    pw = quote_plus(str(config.get("password", "")))

    if source_key == "mysql":
        return f"mysql+pymysql://{u}:{pw}@{h}:{p or 3306}/{db}"
    elif source_key == "postgresql":
        return f"postgresql://{u}:{pw}@{h}:{p or 5432}/{db}"
    elif source_key in ("mssql", "microsoftsqlserver"):
        return f"mssql+pymssql://{u}:{pw}@{h}:{p or 1433}/{db}"
    # Caller passed a raw connection string
    return config.get("connection_string", "")
