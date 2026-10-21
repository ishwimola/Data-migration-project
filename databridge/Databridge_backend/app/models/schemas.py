"""
Pydantic models — data contracts for EPIC-04 and EPIC-05 endpoints.
"""

from pydantic import BaseModel, Field
from typing import Optional


# ── Shared ────────────────────────────────────────────────────────────────────

class ErrorRecord(BaseModel):
    row_number:     int
    source_column:  str
    rule_type:      str
    error_message:  str
    original_value: Optional[str] = None


# ── EPIC-04: Validation ───────────────────────────────────────────────────────

class ValidationResponse(BaseModel):
    """Response from POST /projects/{id}/validate"""
    valid_count:     int
    invalid_count:   int
    total_count:     int
    pass_rate:       float = Field(..., description="% of valid records (0-100)")
    errors:          list[ErrorRecord]
    error_breakdown: dict[str, int]
    column_status:   list[dict] = Field(
        default=[],
        description="Per-column transformation status (Point 7)"
    )


class ValidationResultsResponse(BaseModel):
    """Response from GET /projects/{id}/validation/results"""
    errors: list[ErrorRecord]


# ── EPIC-05: Cleansing ────────────────────────────────────────────────────────

class CleansePreviewRequest(BaseModel):
    """Input for POST /projects/{id}/cleanse/preview"""
    instruction:         str  = Field(..., example="Convert all email addresses to lowercase")
    table_name:          str  = Field("raw_data", example="raw_data")
    transformation_type: Optional[str] = Field(
        None,
        description="Optional hint: standardization | formatting | type_conversion | deduplication | null_handling | custom"
    )


class CleansePreviewResponse(BaseModel):
    """Response from preview — NO data is changed"""
    instruction:          str
    transformation_type:  str   = Field(..., description="Detected transformation type (Point 2)")
    generated_sql:        str
    affected_rows:        int
    sample_before:        list[dict]
    sample_after:         list[dict] = Field(default=[], description="Simulated output (Point 4)")
    diff:                 list[dict] = Field(default=[], description="Column-level before/after diff (Point 4)")
    status:               str
    error:                Optional[str] = None


class CleanseExecuteRequest(BaseModel):
    """Input for POST /projects/{id}/cleanse/execute"""
    instruction:   str
    sql:           str
    table_name:    str
    affected_rows: int


class CleanseExecuteResponse(BaseModel):
    """Response from execute"""
    status:        str
    rows_affected: int
    error:         Optional[str] = None


class PlaybookStep(BaseModel):
    id:               str
    step_number:      int
    instruction_text: str
    generated_sql:    str
    affected_rows:    Optional[int] = None
    executed_at:      Optional[str] = None
    is_active:        bool = True


class PlaybookResponse(BaseModel):
    """Response from GET /projects/{id}/cleanse/playbook"""
    steps: list[PlaybookStep]


class ReplayResponse(BaseModel):
    """Response from POST /projects/{id}/cleanse/replay"""
    steps_executed: int
    steps_failed:   int
    failed_details: list[dict]
    status:         str


# ── EPIC-06: Migration ────────────────────────────────────────────────────────

class PreflightChecks(BaseModel):
    mappings_approved:    bool
    d365_configured:      bool
    records_available:    bool
    validation_completed: bool
    cleansing_complete:   bool


class PreflightResponse(BaseModel):
    """Response from GET /projects/{id}/migration/preflight"""
    checks:            PreflightChecks
    total_records:     int
    approved_mappings: int
    simulation_mode:   bool
    ready_to_migrate:  bool
    d365_url:          str


class MigrateRequest(BaseModel):
    """Input for POST /projects/{id}/migrate"""
    table_name: str = "raw_data"


class MigrateResponse(BaseModel):
    """Response from POST /projects/{id}/migrate"""
    total_attempted: int
    total_success:   int
    total_failed:    int
    success_rate:    float
    simulation_mode: bool = False
    error:           Optional[str] = None


# ── EPIC-07: Reporting ────────────────────────────────────────────────────────

class AuditEntry(BaseModel):
    action:    str
    action_at: Optional[str] = None
    details:   Optional[dict] = None
    status:    Optional[str] = None


class AuditLogResponse(BaseModel):
    """Response from GET /projects/{id}/audit"""
    audit_log: list[AuditEntry]
    total:     int
    summary:   dict

# ── AI Agent Schemas ──────────────────────────────────────────────────────────

from typing import Optional, List, Dict, Any

class AgentQuestionRequest(BaseModel):
    question: str
    conversation_history: Optional[List[Dict[str, str]]] = []

class SuggestedFix(BaseModel):
    row_number: int
    column: str
    new_value: str

class AgentAnswerResponse(BaseModel):
    answer: str
    suggested_fix: Optional[SuggestedFix] = None
    requires_confirmation: bool = False          # ← add this
    fix_parse_error: Optional[str] = None        # ← add this

class ApplyFixRequest(BaseModel):
    row_number: int
    column: str
    new_value: str

class ApplyFixResponse(BaseModel):
    success: bool
    message: str

class ExplainErrorRequest(BaseModel):
    rule_type: str
    source_column: str
    error_message: str
    original_value: Optional[str] = ""

class ExplainErrorResponse(BaseModel):
    explanation: str