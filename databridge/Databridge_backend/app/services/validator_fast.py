"""
Fast Validation Engine — single-pass DuckDB SQL.

All rules are collected into one UNION ALL query per table scan,
so the data is read once regardless of how many columns/rules exist.
Row numbers are derived from rowid (stable, 0-based → +1 for display).
"""

import json
import os
import logging
from functools import lru_cache
from typing import List, Dict

from app.services.duckdb_service import get_conn

logger = logging.getLogger(__name__)

MAX_ERRORS_TOTAL = 5000


# ── Field definitions (cached) ────────────────────────────────────────────────

@lru_cache(maxsize=1)
def _load_field_definitions() -> dict:
    path = os.path.join(os.path.dirname(__file__), "..", "config", "d365_fields.json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    raise FileNotFoundError("d365_fields.json not found.")


@lru_cache(maxsize=10)
def get_d365_field_map(entity: str) -> dict:
    data = _load_field_definitions()
    entity_data = data.get("entities", {}).get(entity.lower(), {})
    fields = entity_data.get("fields", [])
    return {
        f["logical_name"]: f
        for f in fields
        if f.get("mappable", False)
    }


def _infer_entity(approved_mappings: List[dict]) -> str:
    try:
        data     = _load_field_definitions()
        entities = data.get("entities", {})
        mapped   = {m.get("d365_field", "") for m in approved_mappings}
        best, best_n = "account", 0
        for ename, edata in entities.items():
            overlap = len(mapped & {f["logical_name"] for f in edata.get("fields", [])})
            if overlap > best_n:
                best_n, best = overlap, ename
        return best
    except Exception:
        return "account"


def _q(col: str) -> str:
    """Double-quote a column name for DuckDB SQL."""
    return '"' + col.replace('"', '""') + '"'


# ── Main validation function ──────────────────────────────────────────────────

def run_validation_rules_fast(project_id: str, approved_mappings: List[dict]) -> dict:
    """
    Single-pass validation: build one UNION ALL query covering all rules
    for all columns, execute it once, collect results.

    Row numbers use (rowid + 1) which is stable and deterministic in DuckDB.
    """
    conn = get_conn(project_id, read_only=True)

    try:
        total_count = conn.execute("SELECT COUNT(*) FROM raw_data").fetchone()[0]
        if total_count == 0:
            return _empty_result()

        # Get actual columns present in the table
        existing_cols = {
            row[0] for row in conn.execute("DESCRIBE raw_data").fetchall()
        }

        entity    = _infer_entity(approved_mappings)
        field_map = get_d365_field_map(entity)

        # ── Build rule fragments (each becomes one SELECT in the UNION) ──────
        fragments: List[str] = []

        for mapping in approved_mappings:
            d365_field = mapping.get("d365_field", "")
            src_col    = mapping.get("source_column", "")

            if not src_col or src_col not in existing_cols:
                continue

            field_def  = field_map.get(d365_field, {})
            d365_disp  = mapping.get("d365_display_name") or field_def.get("display_name") or src_col
            col        = _q(src_col)
            # Escape single quotes inside string literals
            col_esc    = src_col.replace("'", "''")
            disp_esc   = d365_disp.replace("'", "''")

            if field_def.get("read_only"):
                continue

            # ── Rule 1: Mandatory field ───────────────────────────────────────
            is_required = (
                field_def.get("required", False)
                or mapping.get("is_mandatory_target", False)
            )
            if is_required:
                fragments.append(f"""
                    SELECT
                        (rowid + 1)          AS row_number,
                        '{col_esc}'          AS source_column,
                        'mandatory_field'    AS rule_type,
                        'Required field ''{disp_esc}'' is empty' AS error_message,
                        NULL::VARCHAR        AS original_value
                    FROM raw_data
                    WHERE {col} IS NULL
                       OR TRIM(CAST({col} AS VARCHAR)) = ''
                """)

            if not field_def:
                continue

            # ── Rule 2: Max length ────────────────────────────────────────────
            max_len = field_def.get("max_length")
            if max_len:
                fragments.append(f"""
                    SELECT
                        (rowid + 1)          AS row_number,
                        '{col_esc}'          AS source_column,
                        'length_overflow'    AS rule_type,
                        '{disp_esc} exceeds max {max_len} characters' AS error_message,
                        SUBSTR(CAST({col} AS VARCHAR), 1, 100) AS original_value
                    FROM raw_data
                    WHERE {col} IS NOT NULL
                      AND TRIM(CAST({col} AS VARCHAR)) <> ''
                      AND LENGTH(CAST({col} AS VARCHAR)) > {max_len}
                """)

            # ── Rule 3: Format checks ─────────────────────────────────────────
            fmt = field_def.get("format", "")
            PATTERNS = {
                "email":     r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}",
                "phone":     r"[\+\d\s\-\(\)\.]{7,20}",
                "url":       r"https?://.+\..+",
                "date_only": r"\d{4}-\d{2}-\d{2}",
            }
            if fmt in PATTERNS:
                pat      = PATTERNS[fmt].replace("'", "''")
                fmt_esc  = fmt.replace("'", "''")
                fragments.append(f"""
                    SELECT
                        (rowid + 1)          AS row_number,
                        '{col_esc}'          AS source_column,
                        '{fmt_esc}_format'   AS rule_type,
                        'Invalid {fmt_esc} format in {disp_esc}' AS error_message,
                        CAST({col} AS VARCHAR) AS original_value
                    FROM raw_data
                    WHERE {col} IS NOT NULL
                      AND TRIM(CAST({col} AS VARCHAR)) <> ''
                      AND NOT regexp_full_match(CAST({col} AS VARCHAR), '{pat}')
                """)

            # ── Rule 4: Negative money values ─────────────────────────────────
            if field_def.get("type") == "money":
                fragments.append(f"""
                    SELECT
                        (rowid + 1)          AS row_number,
                        '{col_esc}'          AS source_column,
                        'negative_value'     AS rule_type,
                        'Field {disp_esc} cannot be negative' AS error_message,
                        CAST({col} AS VARCHAR) AS original_value
                    FROM raw_data
                    WHERE {col} IS NOT NULL
                      AND TRY_CAST(CAST({col} AS VARCHAR) AS DOUBLE) IS NOT NULL
                      AND TRY_CAST(CAST({col} AS VARCHAR) AS DOUBLE) < 0
                """)

            # ── Rule 5: Numeric type check ────────────────────────────────────
            if field_def.get("type") in ("integer", "decimal", "double"):
                fragments.append(f"""
                    SELECT
                        (rowid + 1)           AS row_number,
                        '{col_esc}'           AS source_column,
                        'invalid_number'      AS rule_type,
                        '{disp_esc} must be a numeric value' AS error_message,
                        CAST({col} AS VARCHAR) AS original_value
                    FROM raw_data
                    WHERE {col} IS NOT NULL
                      AND TRIM(CAST({col} AS VARCHAR)) <> ''
                      AND TRY_CAST(CAST({col} AS VARCHAR) AS DOUBLE) IS NULL
                """)

        # ── Rule 6: Duplicate detection (one query for key cols) ──────────────
        key_cols = [
            m["source_column"]
            for m in approved_mappings
            if m["source_column"] in existing_cols
            and any(k in m["source_column"].lower() for k in ("email", "name"))
        ]
        if key_cols:
            col_list = ", ".join(_q(c) for c in key_cols)
            key0     = _q(key_cols[0])
            key0_esc = key_cols[0].replace("'", "''")
            key_esc  = ", ".join(c.replace("'", "''") for c in key_cols)
            fragments.append(f"""
                SELECT
                    row_number,
                    '{key_esc}'          AS source_column,
                    'duplicate_record'   AS rule_type,
                    'Duplicate on {key_esc}' AS error_message,
                    CAST({key0} AS VARCHAR) AS original_value
                FROM (
                    SELECT
                        (rowid + 1) AS row_number,
                        {col_list},
                        ROW_NUMBER() OVER (
                            PARTITION BY {col_list}
                            ORDER BY rowid
                        ) AS rn
                    FROM raw_data
                    WHERE {key0} IS NOT NULL
                      AND TRIM(CAST({key0} AS VARCHAR)) <> ''
                ) t
                WHERE rn > 1
            """)

        # ── Execute single query ──────────────────────────────────────────────
        all_errors: List[dict] = []
        invalid_rows: set = set()

        if fragments:
            union_sql = "\nUNION ALL\n".join(fragments)
            full_sql  = f"""
                SELECT row_number, source_column, rule_type, error_message, original_value
                FROM ({union_sql}) all_errors
                ORDER BY row_number, source_column
                LIMIT {MAX_ERRORS_TOTAL}
            """
            try:
                rows = conn.execute(full_sql).fetchall()
                for row in rows:
                    all_errors.append({
                        "row_number":    int(row[0]),
                        "source_column": str(row[1]),
                        "rule_type":     str(row[2]),
                        "error_message": str(row[3]),
                        "original_value": str(row[4]) if row[4] is not None else None,
                    })
                    invalid_rows.add(int(row[0]))
            except Exception as e:
                logger.error(f"Validation query failed: {e}", exc_info=True)

    finally:
        conn.close()

    invalid_count = len(invalid_rows)
    valid_count   = total_count - invalid_count

    return {
        "valid_count":     valid_count,
        "invalid_count":   invalid_count,
        "total_count":     total_count,
        "pass_rate":       round(valid_count / total_count * 100, 1) if total_count else 0.0,
        "errors":          all_errors,
        "error_breakdown": _breakdown(all_errors),
        "column_status":   _column_status(total_count, approved_mappings, all_errors),
    }


# ── Helpers ───────────────────────────────────────────────────────────────────

def _empty_result() -> dict:
    return {
        "valid_count": 0, "invalid_count": 0, "total_count": 0,
        "pass_rate": 0.0, "errors": [], "error_breakdown": {}, "column_status": [],
    }


def _breakdown(errors: List[dict]) -> dict:
    result: Dict[str, int] = {}
    for e in errors:
        result[e["rule_type"]] = result.get(e["rule_type"], 0) + 1
    return result


def _column_status(total_rows: int, approved_mappings: List[dict], errors: List[dict]) -> List[dict]:
    statuses = []
    for mapping in approved_mappings:
        src        = mapping.get("source_column", "")
        col_errors = [e for e in errors if e["source_column"] == src]
        err_count  = len(col_errors)
        err_pct    = round((err_count / total_rows) * 100, 2) if total_rows else 0
        status = (
            "Success"           if err_count == 0 else
            "Partially Cleaned" if err_pct < 20   else
            "Needs Review"      if err_pct < 50   else
            "Failed"
        )
        statuses.append({
            "source_column":          src,
            "target_field":           mapping.get("d365_field", ""),
            "transformation_status":  status,
            "dedup_status":           "Unique",
            "error_count":            err_count,
            "error_pct":              err_pct,
            "selected_for_migration": status != "Failed",
        })
    return statuses
