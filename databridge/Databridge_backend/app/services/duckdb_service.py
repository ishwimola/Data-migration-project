import duckdb
import pandas as pd
from pathlib import Path

from app.config.settings import DUCKDB_PROJECTS_DIR

# Resolve the projects directory relative to this file so it always points
# to Databridge_backend/projects/ regardless of where uvicorn is launched from.
_BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent  # services -> app -> Databridge_backend
_PROJECTS_DIR = _BACKEND_ROOT / "projects"


# =====================================================
# INTERNAL HELPERS
# =====================================================

def _db_path(project_id: str) -> str:
    """
    Resolve DuckDB file path for a project.
    Always resolves to Databridge_backend/projects/project_<uuid>.duckdb
    regardless of the working directory uvicorn was launched from.
    """
    path = _PROJECTS_DIR / f"project_{project_id}.duckdb"
    path.parent.mkdir(parents=True, exist_ok=True)
    return str(path)


# =====================================================
# GET CONNECTION
# =====================================================

def get_conn(
    project_id: str,
    read_only: bool = False
) -> duckdb.DuckDBPyConnection:
    """
    Open DuckDB connection for a project.
    """

    return duckdb.connect(
        _db_path(project_id),
        read_only=read_only
    )


# =====================================================
# EXECUTE QUERY
# =====================================================

def execute_query(
    project_id: str,
    sql: str
) -> pd.DataFrame:
    """
    Execute SQL query and return dataframe.
    """

    conn = duckdb.connect(
        _db_path(project_id),
        read_only=True
    )

    try:

        df = conn.execute(sql).fetchdf()

    finally:

        conn.close()

    return df


# =====================================================
# GET SCHEMA
# =====================================================

def get_schema(
    project_id: str,
    table_name: str
) -> list:
    """
    Return table schema.
    """

    conn = duckdb.connect(
        _db_path(project_id),
        read_only=True
    )

    try:

        result = conn.execute(
            f"DESCRIBE {table_name}"
        ).fetchdf()

        conn.close()

        return result[
            ["column_name", "column_type"]
        ].to_dict("records")

    except Exception:

        conn.close()

        return []


# =====================================================
# LIST TABLES
# =====================================================

def list_tables(
    project_id: str
) -> list:
    """
    Return all table names in project DB.
    """

    conn = duckdb.connect(
        _db_path(project_id),
        read_only=True
    )

    try:

        tables = conn.execute(
            "SHOW TABLES"
        ).fetchdf()["name"].tolist()

    finally:

        conn.close()

    return tables


# =====================================================
# CHECK TABLE EXISTS
# =====================================================

def table_exists(
    project_id: str,
    table_name: str
) -> bool:
    """
    Check if table exists.
    """

    return table_name in list_tables(project_id)


# =====================================================
# ROW COUNT
# =====================================================

def row_count(
    project_id: str,
    table_name: str
) -> int:
    """
    Return table row count.
    """

    try:

        df = execute_query(
            project_id,
            f"SELECT COUNT(*) as cnt FROM {table_name}"
        )

        return int(df["cnt"].iloc[0])

    except Exception:

        return 0