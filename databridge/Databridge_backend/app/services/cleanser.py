"""
Data Cleansing Engine — Transformation & Data Service

Implements:
  - Transformation type detection (Point 2)
  - Before → After preview (Point 4)
  - NL → SQL via Ollama
  - Dry run with affected row count
  - Execute + playbook save
  - Replay all steps

Transformation types supported:
  standardization  — LOWER/UPPER/INITCAP/TRIM
  formatting       — phone/date/currency format normalisation
  type_conversion  — cast text to numeric/date
  deduplication    — remove duplicate rows
  null_handling    — fill or remove nulls
  custom           — any other SQL instruction
"""

import re

from app.services.duckdb_service import get_conn
from app.services.nl_converter import generate_cleansing_sql

# ── Transformation type detection ─────────────────────────────────────────────
# Point 2: Classify what kind of transformation the instruction represents

_TYPE_PATTERNS = [
    ("standardization", [
        r"\b(lower|upper|trim|initcap|capitaliz|normaliz|standardiz)\b",
        r"\b(lowercase|uppercase|title case)\b",
    ]),
    ("formatting", [
        r"\b(format|phone|date|currency|symbol|strip|remove)\b",
        r"\b(dd/mm|yyyy-mm|iso|e\.164)\b",
    ]),
    ("type_conversion", [
        r"\b(convert|cast|parse|integer|numeric|float|decimal|boolean)\b",
        r"\b(to number|to date|to int)\b",
    ]),
    ("deduplication", [
        r"\b(duplicate|dedup|unique|distinct|remove duplicate)\b",
    ]),
    ("null_handling", [
        r"\b(null|empty|blank|missing|fill|replace null|coalesce|default)\b",
    ]),
]


def detect_transformation_type(instruction: str) -> str:
    """
    Classify the instruction into one of the defined transformation types.
    Returns 'custom' if no pattern matches.
    """
    text = instruction.lower()
    for t_type, patterns in _TYPE_PATTERNS:
        for pattern in patterns:
            if re.search(pattern, text):
                return t_type
    return "custom"


# ── Sample after helper ────────────────────────────────────────────────────────
# Point 4: Show Before → After for the sample rows

def _compute_sample_after(
    project_id: str,
    sql: str,
    table_name: str,
    sample_before: list[dict],
) -> list[dict]:
    """
    Execute the SQL on a temporary in-memory copy of the sample rows
    and return the transformed values.
    Returns empty list if simulation fails (non-destructive).
    """
    if not sample_before or not sql.upper().strip().startswith("UPDATE"):
        return []

    # TASK-003: Validate table_name before interpolation into SQL
    if not re.match(r'^[a-zA-Z0-9_]+$', table_name):
        return []

    try:
        import duckdb
        import pandas as pd

        # Build an in-memory DuckDB with just the sample rows
        mem_conn = duckdb.connect(":memory:")
        sample_df = pd.DataFrame(sample_before)

        # DuckDB can't handle column names with spaces directly — quote them
        mem_conn.execute(f"CREATE TABLE {table_name} AS SELECT * FROM sample_df")

        # Run the SQL on the in-memory copy
        mem_conn.execute(sql)
        after_df = mem_conn.execute(f"SELECT * FROM {table_name}").fetchdf()
        mem_conn.close()

        return after_df.to_dict("records")
    except Exception:
        return []


def _build_diff(before: list[dict], after: list[dict]) -> list[dict]:
    """
    Compare before and after rows, highlight changed columns.
    Returns a list of diffs: [{column, before_value, after_value, changed}]
    """
    if not before or not after or len(before) != len(after):
        return []

    diffs = []
    for b_row, a_row in zip(before[:5], after[:5]):
        row_diff = {}
        for col in b_row:
            b_val = str(b_row.get(col, ""))
            a_val = str(a_row.get(col, ""))
            row_diff[col] = {
                "before":  b_val,
                "after":   a_val,
                "changed": b_val != a_val,
            }
        diffs.append(row_diff)
    return diffs


# ── Main preview function ──────────────────────────────────────────────────────

def preview_cleansing(project_id: str, instruction: str, table_name: str) -> dict:
    """
    Generate SQL from instruction and show full preview including:
    - transformation_type  (Point 2)
    - sample_before        (Point 4 — before)
    - sample_after         (Point 4 — after, simulated)
    - diff                 (Point 4 — column-level before/after comparison)
    - affected_rows        (dry run count)
    - generated_sql

    Does NOT modify any data.
    """
    # TASK-003: Validate table_name against an allowlist before use in raw SQL
    if not re.match(r'^[a-zA-Z0-9_]+$', table_name):
        return {"error": f"Invalid table name '{table_name}'. Only letters, digits and underscores are allowed."}

    conn = get_conn(project_id, read_only=True)
    try:
        schema = conn.execute(f"DESCRIBE {table_name}").fetchdf()
        sample = conn.execute(f"SELECT * FROM {table_name} LIMIT 5").fetchdf()
    except Exception as e:
        conn.close()
        return {"error": f"Table '{table_name}' not found: {str(e)}"}
    conn.close()

    columns = [c for c in schema["column_name"].tolist() if c != "_row_number"]
    sql     = generate_cleansing_sql(instruction, table_name, columns)

    # Detect transformation type (Point 2)
    transformation_type = detect_transformation_type(instruction)

    # Dry run — count affected rows without modifying data
    affected_rows = 0
    try:
        sql_upper = sql.upper().strip()

        if sql_upper.startswith("UPDATE") or sql_upper.startswith("DELETE"):
            # Extract WHERE clause to count affected rows
            where_idx = sql_upper.find("WHERE")
            if where_idx > 0:
                where_clause = sql[where_idx:]
                count_sql = f"SELECT COUNT(*) FROM {table_name} {where_clause}"
            else:
                count_sql = f"SELECT COUNT(*) FROM {table_name}"

            # Use read_only connection just for counting
            count_conn = get_conn(project_id, read_only=True)
            try:
                result = count_conn.execute(count_sql).fetchone()
                affected_rows = result[0] if result else 0
            except Exception:
                # If count fails (e.g. complex SQL), estimate all rows
                affected_rows = count_conn.execute(
                    f"SELECT COUNT(*) FROM {table_name}"
                ).fetchone()[0]
            finally:
                count_conn.close()

    except Exception as e:
        # Don't fail the whole preview just because count failed
        affected_rows = 0

    # Compute sample_after (Point 4)
    sample_before = sample.head(5).to_dict("records")
    sample_after  = _compute_sample_after(project_id, sql, table_name, sample_before)
    diff          = _build_diff(sample_before, sample_after)

    return {
        "instruction":        instruction,
        "transformation_type": transformation_type,   # Point 2
        "generated_sql":      sql,
        "affected_rows":      affected_rows,
        "sample_before":      sample_before,           # Point 4 — before
        "sample_after":       sample_after,            # Point 4 — after
        "diff":               diff,                    # Point 4 — column diff
        "status":             "preview_ready",
    }


# ── Execute ────────────────────────────────────────────────────────────────────

def execute_cleansing(project_id: str, sql: str, table_name: str) -> dict:
    """Execute a confirmed cleansing SQL statement on DuckDB."""
    conn = get_conn(project_id)
    try:
        conn.execute(sql)
        conn.close()
        return {"status": "executed"}
    except Exception as e:
        conn.close()
        return {"status": "failed", "error": str(e)}


# ── Replay ─────────────────────────────────────────────────────────────────────

def replay_playbook(project_id: str, steps: list) -> dict:
    """Re-apply all playbook steps in order on the current data."""
    conn     = get_conn(project_id)
    executed = 0
    failed   = []

    for step in steps:
        try:
            conn.execute(step["generated_sql"])
            executed += 1
        except Exception as e:
            failed.append({
                "step":        step["step_number"],
                "instruction": step["instruction_text"],
                "error":       str(e),
            })

    conn.close()
    return {
        "steps_executed": executed,
        "steps_failed":   len(failed),
        "failed_details": failed,
        "status":         "completed",
    }
