"""
AI Validation Agent — powered by Groq (free tier)
Explains validation errors, answers user questions, suggests fixes.
"""

import os
from groq import Groq
from typing import List, Dict

# ── Load Groq client ──────────────────────────────────────────────────────────

def _get_client() -> Groq:
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise ValueError("GROQ_API_KEY not set in .env file")
    return Groq(api_key=api_key)


MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")


# ── System prompt for the agent ───────────────────────────────────────────────

SYSTEM_PROMPT = """
You are a data validation assistant for DataBridge, a data migration tool.
Your job is to help users understand and fix validation errors in their data.

You know about these validation rules:
- required: Field cannot be empty or null
- max_length: Value exceeds maximum allowed character length
- format: Value doesn't match expected format (email, phone, GUID, date, URL)
- allowed_values: Value is not in the allowed picklist options
- type: Value is not the correct data type (number, date, etc.)
- numeric_type: Value should be a number but contains text
- negative_value: Value is negative but must be positive

CRITICAL BEHAVIOUR — ALWAYS ASK WHEN VALUE IS UNKNOWN:
- For "required" errors (empty/null fields like company name, email, phone): 
  You CANNOT guess the correct value. You MUST ask the user:
  "What should the value be for [column] on row [row_number]? Please type it below and I'll apply the fix."
- For format errors (bad email, bad phone): suggest a corrected format based on the bad value.
- For type/numeric errors: suggest the cleaned numeric version if obvious (e.g. "abc123" → ask user).
- For max_length: suggest truncating to the allowed length.

When you DO know the fix, return it EXACTLY in this format on its own line:
FIX: {"row_number": <int>, "column": "<column_name>", "new_value": "<fixed_value>"}

When you DO NOT know the value (required field is blank, unknown data):
- Explain what the field is for
- Ask the user: "What value should go in row <N>, column '<column>'?"
- Do NOT emit a FIX line — wait for the user to reply with the value
- Once the user gives you the value, THEN emit the FIX line

When answering:
1. Be conversational and clear — no jargon
2. Always tell the user WHERE the fix will be saved: "This will update row X in your source data (DuckDB)"
3. Be concise — 3 sentences max unless explaining a complex error
"""


# ── Ask the agent a question ──────────────────────────────────────────────────

def ask_validation_agent(
    user_question: str,
    validation_errors: List[Dict],
    conversation_history: List[Dict] = None,
    project_id: str = None
) -> Dict:
    """
    Send a question to the AI agent with context about the validation errors.
    DuckDB is only opened when there is NO prior conversation (first message).
    Follow-up messages reuse the context already embedded in conversation_history.
    """

    client = _get_client()

    # ── Build dataset context — only on first call (no prior history) ─────────
    # Subsequent turns already carry the context inside conversation_history,
    # so we skip the DuckDB open entirely.
    is_first_message = not conversation_history or len(conversation_history) <= 1

    data_context = ""
    if project_id and is_first_message:
        try:
            from app.services.duckdb_service import get_conn
            conn = get_conn(project_id, read_only=True)
            columns    = conn.execute("PRAGMA table_info(raw_data)").fetchdf()
            col_names  = columns["name"].tolist()
            total_rows = conn.execute("SELECT COUNT(*) FROM raw_data").fetchone()[0]
            sample     = conn.execute("SELECT * FROM raw_data LIMIT 3").fetchdf()
            sample_str = sample.to_string(index=False)
            conn.close()
            data_context = (
                f"Dataset info:\n"
                f"- Total rows: {total_rows}\n"
                f"- Columns: {', '.join(col_names)}\n"
                f"- Sample rows:\n{sample_str}\n"
            )
        except Exception:
            data_context = ""

    # ── Build error context ───────────────────────────────────────────────────
    if validation_errors:
        error_summary = "\n".join([
            f"- Row {e.get('row_number', '?')}: Column '{e.get('source_column', '?')}' "
            f"failed rule '{e.get('rule_type', '?')}' "
            f"with value '{e.get('original_value', '')}'. "
            f"Message: {e.get('error_message', '')}"
            for e in validation_errors[:50]
        ])
        error_context = f"Validation errors found:\n{error_summary}"
    else:
        error_context = "Validation was run and the dataset is clean — no errors found."

    context = f"{data_context}\n{error_context}"

    # Build the messages list (supports multi-turn conversation)
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    # Add previous conversation turns if provided
    if conversation_history:
        messages.extend(conversation_history)

    # Add context + user question
    messages.append({
        "role": "user",
        "content": f"{context}\n\nUser question: {user_question}"
    })

    # Call Groq API
    response = client.chat.completions.create(
        model=MODEL,
        messages=messages,
        max_tokens=600,
        temperature=0.3,   # low temp = more factual, less creative
    )

    answer_text = response.choices[0].message.content.strip()

    # Parse out suggested fix if present
    import re
    import json

    suggested_fix = None
    fix_parse_error = None

    if "FIX:" in answer_text:
        try:
            # Find the JSON object after FIX: — handles escaped quotes and multiline
            raw = answer_text.split("FIX:", 1)[1].strip()
            # Match the outermost {...} block
            match = re.search(r"\{[^{}]+\}", raw)
            if match:
                # Replace any escaped quotes the LLM may have added
                clean = match.group().replace('\\"', '"')
                suggested_fix = json.loads(clean)
            else:
                fix_parse_error = "AI suggested a fix but JSON block not found."
        except Exception as e:
            fix_parse_error = f"Fix parse error: {e}"

    return {
        "answer": answer_text,
        "suggested_fix": suggested_fix,
        "requires_confirmation": suggested_fix is not None,
        "fix_parse_error": fix_parse_error,
    }

# ── Explain a single error ────────────────────────────────────────────────────

def explain_error(error: Dict) -> str:
    """
    Get a plain-English explanation of one specific validation error.
    Used to show inline explanations next to each error row.
    """

    client = _get_client()

    prompt = (
        f"Explain this validation error in 2 sentences for a non-technical user:\n"
        f"Column: {error.get('source_column')}\n"
        f"Rule failed: {error.get('rule_type')}\n"
        f"Bad value: {error.get('original_value')}\n"
        f"System message: {error.get('error_message')}\n\n"
        f"Also give one example of what a valid value looks like."
    )

    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt}
        ],
        max_tokens=200,
        temperature=0.2,
    )

    return response.choices[0].message.content.strip()


# ── Apply a fix to the data ───────────────────────────────────────────────────

def apply_fix_to_duckdb(project_id: str, fix: Dict) -> Dict:
    """
    Apply an AI-suggested fix to the raw_data table in DuckDB.
    Always called AFTER user reviews and approves the fix.

    Uses a CTE to find the Nth physical row (1-based row_number) reliably,
    since DuckDB's rowid is not guaranteed to align with ROW_NUMBER().
    """

    from app.services.duckdb_service import get_conn

    row_number = fix.get("row_number")
    column     = fix.get("column")
    new_value  = fix.get("new_value")

    if not all([row_number, column, new_value is not None]):
        return {"success": False, "message": "Fix is missing row_number, column, or new_value"}

    try:
        conn = get_conn(project_id, read_only=False)

        # Step 1: Find the rowid that corresponds to logical row_number
        # ROW_NUMBER() is 1-based; rowid is 0-based in DuckDB
        find_sql = f"""
            SELECT rowid
            FROM (
                SELECT rowid, ROW_NUMBER() OVER () AS rn
                FROM raw_data
            ) t
            WHERE rn = ?
            LIMIT 1
        """
        result = conn.execute(find_sql, [int(row_number)]).fetchone()

        if not result:
            conn.close()
            return {"success": False, "message": f"Row {row_number} not found in raw_data"}

        actual_rowid = result[0]

        # Step 2: Apply the fix using the physical rowid
        conn.execute(
            f'UPDATE raw_data SET "{column}" = ? WHERE rowid = ?',
            [str(new_value), actual_rowid]
        )
        conn.close()

        return {
            "success": True,
            "message": f"Row {row_number}, column '{column}' updated to '{new_value}'"
        }
    except Exception as e:
        return {"success": False, "message": str(e)}