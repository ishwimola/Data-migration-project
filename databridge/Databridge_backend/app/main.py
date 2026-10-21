import os
import logging
from contextlib import asynccontextmanager

# Must be set before any airbyte import so the connector subprocess inherits it.
# Without this, source-google-sheets (and any connector with custom Python components)
# raises "Custom connector code is not permitted in this environment."
os.environ["AIRBYTE_ENABLE_UNSAFE_CODE"] = "true"

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from app.services.postgres_services import engine
from app.routes import upload
from dotenv import load_dotenv
from app.routes import validation
from app.routes import cleansing
from app.routes import migration
from app.routes import report
from app.routes import airbyte
from app.routes import projects
from app.middleware.error_handler import add_error_handlers

logger = logging.getLogger(__name__)


# ── Lifespan handler for startup/shutdown ────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    FastAPI lifespan handler — runs on startup and shutdown.
    Pre-installs PyAirbyte connectors to avoid first-use timeout.
    """
    # Startup
    logger.info("DataBridge backend starting...")

    try:
        with engine.connect() as conn:
            conn.execute(text("""
            CREATE TABLE IF NOT EXISTS metadata.mapping_corrections (
                id                  SERIAL PRIMARY KEY,
                source_column       VARCHAR(255) NOT NULL,
                target_entity       VARCHAR(100) NOT NULL DEFAULT 'account',
                d365_field          VARCHAR(255) NOT NULL,
                d365_display_name   VARCHAR(255) NOT NULL DEFAULT '',
                times_confirmed     INT NOT NULL DEFAULT 1,
                last_confirmed_at   TIMESTAMP NOT NULL DEFAULT NOW(),
                created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
                UNIQUE (source_column, target_entity)
                )
                """))
                
            conn.commit()
            
        logger.info("mapping_corrections table verified")

    except Exception as e:
        logger.error(f"Failed to verify mapping_corrections table: {e}")
    
    # Pre-install priority connectors (runs in background, non-blocking)
    try:
        from app.services.airbyte_service import _ensure_connectors_installed
        import threading
        
        logger.info("Starting connector pre-installation in background...")
        # Run in a separate thread so it doesn't block startup
        thread = threading.Thread(
            target=_ensure_connectors_installed,
            daemon=True,
            name="connector-preinstall",
        )
        thread.start()
        logger.info("Connector pre-installation initiated (runs in background)")
    except Exception as e:
        logger.warning(f"Connector pre-installation skipped: {e}")
        # Non-fatal — connectors will install on first use
    
    yield  # Application runs here
    
    # Shutdown
    logger.info("DataBridge backend shutting down...")


app = FastAPI(
    title="DataBridge API",
    version="1.0.0",
    lifespan=lifespan,
)

# Add error handlers
add_error_handlers(app)

# TASK-002: Explicit allowed origins — wildcard + credentials is rejected by browsers
ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:3000",
    # Production — Vercel frontend
    "https://data-bridge-delta.vercel.app",
    "https://databridge.vercel.app",
    # Allow all vercel preview deployments
    "https://*.vercel.app",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(upload.router, prefix="/api")

app.include_router(
    validation.router,
    prefix="/api"
)

app.include_router(
    cleansing.router,
    prefix="/api"
)

app.include_router(
    migration.router,
    prefix="/api"
)

app.include_router(
    report.router,
    prefix="/api"
)

app.include_router(
    airbyte.router,
    prefix="/api/airbyte",
    tags=["Airbyte Integration"]
)

app.include_router(
    projects.router,
    prefix="/api",
    tags=["Projects"]
)


@app.get("/")
def home():
    return {"message": "Backend running 🚀"}