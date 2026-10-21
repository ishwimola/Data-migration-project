"""
Central configuration — all settings loaded from .env file.
To swap credentials: edit .env only. No code changes needed.
"""

from dotenv import load_dotenv
import os

load_dotenv()

# ── Database ──────────────────────────────────────────────────────────────────
DATABASE_URL: str = os.getenv("DATABASE_URL", "")

# ── DuckDB / file storage ─────────────────────────────────────────────────────
DUCKDB_PROJECTS_DIR: str = os.getenv("DUCKDB_PROJECTS_DIR", "./projects")
UPLOADS_DIR: str = os.getenv("UPLOADS_DIR", "./uploads")

# ── Stubs (for standalone testing without the ingestion module) ───────────────
USE_STUBS: bool = os.getenv("USE_STUBS", "true").lower() == "true"
STUB_DUCKDB_PATH: str = os.getenv("STUB_DUCKDB_PATH", "./test_data/sample.duckdb")

# ── AI layer ──────────────────────────────────────────────────────────────────
# AI_MODE options:
#   groq   — team-shared Groq API (fast, free tier) — DEFAULT
#   ollama — local Ollama fallback (requires llama3.1 pulled)
#   azure  — Azure OpenAI GPT-4o-mini (production)
AI_MODE: str = os.getenv("AI_MODE", "groq")

# Groq API (shared team key for NL-to-SQL generation)
GROQ_API_KEY: str = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL: str   = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")

# Ollama (local fallback)
OLLAMA_BASE_URL: str = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL: str    = os.getenv("OLLAMA_MODEL", "llama3.1")

# Azure OpenAI (production)
AZURE_OPENAI_ENDPOINT: str   = os.getenv("AZURE_OPENAI_ENDPOINT", "")
AZURE_OPENAI_API_KEY: str    = os.getenv("AZURE_OPENAI_API_KEY", "")
AZURE_OPENAI_DEPLOYMENT: str = os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4o-mini")
AZURE_OPENAI_API_VERSION: str = os.getenv("AZURE_OPENAI_API_VERSION", "2024-02-01")

# ── Dataverse / D365 ──────────────────────────────────────────────────────────
DATAVERSE_URL: str = os.getenv("DATAVERSE_URL", "")
DATAVERSE_METADATA_URL: str = os.getenv("DATAVERSE_METADATA_URL", "")
DATAVERSE_API_VERSION: str = os.getenv("DATAVERSE_API_VERSION", "v9.2")
AZURE_CLIENT_ID: str = os.getenv("AZURE_CLIENT_ID", "")
AZURE_CLIENT_SECRET: str = os.getenv("AZURE_CLIENT_SECRET", "")
AZURE_TENANT_ID: str = os.getenv("AZURE_TENANT_ID", "")
D365_USERNAME: str = os.getenv("D365_USERNAME", "")
D365_PASSWORD: str = os.getenv("D365_PASSWORD", "")
TARGET_ENTITY: str = os.getenv("TARGET_ENTITY", "account")

# ── App behaviour ─────────────────────────────────────────────────────────────
CONFIDENCE_THRESHOLD: float = float(os.getenv("CONFIDENCE_THRESHOLD", "0.85"))
BATCH_SIZE: int = int(os.getenv("BATCH_SIZE", "500"))
MAX_FILE_SIZE_MB: int = int(os.getenv("MAX_FILE_SIZE_MB", "30"))
DEBUG: bool = os.getenv("DEBUG", "true").lower() == "true"


def is_dataverse_configured() -> bool:
    """Returns True if all required D365 credentials are present."""
    return all([DATAVERSE_URL, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID])
