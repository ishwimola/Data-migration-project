from fastapi import APIRouter, Depends, Response, HTTPException

from sqlalchemy.orm import Session
from sqlalchemy import text

from app.services.postgres_services import (
    get_db,
    get_approved_mappings,
    save_validation_errors,
    log_audit,
)

from app.services.validator_fast import run_validation_rules_fast

from app.services.validation_agent import (
    ask_validation_agent,
    explain_error,
    apply_fix_to_duckdb
)


from app.services.exporter import generate_error_excel

from app.models.schemas import (
    ValidationResponse,
    ValidationResultsResponse,
    ErrorRecord,
    AgentQuestionRequest,
    AgentAnswerResponse,
    ApplyFixRequest,
    ApplyFixResponse,
    ExplainErrorRequest,
    ExplainErrorResponse,
)

router = APIRouter(
    tags=["Validation"]
)


# =====================================================
# RUN VALIDATION
# =====================================================

@router.post(
    "/projects/{project_id}/validate",

    response_model=ValidationResponse,

    summary="Run all validation rules against source data",
)

def run_validation(
    project_id: str,
    db: Session = Depends(get_db)
):

    """
    Reads raw_data from DuckDB,
    applies validation rules,
    saves errors to PostgreSQL.
    """

    # -------------------------------------------------
    # Get approved mappings
    # -------------------------------------------------

    mappings = get_approved_mappings(
        db,
        project_id
    )

    # -------------------------------------------------
    # No mappings found — mapping step was not completed
    # -------------------------------------------------

    if not mappings:
        raise HTTPException(
            status_code=422,
            detail="No field mappings found for this project. "
                   "Complete the Mapping step before running validation."
        )

    # -------------------------------------------------
    # Run validation engine (use fast SQL-based validator)
    # -------------------------------------------------

    try:
        # Use SQL-based validator for better performance (10-100x faster)
        results = run_validation_rules_fast(
            project_id,
            mappings
        )
    except Exception as exc:
        err_msg = str(exc)
        # DuckDB file missing — project data was lost (e.g. server restart)
        if "does not exist" in err_msg or "Cannot open database" in err_msg:
            raise HTTPException(
                status_code=404,
                detail=(
                    "Source data not found for this project. "
                    "The uploaded file data has been lost (server restart or new session). "
                    "Please re-upload your source file to create a new project."
                ),
            )
        raise HTTPException(status_code=500, detail=f"Validation engine error: {err_msg}")

    # -------------------------------------------------
    # Save validation errors
    # -------------------------------------------------

    save_validation_errors(
        db,
        project_id,
        results["errors"]
    )

    # -------------------------------------------------
    # Save audit log
    # -------------------------------------------------

    log_audit(

        db,

        project_id,

        "validation_completed",

        {

            "valid":
                results["valid_count"],

            "invalid":
                results["invalid_count"]
        }
    )

    return results


# =====================================================
# GET VALIDATION RESULTS
# =====================================================

@router.get(
    "/projects/{project_id}/validation/results",

    response_model=ValidationResultsResponse,

    summary="Get saved validation errors",
)

def get_validation_results(
    project_id: str,
    db: Session = Depends(get_db)
):

    rows = db.execute(text("""

        SELECT

            rule_type,

            source_column,

            error_message,

            row_number,

            original_value

        FROM errors.validation_failures

        WHERE project_id = :pid

        ORDER BY row_number ASC

        LIMIT 200

    """), {

        "pid": project_id
    })

    return {

        "errors": [

            dict(r._mapping)

            for r in rows
        ]
    }


# =====================================================
# DOWNLOAD VALIDATION REPORT
# =====================================================

@router.get(
    "/projects/{project_id}/validation/download",

    summary="Download validation report",

    response_class=Response,
)

def download_error_report(
    project_id: str,
    db: Session = Depends(get_db)
):

    rows = db.execute(text("""

        SELECT

            rule_type,

            source_column,

            error_message,

            row_number,

            original_value

        FROM errors.validation_failures

        WHERE project_id = :pid

        ORDER BY row_number ASC

    """), {

        "pid": project_id
    })

    error_list = [

        dict(r._mapping)

        for r in rows
    ]

    excel_bytes = generate_error_excel(
        error_list
    )

    return Response(
        content=excel_bytes,
        media_type=
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition":
                f"attachment; filename=validation_errors_{project_id[:8]}.xlsx"
        },
    )

# =====================================================
# AI AGENT — ASK A QUESTION
# =====================================================

@router.post(
    "/projects/{project_id}/validation/ask",
    response_model=AgentAnswerResponse,
    summary="Ask the AI agent a question about validation errors",
)
def ask_agent(
    project_id: str,
    body: AgentQuestionRequest,
    db: Session = Depends(get_db)
):
    """
    User asks a question. The agent gets context from current validation errors.
    Supports multi-turn conversation via conversation_history.
    """

    # Fetch current errors for this project (context for the AI)
    rows = db.execute(text("""
        SELECT rule_type, source_column, error_message, row_number, original_value
        FROM errors.validation_failures
        WHERE project_id = :pid
        ORDER BY row_number ASC
        LIMIT 100
    """), {"pid": project_id})

    errors = [dict(r._mapping) for r in rows]

    result = ask_validation_agent(
        user_question=body.question,
        validation_errors=errors,
        conversation_history=body.conversation_history,
        project_id=project_id        # ← add this line
    )

    return result


# =====================================================
# AI AGENT — EXPLAIN ONE ERROR
# =====================================================

@router.post(
    "/projects/{project_id}/validation/explain/{row_number}",
    response_model=ExplainErrorResponse,
    summary="Get plain-English explanation of a validation error by row number",
)
def explain_single_error(
    project_id: str,
    row_number: int,
    db: Session = Depends(get_db)
):
    """
    Just pass the row number — automatically fetches the error
    details from the database and explains it in plain English.
    """

    # Fetch the error for this row from PostgreSQL
    rows = db.execute(text("""
        SELECT rule_type, source_column, error_message, original_value
        FROM errors.validation_failures
        WHERE project_id = :pid AND row_number = :row
    """), {"pid": project_id, "row": row_number}).fetchall()

    if not rows:
        raise HTTPException(
            status_code=404,
            detail=f"No validation error found for row {row_number}"
        )

    # Pass first error to explain, but include all errors in context
    error = dict(rows[0]._mapping)
    error["all_errors_on_row"] = [dict(r._mapping) for r in rows]
    explanation = explain_error(error)
    return {"explanation": explanation}
# =====================================================
# AI AGENT — APPLY AN APPROVED FIX
# =====================================================

@router.get(
    "/projects/{project_id}/validation/suggest-fix/{row_number}",
    summary="Get AI suggestion on how to fix a specific row error",
)
def suggest_fix_for_row(
    project_id: str,
    row_number: int,
    db: Session = Depends(get_db)
):
    """
    Fetches the error for this row and asks AI
    to explain HOW to fix it in plain English.
    """

    # Fetch error from PostgreSQL
    rows = db.execute(text("""
        SELECT rule_type, source_column, error_message, original_value
        FROM errors.validation_failures
        WHERE project_id = :pid AND row_number = :row
    """), {"pid": project_id, "row": row_number}).fetchall()

    if not rows:
        raise HTTPException(
            status_code=404,
            detail=f"No error found for row {row_number}"
        )

    errors = [dict(r._mapping) for r in rows]
    error = errors[0]  # primary error for the question

    result = ask_validation_agent(
        user_question=(
            f"Row {row_number} has {len(errors)} error(s). "
            f"Primary: {error['rule_type']} error in column "
            f"'{error['source_column']}' with value '{error['original_value']}'. "
            f"Tell the user exactly what to change each bad value to and why."
        ),
        validation_errors=errors,    # ← all errors, not just one
        project_id=project_id
    )

    return {
        "row_number": row_number,
        "current_value": error["original_value"],
        "column": error["source_column"],
        "error_type": error["rule_type"],
        "ai_suggestion": result["answer"],
        "suggested_fix": result["suggested_fix"]
    }
    
    # =====================================================
# AI AGENT — APPLY AN APPROVED FIX (human confirmed)
# =====================================================

@router.post(
    "/projects/{project_id}/validation/apply-fix",
    response_model=ApplyFixResponse,
    summary="Apply an AI-suggested fix AFTER human approval",
)
def apply_approved_fix(
    project_id: str,
    body: ApplyFixRequest,
    db: Session = Depends(get_db)
):
    """
    Only called after the user sees the suggested fix and clicks Confirm.
    Applies the change to DuckDB and removes the error from PostgreSQL.
    """
    result = apply_fix_to_duckdb(
        project_id=project_id,
        fix={
            "row_number": body.row_number,
            "column": body.column,
            "new_value": body.new_value,
        }
    )

    if result["success"]:
        # Remove the resolved error from the errors table
        db.execute(text("""
            DELETE FROM errors.validation_failures
            WHERE project_id = :pid
              AND row_number = :row
              AND source_column = :col
        """), {
            "pid": project_id,
            "row": body.row_number,
            "col": body.column,
        })
        db.commit()

        log_audit(db, project_id, "fix_applied", {
            "row": body.row_number,
            "column": body.column,
            "new_value": body.new_value,
        })

    return result