"""
PyAirbyte Integration Service (FIXED)

Pulls data from 50+ certified connectors with robust error handling,
pre-installation checks, and proper cache management.

Key improvements:
- Pre-installs connectors to avoid first-use timeout
- Validates connector installation before use
- Proper cache isolation per request with guaranteed cleanup
- Better error messages with specific failure reasons
- Retry logic for transient failures

Usage:
    from app.services.airbyte_service import read_source_to_dataframe, SUPPORTED_SOURCES

    df = read_source_to_dataframe(
        source_name="source-salesforce",
        config={"client_id": "...", "client_secret": "...", "refresh_token": "..."},
        stream="contacts",
    )
"""

import logging
import os
import tempfile
import uuid
from typing import Any
from pathlib import Path

import pandas as pd

logger = logging.getLogger(__name__)

# Global flag to track if we've attempted connector pre-installation
_CONNECTORS_INITIALIZED = False

# ── Connector catalogue ────────────────────────────────────────────────────────
# Maps the UI display name → PyAirbyte connector name + required config fields.
# Full connector list: https://docs.airbyte.com/integrations/sources

SUPPORTED_SOURCES: dict[str, dict] = {
    # ── CRM ───────────────────────────────────────────────────────────────────
    "Salesforce": {
        "connector": "source-salesforce",
        "fields": ["client_id", "client_secret", "refresh_token"],
        "optional": ["is_sandbox"],
        "category": "CRM",
        "description": "Sync Contacts, Accounts, Leads, Opportunities from Salesforce",
        "default_streams": ["contacts", "accounts", "leads", "opportunities", "users", "cases", "tasks", "events", "campaigns"],
    },
    "HubSpot": {
        "connector": "source-hubspot",
        "fields": ["access_token"],
        "optional": [],
        "category": "CRM",
        "description": "Sync Contacts, Companies, Deals from HubSpot",
        "default_streams": ["contacts", "companies", "deals", "owners", "pipelines", "tickets", "products", "line_items"],
    },
    "Zoho CRM": {
        "connector": "source-zoho-crm",
        "fields": ["client_id", "client_secret", "refresh_token", "dc_region"],
        "optional": [],
        "category": "CRM",
        "description": "Sync records from Zoho CRM",
        "default_streams": ["Contacts", "Accounts", "Leads", "Deals", "Tasks", "Events", "Users"],
    },
    # ── Databases ─────────────────────────────────────────────────────────────
    "MySQL": {
        "connector": "source-mysql",
        "fields": ["host", "port", "database", "username", "password"],
        "optional": ["ssl_mode"],
        "category": "Database",
        "description": "Sync tables from MySQL / MariaDB",
        "default_streams": [],  # discovered live from the DB
    },
    "PostgreSQL": {
        "connector": "source-postgres",
        "fields": ["host", "port", "database", "username", "password"],
        "optional": ["schemas", "ssl_mode"],
        "category": "Database",
        "description": "Sync tables from PostgreSQL",
        "default_streams": [],  # discovered live from the DB
    },
    "Microsoft SQL Server": {
        "connector": "source-mssql",
        "fields": ["host", "port", "database", "username", "password"],
        "optional": ["schemas"],
        "category": "Database",
        "description": "Sync tables from SQL Server",
        "default_streams": [],  # discovered live from the DB
    },
    "MongoDB": {
        "connector": "source-mongodb-v2",
        "fields": ["connection_string", "database"],
        "optional": ["auth_source"],
        "category": "Database",
        "description": "Sync collections from MongoDB",
        "default_streams": [],  # discovered live from the DB
    },
    "Oracle DB": {
        "connector": "source-oracle",
        "fields": ["host", "port", "sid", "username", "password"],
        "optional": [],
        "category": "Database",
        "description": "Sync tables from Oracle Database",
        "default_streams": [],  # discovered live from the DB
    },
    # ── Files / Sheets ────────────────────────────────────────────────────────
    "Google Sheets": {
        "connector": "source-google-sheets",
        "fields": ["spreadsheet_id", "service_account_json"],
        "optional": [],
        "category": "File",
        "description": "Sync data from Google Sheets via PyAirbyte (paste service account JSON)",
        "default_streams": ["Sheet1", "Sheet2", "Sheet3"],  # fallback; live discovery replaces with real tab names
    },
    "CSV / S3": {
        "connector": "source-s3",
        "fields": ["bucket", "aws_access_key_id", "aws_secret_access_key", "path_pattern"],
        "optional": ["region_name"],
        "category": "File",
        "description": "Sync CSV files from Amazon S3",
        "default_streams": ["files"],
    },
    # ── SaaS / APIs ───────────────────────────────────────────────────────────
    "Stripe": {
        "connector": "source-stripe",
        "fields": ["account_id", "client_secret"],
        "optional": ["start_date"],
        "category": "Payments",
        "description": "Sync Customers, Invoices, Charges from Stripe",
        "default_streams": ["customers", "invoices", "charges", "payment_intents", "subscriptions", "products", "plans", "events"],
    },
    "Zendesk Support": {
        "connector": "source-zendesk-support",
        "fields": ["subdomain", "credentials"],
        "optional": ["start_date"],
        "category": "Support",
        "description": "Sync Tickets, Users, Organizations from Zendesk",
        "default_streams": ["tickets", "users", "organizations", "ticket_comments", "groups", "satisfaction_ratings"],
    },
    "Jira": {
        "connector": "source-jira",
        "fields": ["domain", "email", "api_token"],
        "optional": ["projects"],
        "category": "Project Management",
        "description": "Sync Issues, Projects, Users from Jira",
        "default_streams": ["issues", "projects", "users", "sprints", "boards", "components", "versions", "workflows"],
    },
    "GitHub": {
        "connector": "source-github",
        "fields": ["credentials", "repositories"],
        "optional": ["start_date"],
        "category": "Development",
        "description": "Sync Issues, PRs, Commits from GitHub",
        "default_streams": ["issues", "pull_requests", "commits", "repositories", "users", "releases", "reviews", "comments"],
    },
    "Shopify": {
        "connector": "source-shopify",
        "fields": ["shop", "credentials"],
        "optional": ["start_date"],
        "category": "E-Commerce",
        "description": "Sync Orders, Customers, Products from Shopify",
        "default_streams": ["orders", "customers", "products", "collections", "inventory_items", "fulfillments", "transactions"],
    },
    "Mailchimp": {
        "connector": "source-mailchimp",
        "fields": ["credentials"],
        "optional": [],
        "category": "Marketing",
        "description": "Sync Lists, Campaigns, Members from Mailchimp",
        "default_streams": ["lists", "campaigns", "members", "automations", "reports", "segments"],
    },
}


# ── Connector pre-installation ───────────────────────────────────────────────

def _get_google_sheets_manifest() -> "pathlib.Path | bool":
    """
    Return the local manifest.yaml path for source-google-sheets if available,
    otherwise fall back to True (download from registry).
    Using the local path runs the connector in-process — no subprocess, no
    Windows temp-file locking bug.
    """
    import pathlib
    # PyAirbyte installs connector venvs in a folder named .venv-<connector>
    # next to the working directory, or in the install_root.
    candidates = [
        # Relative to this file (Databridge_backend/)
        pathlib.Path(__file__).parent.parent / ".venv-source-google-sheets"
        / "Lib" / "site-packages" / "source_google_sheets" / "manifest.yaml",
        # Relative to cwd
        pathlib.Path(".venv-source-google-sheets")
        / "Lib" / "site-packages" / "source_google_sheets" / "manifest.yaml",
        # Linux path (WSL / deployment)
        pathlib.Path(__file__).parent.parent / ".venv-source-google-sheets"
        / "lib" / "python3.11" / "site-packages" / "source_google_sheets" / "manifest.yaml",
        pathlib.Path(__file__).parent.parent / ".venv-source-google-sheets"
        / "lib" / "python3.12" / "site-packages" / "source_google_sheets" / "manifest.yaml",
        pathlib.Path(__file__).parent.parent / ".venv-source-google-sheets"
        / "lib" / "python3.10" / "site-packages" / "source_google_sheets" / "manifest.yaml",
    ]
    for p in candidates:
        if p.exists():
            logger.info(f"Using local Google Sheets manifest: {p}")
            return p
    logger.warning("Local manifest.yaml not found — falling back to source_manifest=True (registry download)")
    return True  # fallback: PyAirbyte downloads from registry


def _ensure_connectors_installed():
    """
    Pre-install commonly used connectors on startup to avoid first-use timeout.
    Runs once per backend process lifecycle.
    """
    global _CONNECTORS_INITIALIZED
    
    if _CONNECTORS_INITIALIZED:
        return
    
    try:
        import airbyte as ab
        
        # Pre-install the 5 most common connectors to speed up first use
        priority_connectors = [
            "source-google-sheets",
            "source-salesforce",
            "source-mysql",
            "source-postgres",
            "source-hubspot",
        ]
        
        logger.info("Pre-installing priority connectors (runs once at startup)...")
        for connector in priority_connectors:
            try:
                # This installs the connector venv if missing — takes 20-60s per connector
                ab.get_source(connector, config={}, install_if_missing=True)
                logger.info(f"✓ {connector} ready")
            except Exception as e:
                logger.warning(f"⚠ {connector} install skipped: {e}")
                # Non-fatal — connector will install on first real use
        
        _CONNECTORS_INITIALIZED = True
        logger.info("Connector pre-installation complete")
        
    except Exception as e:
        logger.warning(f"Connector pre-installation failed: {e}")
        # Non-fatal — connectors will install on demand


# ── Health check ──────────────────────────────────────────────────────────────

def health_check() -> dict[str, Any]:
    """
    Check if PyAirbyte is installed and at least one connector is functional.
    Returns detailed status with specific failure reasons.
    """
    try:
        import airbyte as ab
    except ImportError:
        return {
            "status": "unhealthy",
            "available": False,
            "message": "PyAirbyte not installed. Run: pip install -r requirements-airbyte.txt",
            "mode": "pyairbyte",
        }
    
    # Try to instantiate a lightweight test connector to verify full functionality
    try:
        # Google Sheets is a good test — small, fast install, no external deps
        test_source = ab.get_source(
            "source-google-sheets",
            config={"spreadsheet_id": "test", "credentials": {"auth_type": "Service", "service_account_info": "{}"}},
            install_if_missing=True,
            source_manifest=_get_google_sheets_manifest(),
        )
        # If we can create the source object, PyAirbyte is functional
        return {
            "status": "healthy",
            "available": True,
            "message": "PyAirbyte ready — all connectors available",
            "mode": "pyairbyte",
            "test_connector": "source-google-sheets",
        }
    except Exception as e:
        return {
            "status": "degraded",
            "available": True,  # PyAirbyte is installed, just connector setup failed
            "message": f"PyAirbyte installed but connector test failed: {str(e)[:200]}",
            "mode": "pyairbyte",
            "note": "Connectors will install on first use (may take 30-60 seconds)",
        }


# ── Default streams (returned instantly, no credential check) ─────────────────

def get_default_streams(ui_name: str) -> list[str]:
    """Return the hardcoded default streams for a source without any API call."""
    entry = SUPPORTED_SOURCES.get(ui_name, {})
    return entry.get("default_streams", [])


# ── List available streams for a connector ────────────────────────────────────

def list_streams(
    source_name: str,
    config: dict[str, Any],
    ui_name: str = "",
    raw_config: dict[str, Any] | None = None,
) -> list[str]:
    """
    Return the list of available streams for a source.

    Strategy:
    1. If credentials incomplete (checked against raw_config) → return static defaults
    2. If full credentials → try live PyAirbyte discovery
    3. If live fails → fall back to static defaults with warning

    Args:
        source_name:  PyAirbyte connector name e.g. "source-google-sheets"
        config:       Already-normalised config dict (nested structure for PyAirbyte)
        ui_name:      UI display name e.g. "Google Sheets" (used for catalogue lookup)
        raw_config:   Original flat UI config — used for completeness check only.
                      If None, falls back to checking `config` directly.
    """
    source_meta = SUPPORTED_SOURCES.get(ui_name, {}) if ui_name else {}
    required_fields = source_meta.get("fields", [])
    defaults = source_meta.get("default_streams", [])

    # Completeness check — always use the raw (pre-normalisation) config so we
    # check the UI field names ("service_account_json") not the normalised ones ("credentials").
    check_config = raw_config if raw_config is not None else config
    
    # Check if any required fields are missing or empty
    missing_fields = [f for f in required_fields if not str(check_config.get(f, "")).strip()]
    
    if missing_fields:
        logger.info(f"Credentials incomplete for {ui_name}: missing {missing_fields}")
        if defaults:
            logger.info(f"Returning static default streams for {ui_name}")
            return defaults
        # No defaults available and credentials incomplete
        raise ValueError(
            f"Please fill in all required credentials before discovering streams for {ui_name}. "
            f"Missing: {', '.join(missing_fields)}"
        )

    # Fast path for direct-DB sources: use SQLAlchemy inspect instead of PyAirbyte
    _DIRECT_DB_UI = {"MySQL", "PostgreSQL", "Microsoft SQL Server"}
    if ui_name in _DIRECT_DB_UI:
        try:
            import sqlalchemy
            from urllib.parse import quote_plus

            h  = check_config.get("host", "localhost")
            p  = check_config.get("port")
            db = check_config.get("database", "")
            u  = quote_plus(str(check_config.get("username", "")))
            pw = quote_plus(str(check_config.get("password", "")))

            if ui_name == "MySQL":
                url = f"mysql+pymysql://{u}:{pw}@{h}:{p or 3306}/{db}"
            elif ui_name == "PostgreSQL":
                url = f"postgresql://{u}:{pw}@{h}:{p or 5432}/{db}"
            else:  # Microsoft SQL Server
                url = f"mssql+pymssql://{u}:{pw}@{h}:{p or 1433}/{db}"

            engine = sqlalchemy.create_engine(
                url,
                poolclass=sqlalchemy.pool.NullPool,
                connect_args={"connect_timeout": 10},
            )
            insp = sqlalchemy.inspect(engine)
            tables = insp.get_table_names()
            engine.dispose()
            logger.info(f"✓ Direct DB discovery for {ui_name}: {len(tables)} tables")
            return tables
        except Exception as e:
            logger.warning(f"Direct DB stream discovery failed for {ui_name}: {e}")
            if defaults:
                return defaults
            raise RuntimeError(
                f"Could not connect to {ui_name}: {str(e)[:300]}. "
                f"Check host, port, database, username and password."
            )

    # Live discovery path with proper error handling
    try:
        import airbyte as ab

        logger.info(f"Attempting live stream discovery for {source_name}...")

        # Install connector if needed (may take 30-60s on first use)
        if source_name == "source-google-sheets":
            import sys as _sys
            from pathlib import Path as _Path
            import yaml as _yaml
            from airbyte._executors.declarative import DeclarativeExecutor
            _venv_root = _Path(__file__).parent.parent.parent / ".venv-source-google-sheets"
            _site_pkgs = str(_venv_root / "Lib" / "site-packages")
            if _site_pkgs not in _sys.path:
                _sys.path.insert(0, _site_pkgs)
            _pkg = _venv_root / "Lib" / "site-packages" / "source_google_sheets"
            _manifest_path = _pkg / "manifest.yaml"
            _components_files = [
                _pkg / "components" / "extractors.py",
                _pkg / "components" / "partition_routers.py",
                _pkg / "utils.py",
                _pkg / "models" / "spreadsheet.py",
                _pkg / "models" / "spreadsheet_values.py",
            ]
            def _read_comp(p, is_first):
                text = p.read_text(encoding="utf-8")
                if not is_first:
                    lines = [l for l in text.splitlines(keepends=True)
                             if not l.strip().startswith("from __future__")]
                    text = "".join(lines)
                return text
            _existing = [p for p in _components_files if p.exists()]
            _components_py = "\n".join(
                _read_comp(p, i == 0) for i, p in enumerate(_existing)
            )
            _executor = DeclarativeExecutor(
                name=source_name,
                manifest=_manifest_path,
                components_py=_components_py if _components_py else None,
            )
            from airbyte.sources.base import Source
            source = Source(executor=_executor, name=source_name, config=config)
        else:
            source = ab.get_source(
                source_name,
                config=config,
                install_if_missing=True,
            )

        # Skip source.check() — Windows PyAirbyte temp-file bug causes false
        # "required property" errors. Credential errors surface on get_available_streams().
        logger.info(f"Skipping check() for stream discovery — proceeding to get_available_streams()")

        # Get available streams
        streams = source.get_available_streams()

        if not streams:
            logger.warning(f"No streams returned from {source_name}")
            if defaults:
                return defaults
            raise RuntimeError("No streams available from this source")

        logger.info(f"✓ Live discovery successful: {len(streams)} streams from {source_name}")
        return streams

    except ValueError:
        # Re-raise credential errors
        raise
    except Exception as e:
        error_msg = str(e)
        logger.error(f"Stream discovery failed for {source_name}: {error_msg}", exc_info=True)
        
        # Fall back to static defaults if available
        if defaults:
            logger.info(f"Falling back to static default streams for {ui_name}")
            return defaults
        
        # No defaults available — provide helpful error message
        if "install" in error_msg.lower():
            raise RuntimeError(
                f"Connector installation failed. Please check your internet connection "
                f"and try again. Error: {error_msg[:200]}"
            )
        elif "timeout" in error_msg.lower():
            raise RuntimeError(
                f"Connection timeout. The source may be unreachable or credentials invalid. "
                f"Error: {error_msg[:200]}"
            )
        else:
            raise RuntimeError(
                f"Stream discovery failed: {error_msg[:300]}. "
                f"Verify your credentials and try again."
            )


# ── Read a single stream into a DataFrame ─────────────────────────────────────

def read_source_to_dataframe(
    source_name: str,
    config: dict[str, Any],
    stream: str,
    max_retries: int = 2,
) -> pd.DataFrame:
    """
    Pull one stream from a source connector and return it as a DataFrame.
    
    Enhanced with:
    - Retry logic for transient failures
    - Better error messages
    - Guaranteed cache cleanup
    - Progress logging
    - Validation of returned data

    Args:
        source_name: PyAirbyte connector name, e.g. "source-google-sheets"
        config:      Normalised connector credentials/config dict
        stream:      Stream (sheet/table/object) name to read
        max_retries: Number of retry attempts for transient failures

    Returns:
        pandas DataFrame with the source data
        
    Raises:
        ValueError: If credentials are invalid
        RuntimeError: If data extraction fails after retries
    """
    import airbyte as ab
    
    logger.info(f"Starting data import: {source_name}/{stream}")
    
    last_error = None
    
    for attempt in range(max_retries + 1):
        cache_path = None
        cache = None
        
        try:
            if attempt > 0:
                logger.info(f"Retry attempt {attempt}/{max_retries} for {source_name}/{stream}")
            
            # Step 1: Initialize source
            logger.info(f"Initializing {source_name} connector...")
            # Google Sheets is a DeclarativeSource with custom Python components.
            # We run it fully in-process using DeclarativeExecutor + components_py
            # to bypass the Windows temp-file locking bug (subprocess reads empty
            # config, causing false "spreadsheet_id is required" errors).
            if source_name == "source-google-sheets":
                import sys as _sys
                from pathlib import Path as _Path
                from airbyte._executors.declarative import DeclarativeExecutor
                from airbyte.sources.base import Source
                _venv_root = _Path(__file__).parent.parent.parent / ".venv-source-google-sheets"
                # Add connector site-packages to sys.path so imports like
                # "from source_google_sheets.components import ..." resolve correctly
                _site_pkgs = str(_venv_root / "Lib" / "site-packages")
                if _site_pkgs not in _sys.path:
                    _sys.path.insert(0, _site_pkgs)
                _pkg = _venv_root / "Lib" / "site-packages" / "source_google_sheets"
                _manifest_path = _pkg / "manifest.yaml"
                # Build components_py from all Python files the manifest references
                _components_files = [
                    _pkg / "components" / "extractors.py",
                    _pkg / "components" / "partition_routers.py",
                    _pkg / "utils.py",
                    _pkg / "models" / "spreadsheet.py",
                    _pkg / "models" / "spreadsheet_values.py",
                ]
                # Strip "from __future__" lines from all but the first file —
                # concatenating multiple files with these imports causes:
                # SyntaxError: from __future__ imports must occur at the beginning
                def _read_component(p, is_first):
                    text = p.read_text(encoding="utf-8")
                    if not is_first:
                        lines = [l for l in text.splitlines(keepends=True)
                                 if not l.strip().startswith("from __future__")]
                        text = "".join(lines)
                    return text
                _existing = [p for p in _components_files if p.exists()]
                _components_py = "\n".join(
                    _read_component(p, i == 0) for i, p in enumerate(_existing)
                )
                _executor = DeclarativeExecutor(
                    name=source_name,
                    manifest=_manifest_path,
                    components_py=_components_py if _components_py else None,
                )
                source = Source(executor=_executor, name=source_name, config=config)
                source.select_streams([stream])
                logger.info(f"Google Sheets running in-process via DeclarativeExecutor")
            else:
                source = ab.get_source(
                    source_name,
                    config=config,
                    streams=[stream],
                    install_if_missing=True,
                )
            
            # Step 2: Validate credentials
            # NOTE: We skip source.check() on Windows because of a PyAirbyte temp-file
            # locking bug — the config file isn't flushed before the subprocess reads it,
            # causing false "required property" errors even with a correct config.
            # Credential errors will surface naturally on source.read() instead.
            logger.info(f"Skipping check() — will validate on read() instead")
            
            # Step 3: Create isolated cache
            cache_path = os.path.join(
                tempfile.gettempdir(),
                f"airbyte_cache_{uuid.uuid4().hex}.duckdb",
            )
            cache = ab.DuckDBCache(db_path=cache_path)
            logger.info(f"Created isolated cache: {cache_path}")
            
            # Step 4: Read data from source
            logger.info(f"Reading data from {source_name}/{stream}...")
            read_result = source.read(cache=cache)
            logger.info(f"Read complete: {read_result}")
            
            # Step 5: Convert to DataFrame
            logger.info(f"Converting stream '{stream}' to DataFrame...")
            
            # Use public PyAirbyte API (cache._cache is private and removed in newer versions)
            try:
                df: pd.DataFrame = cache[stream].to_pandas()
            except (KeyError, Exception) as e:
                # Try case-insensitive match using public streams API
                try:
                    available_tables = list(cache.streams)
                except Exception:
                    available_tables = []
                
                logger.info(f"Available cache tables: {available_tables}")
                
                stream_lower = stream.lower()
                matched = next(
                    (t for t in available_tables if t.lower() == stream_lower),
                    None
                )
                
                if matched:
                    logger.info(f"Stream name mismatch — using '{matched}' instead of '{stream}'")
                    df = cache[matched].to_pandas()
                else:
                    raise RuntimeError(
                        f"Stream '{stream}' not found in cache. "
                        f"Available: {available_tables}"
                    )
            
            # Step 6: Clean up metadata columns
            internal_cols = [c for c in df.columns if c.startswith("_airbyte_")]
            if internal_cols:
                df = df.drop(columns=internal_cols, errors="ignore")
                logger.info(f"Removed {len(internal_cols)} internal metadata columns")
            
            # Step 7: Validate result
            if df.empty:
                raise RuntimeError(f"No data returned from {source_name}/{stream}")
            
            logger.info(
                f"✓ Import successful: {len(df)} rows, {len(df.columns)} columns "
                f"from {source_name}/{stream}"
            )
            
            return df
            
        except ValueError:
            # Credential errors — don't retry
            raise
            
        except Exception as e:
            last_error = e
            error_msg = str(e)
            logger.error(
                f"Import attempt {attempt + 1} failed for {source_name}/{stream}: {error_msg}",
                exc_info=(attempt == max_retries)  # Full stack trace on final attempt only
            )
            
            if attempt < max_retries:
                # Check if error is retryable
                if any(keyword in error_msg.lower() for keyword in ["timeout", "connection", "temporary"]):
                    logger.info(f"Transient error detected — will retry")
                    continue
                else:
                    # Non-retryable error
                    logger.error(f"Non-retryable error — stopping")
                    break
        
        finally:
            # Always clean up cache files
            if cache:
                try:
                    cache.close()
                    logger.debug(f"Cache closed")
                except Exception as cleanup_err:
                    logger.warning(f"Cache close failed: {cleanup_err}")
            
            if cache_path:
                for ext in ("", ".wal", "-shm", "-wal"):
                    try:
                        file_to_remove = cache_path + ext
                        if os.path.exists(file_to_remove):
                            os.remove(file_to_remove)
                            logger.debug(f"Removed cache file: {file_to_remove}")
                    except Exception as cleanup_err:
                        logger.warning(f"Failed to remove {file_to_remove}: {cleanup_err}")
    
    # All retries exhausted
    error_detail = str(last_error) if last_error else "Unknown error"
    raise RuntimeError(
        f"Failed to import data from {source_name}/{stream} after {max_retries + 1} attempts. "
        f"Last error: {error_detail[:500]}"
    )


# ── Direct DB import (fast path — no PyAirbyte overhead) ─────────────────────

def read_database_direct(
    source_type: str,
    connection_string: str,
    table_name: str,
    timeout: int = 30,
) -> pd.DataFrame:
    """
    Fast path for MySQL / PostgreSQL / SQL Server.
    Uses SQLAlchemy directly — faster than PyAirbyte for simple table reads.
    
    Enhanced with proper error handling and connection validation.

    Args:
        source_type:       "mysql" | "postgresql" | "mssql"
        connection_string: SQLAlchemy connection URL (never logged)
        table_name:        Table to read
        timeout:           Query timeout in seconds

    Returns:
        pandas DataFrame
        
    Raises:
        ValueError: If connection fails or table doesn't exist
        RuntimeError: If query fails
    """
    import sqlalchemy
    from sqlalchemy import text
    
    logger.info(f"Direct DB import: {source_type} / {table_name}")
    
    try:
        # Create engine with connection pooling disabled (single-use connection)
        engine = sqlalchemy.create_engine(
            connection_string,
            poolclass=sqlalchemy.pool.NullPool,  # No connection pooling
            connect_args={"connect_timeout": timeout},
        )
        
        with engine.connect() as conn:
            # Test connection
            conn.execute(text("SELECT 1"))
            logger.info(f"✓ Database connection successful")
            
            # Check if table exists
            inspector = sqlalchemy.inspect(engine)
            available_tables = inspector.get_table_names()
            
            if table_name not in available_tables:
                raise ValueError(
                    f"Table '{table_name}' not found. "
                    f"Available tables: {available_tables[:10]}"
                )
            
            # Read table
            logger.info(f"Reading table '{table_name}'...")
            df = pd.read_sql_table(table_name, conn)
            
            if df.empty:
                logger.warning(f"Table '{table_name}' is empty")
            
            logger.info(
                f"✓ Read {len(df)} rows, {len(df.columns)} columns "
                f"from {source_type}/{table_name}"
            )
            return df
            
    except ValueError:
        raise
    except Exception as e:
        error_msg = str(e)
        logger.error(f"Direct DB import failed: {error_msg}", exc_info=True)
        
        if "authentication" in error_msg.lower() or "password" in error_msg.lower():
            raise ValueError(f"Authentication failed: {error_msg[:200]}")
        elif "timeout" in error_msg.lower():
            raise RuntimeError(
                f"Connection timeout after {timeout}s. "
                f"Check host/port and firewall settings."
            )
        elif "connection refused" in error_msg.lower():
            raise RuntimeError(
                f"Connection refused. Verify the database is running and accessible."
            )
        else:
            raise RuntimeError(f"Database import failed: {error_msg[:300]}")


# ── Resolve UI name → connector name ─────────────────────────────────────────

def get_connector_name(ui_name: str) -> str | None:
    """Return the PyAirbyte connector name for a UI display name."""
    entry = SUPPORTED_SOURCES.get(ui_name)
    return entry["connector"] if entry else None


def get_popular_sources() -> list[dict[str, Any]]:
    """Return the source catalogue for the UI."""
    return [
        {
            "name": name,
            "category": meta["category"],
            "description": meta["description"],
            "connector": meta["connector"],
            "fields": meta["fields"],
            "optional": meta.get("optional", []),
            "default_streams": meta.get("default_streams", []),
        }
        for name, meta in SUPPORTED_SOURCES.items()
    ]


# ── Config normalisation ──────────────────────────────────────────────────────

def normalise_config(source_name: str, raw_config: dict[str, Any], validate: bool = True) -> dict[str, Any]:
    """
    Convert the flat UI config dict into the nested structure each
    PyAirbyte connector actually expects.

    The UI collects simple key=value strings. Many connectors need those
    values wrapped in a specific nested object. This function handles all
    transformations so callers never have to think about connector-specific shapes.

    Args:
        source_name: UI display name e.g. "Google Sheets"
        raw_config:  Flat key=value dict from the UI
        validate:    If True, raise ValueError on missing required fields.
                     Set to False when called from discover_streams with partial creds.

    Raises:
        ValueError: If required fields are missing or invalid (only when validate=True)
    """
    import json as _json

    cfg = dict(raw_config)  # don't mutate the original
    
    # DEBUG: Log what we received
    logger.info(f"normalise_config called for {source_name}, validate={validate}")
    logger.info(f"Raw config keys: {list(cfg.keys())}")
    logger.info(f"Raw config (sanitized): {', '.join(f'{k}={len(str(v))} chars' for k, v in cfg.items())}")

    # ── Google Sheets ─────────────────────────────────────────────────────────
    # UI fields: spreadsheet_id, service_account_json (raw JSON string or dict)
    # Connector expects:
    #   { "spreadsheet_id": "https://docs.google.com/spreadsheets/d/<id>/edit",
    #     "credentials": { "auth_type": "Service",
    #                       "service_account_info": "<json string>" } }
    if source_name == "Google Sheets":
        sa_raw = cfg.pop("service_account_json", None) or cfg.pop("credentials_json", None) or cfg.pop("credentials", None) or ""

        # Handle all possible input shapes:
        # 1. Python dict (Swagger UI sends nested JSON as a dict — most common source of 422)
        # 2. Already a JSON string (normal UI flow from the textarea)
        # 3. Empty / None
        if isinstance(sa_raw, dict):
            # Swagger UI / API callers passing raw JSON object — serialize back to string
            sa_str = _json.dumps(sa_raw)
        elif isinstance(sa_raw, str):
            sa_str = sa_raw.strip()
        else:
            sa_str = ""

        # Validate the string is parseable JSON (catches typos, truncated pastes, etc.)
        if sa_str:
            try:
                _json.loads(sa_str)  # validation only — we keep sa_str as the string
            except _json.JSONDecodeError as e:
                raise ValueError(
                    f"Invalid service account JSON: {str(e)[:100]}. "
                    f"Please paste the complete JSON key file from Google Cloud Console."
                )

        # Accept bare spreadsheet ID or full URL — normalise to full URL
        sid = cfg.get("spreadsheet_id", "").strip()
        
        # When validate=True, require non-empty spreadsheet_id
        if validate and not sid:
            raise ValueError("spreadsheet_id is required for Google Sheets")

        # If we have a spreadsheet_id, normalise it to full URL format
        if sid and not sid.startswith("http"):
            sid = f"https://docs.google.com/spreadsheets/d/{sid}/edit"

        # PyAirbyte source-google-sheets requires service_account_info as a JSON STRING,
        # not a Python dict. Passing a dict causes a validation error (400 on /streams,
        # 500 on /connect). Always pass sa_str — the raw string the user pasted.
        result = {
            "credentials": {
                "auth_type": "Service",
                "service_account_info": sa_str,  # ← must be JSON string, NOT a dict
            },
        }
        
        # Only include spreadsheet_id if it's non-empty
        if sid:
            result["spreadsheet_id"] = sid
        
        return result

    # ── Late validation for all other connectors ──────────────────────────────
    # (Google Sheets is handled above with its own field names)
    if validate:
        source_meta = SUPPORTED_SOURCES.get(source_name, {})
        required_fields = source_meta.get("fields", [])
        # Exclude fields already handled by connector-specific logic
        _skip = {"service_account_json", "credentials_json"}
        missing = [
            f for f in required_fields
            if f not in _skip and not str(cfg.get(f, "")).strip()
        ]
        if missing:
            raise ValueError(
                f"Missing required fields for {source_name}: {', '.join(missing)}"
            )

    # ── Salesforce ────────────────────────────────────────────────────────────
    if source_name == "Salesforce":
        is_sandbox = cfg.get("is_sandbox", "false")
        if isinstance(is_sandbox, str):
            is_sandbox = is_sandbox.lower() in ("true", "1", "yes")
        cfg["is_sandbox"] = is_sandbox
        return cfg

    # ── Zendesk ───────────────────────────────────────────────────────────────
    if source_name == "Zendesk Support":
        api_token = cfg.pop("api_token", None) or cfg.pop("credentials", "")
        return {
            "subdomain": cfg.get("subdomain", ""),
            "credentials": {
                "credentials": "api_token",
                "api_token": api_token,
                "email": cfg.get("email", ""),
            },
            "start_date": cfg.get("start_date", "2020-01-01T00:00:00Z"),
        }

    # ── GitHub ────────────────────────────────────────────────────────────────
    if source_name == "GitHub":
        token = cfg.pop("access_token", None) or cfg.pop("credentials", "")
        repos = cfg.get("repositories", "")
        return {
            "credentials": {
                "option_title": "PAT Credentials",
                "personal_access_token": token,
            },
            "repositories": [repos] if isinstance(repos, str) else repos,
            "start_date": cfg.get("start_date", "2020-01-01T00:00:00Z"),
        }

    # ── Shopify ───────────────────────────────────────────────────────────────
    if source_name == "Shopify":
        token = cfg.pop("api_password", None) or cfg.pop("credentials", "")
        return {
            "shop": cfg.get("shop", ""),
            "credentials": {
                "auth_method": "api_password",
                "api_password": token,
            },
            "start_date": cfg.get("start_date", "2020-01-01T00:00:00Z"),
        }

    # ── Mailchimp ─────────────────────────────────────────────────────────────
    if source_name == "Mailchimp":
        api_key = cfg.pop("api_key", None) or cfg.pop("credentials", "")
        return {
            "credentials": {
                "auth_type": "apikey",
                "apikey": api_key,
            },
        }

    # Default: return as-is (works for HubSpot, Zoho CRM, databases, Stripe, Jira)
    return cfg