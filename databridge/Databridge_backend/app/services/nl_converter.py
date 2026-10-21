from groq import Groq

from app.config.settings import (
    AI_MODE,
    GROQ_API_KEY,
    GROQ_MODEL,
    OLLAMA_MODEL,
    AZURE_OPENAI_ENDPOINT,
    AZURE_OPENAI_API_KEY,
    AZURE_OPENAI_DEPLOYMENT,
    AZURE_OPENAI_API_VERSION,
)

# TASK-015: Module-level Groq singleton — not re-created on every call
_groq_client: Groq | None = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None


# =====================================================
# AI CALL
# =====================================================

def _call_ai(prompt: str) -> str:

    # -------------------------------------------------
    # GROQ
    # -------------------------------------------------

    if AI_MODE == "groq" and _groq_client:

        response = _groq_client.chat.completions.create(

            model=GROQ_MODEL,

            messages=[
                {
                    "role": "user",
                    "content": prompt
                }
            ],

            temperature=0,
        )

        return response.choices[0].message.content.strip()

    # -------------------------------------------------
    # AZURE OPENAI
    # -------------------------------------------------

    elif AI_MODE == "azure":

        from openai import AzureOpenAI

        client = AzureOpenAI(

            azure_endpoint=AZURE_OPENAI_ENDPOINT,

            api_key=AZURE_OPENAI_API_KEY,

            api_version=AZURE_OPENAI_API_VERSION,
        )

        response = client.chat.completions.create(

            model=AZURE_OPENAI_DEPLOYMENT,

            messages=[
                {
                    "role": "user",
                    "content": prompt
                }
            ],

            temperature=0,
        )

        return response.choices[0].message.content.strip()

    # -------------------------------------------------
    # OLLAMA
    # -------------------------------------------------

    else:

        import ollama

        response = ollama.chat(

            model=OLLAMA_MODEL,

            messages=[
                {
                    "role": "user",
                    "content": prompt
                }
            ],
        )

        return response["message"]["content"].strip()


# =====================================================
# NL → SQL
# =====================================================

def generate_cleansing_sql(
    instruction: str,
    table_name: str,
    columns: list
) -> str:

    prompt = f'''
Convert this plain English cleansing instruction to a DuckDB SQL statement.

Table: {table_name}
Available Columns: {", ".join(columns)}

Instruction: {instruction}

CRITICAL Rules:
1. Return ONLY SQL - no markdown, no explanation
2. Use EXACT column names from the Available Columns list above
3. Column names with spaces MUST be quoted: "First Name", "Last Name"
4. Use exact table name: {table_name}
5. Use DuckDB-compatible SQL syntax
6. Prefer UPDATE statements over DELETE
7. Use LOWER(), UPPER(), TRIM(), INITCAP() for text operations
8. For dates use CURRENT_DATE and INTERVAL syntax
9. If a column doesn't exist in Available Columns, DO NOT use it

Example:
Instruction: "Update status to inactive where subscription date is old"
Available Columns: Status, "Subscription Date"
SQL: UPDATE {table_name} SET Status = 'Inactive' WHERE "Subscription Date" < CURRENT_DATE - INTERVAL '1 year';
'''

    raw = _call_ai(prompt)

    # Strip markdown code fences if model adds them
    if "```" in raw:
        lines = raw.split("\n")
        raw = "\n".join(
            l for l in lines
            if not l.strip().startswith("```")
        ).strip()

    # Take only the first SQL statement if model returns multiple
    # Split on semicolons and take the first non-empty statement
    statements = [s.strip() for s in raw.split(";") if s.strip()]
    if statements:
        raw = statements[0] + ";"

    return raw.strip()