export interface Project {
  id: string
  name: string
  client: string
  entity: string
  status: string
  sourceRecords: number | null
  loadedRecords: number | null
  failedRecords: number | null
  createdAt: string
  confidence: number | null
}

export interface SchemaProfile {
  column: string
  type: string
  nullPct: number
  maxLen: number
  distinct: number
  samples: string[]
  mandatory: boolean
}

export interface MappingSuggestion {
  source: string
  d365Field: string
  display: string
  confidence: number
  method: string
  status: string
  excluded: boolean
  reasoning: string
  notes?: string
}

export interface ValidationError {
  row: number
  field: string
  rule: string
  message: string
  severity: string
  value: string
}

export interface ValidationSummary {
  total: number
  valid: number
  invalid: number
  breakdown: Array<{
    rule: string
    count: number
    pct: number
  }>
}

export interface ReportData {
  totalSource: number
  loaded: number
  failed: number
  excluded: number
  successRate: number
  batches: number
  timeTaken: string
  errorsByType: Array<{
    type: string
    count: number
  }>
  confidenceDistribution: Array<{
    range: string
    count: number
  }>
}

export interface AuditEntry {
  id: string | number
  timestamp: string
  user: string
  action: string
  status: string
  details: string
}

interface BackendSchemaProfile {
  column_name: string
  data_type: string
  null_count: number
  sample_values: unknown[]
  detected_pattern: string
}

interface BackendUploadResponse {
  message: string
  project_id: string
  filename: string
  table_name: string
  columns: string[]
  rows: number
  schema_profile: BackendSchemaProfile[]
}

interface BackendMapping {
  source_column: string
  suggested_target: {
    logical_name: string
    display_name: string
  } | null
  confidence: number
  method: string
  status: string
  notes: string
  detected_pattern?: string
  excluded?: boolean
}

interface BackendProcessJobResponse {
  message: string
  project_id: string
  table_name: string
  total_rows: number
  mapping_results: {
    summary_stats: Record<string, number>
    mappings: BackendMapping[]
  }
}

interface BackendValidationResponse {
  valid_count: number
  invalid_count: number
  total_count: number
  pass_rate: number
  errors: BackendValidationError[]
  error_breakdown: Record<string, number>
}

interface BackendValidationError {
  row_number: number
  source_column: string
  rule_type: string
  error_message: string
  original_value?: string | number | null
}

interface BackendMigrationResult {
  status?: string
  total_records?: number
  loaded_records?: number
  failed_records?: number
  success_rate?: number
  started_at?: string | null
  completed_at?: string | null
  target_entity?: string
}

interface BackendMigrateResponse {
  total_attempted: number
  total_success: number
  total_failed: number
  success_rate: number
  simulation_mode: boolean
  error?: string
}

interface ActiveProjectState {
  projectId: string
  tableName: string
  filename: string
  rows: number
  columns: string[]
  schemaProfile: BackendSchemaProfile[]
  mappings?: BackendMapping[]
  projectName?: string
  clientName?: string
  entity?: string
  validation?: BackendValidationResponse
  migration?: BackendMigrateResponse | BackendMigrationResult
  auditEntries: AuditEntry[]
  createdAt: string
}

import { confidenceDistribution } from '../utils/chartHelpers'
import {
  ACTIVE_PROJECT_KEY,
  PROJECT_HISTORY_KEY,
  readProjectHistory,
  writeProjectHistory,
  upsertProjectHistory,
  updateProjectHistoryEntry,
  type StoredProject,
} from '../lib/storage'
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)

  if (!headers.has('Accept')) headers.set('Accept', 'application/json')
  if (init?.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    // FastAPI returns {"detail": "..."} for HTTPException — extract the message
    let message = text
    try {
      const json = JSON.parse(text)
      if (json.detail) message = typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail)
    } catch {
      // not JSON, use raw text
    }
    throw new Error(message || `API request failed with ${response.status}`)
  }

  if (response.status === 204) return undefined as T

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) return response.blob() as Promise<T>

  return response.json() as Promise<T>
}

function readActiveProject(): ActiveProjectState | null {
  const raw = localStorage.getItem(ACTIVE_PROJECT_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as ActiveProjectState
  } catch {
    localStorage.removeItem(ACTIVE_PROJECT_KEY)
    return null
  }
}

function writeActiveProject(next: ActiveProjectState) {
  localStorage.setItem(ACTIVE_PROJECT_KEY, JSON.stringify(next))
}

// ── Project history (localStorage fallback for when backend is unreachable) ──

function saveToProjectHistory(project: ActiveProjectState) {
  const entry: StoredProject = {
    id: project.projectId,
    name: project.projectName || project.filename || '(Unnamed)',
    client: project.clientName || 'Demo Client',
    entity: project.entity || 'Account',
    status: 'in_progress',
    sourceRecords: project.rows,
    loadedRecords: null,
    failedRecords: null,
    createdAt: project.createdAt ?? new Date().toISOString(),
    confidence: null,
  }
  upsertProjectHistory(entry)
}

function updateProjectHistoryStatus(projectId: string, updates: Partial<Project>) {
  updateProjectHistoryEntry(projectId, updates)
}

function requireActiveProject(): ActiveProjectState {
  const project = readActiveProject()
  if (!project) {
    throw new Error('No active project found. Upload a source file first.')
  }
  return project
}

function addAudit(action: string, status: AuditEntry['status'], details: string) {
  const project = readActiveProject()
  if (!project) return

  writeActiveProject({
    ...project,
    auditEntries: [
      {
        id: `${Date.now()}-${project.auditEntries.length}`,
        timestamp: new Date().toLocaleString(),
        user: 'Current User',
        action,
        status,
        details,
      },
      ...project.auditEntries,
    ],
  })
}

function normalizeStatus(status: string) {
  return status
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
}

function toUiSchema(profile: BackendSchemaProfile, totalRows: number): SchemaProfile {
  const samples = profile.sample_values.map(value => String(value))
  const nullPct = totalRows ? Math.round((profile.null_count / totalRows) * 1000) / 10 : 0
  const maxLen = samples.reduce((max, sample) => Math.max(max, sample.length), 0)

  return {
    column: profile.column_name,
    type: profile.detected_pattern || profile.data_type,
    nullPct,
    maxLen,
    distinct: samples.length,
    samples,
    mandatory: nullPct < 5,
  }
}

function toUiMapping(mapping: BackendMapping): MappingSuggestion {
  const target = mapping.suggested_target
  const rawConfidence = mapping.confidence ?? 0

  return {
    source: mapping.source_column,
    d365Field: target?.logical_name ?? 'no_match',
    display: target?.display_name ?? '',
    confidence: rawConfidence > 1 ? rawConfidence / 100 : rawConfidence,
    method: mapping.method,
    status: normalizeStatus(mapping.status),
    excluded: mapping.excluded ?? !target,
    reasoning: mapping.notes || 'No reasoning returned by backend',
    notes: mapping.notes ?? '',
  }
}

function toUiValidationError(error: BackendValidationError): ValidationError {
  return {
    row: error.row_number,
    field: error.source_column,
    rule: error.rule_type,
    message: error.error_message,
    severity: 'error',
    value: error.original_value == null ? '' : String(error.original_value),
  }
}

function toValidationSummary(result: BackendValidationResponse): ValidationSummary {
  const total = result.total_count

  return {
    total,
    valid: result.valid_count,
    invalid: result.invalid_count,
    breakdown: Object.entries(result.error_breakdown ?? {}).map(([rule, count]) => ({
      rule,
      count,
      pct: total ? Math.round((count / total) * 1000) / 10 : 0,
    })),
  }
}

// TASK-021: confidenceDistribution moved to src/utils/chartHelpers.ts
export { confidenceDistribution } from '../utils/chartHelpers'

export const api = {
  getActiveProject: readActiveProject,

  uploadFile: async (
    file: File,
    details?: { projectName?: string; clientName?: string; entity?: string },
  ) => {
    const formData = new FormData()
    formData.append('file', file)
    const entityValue = (details?.entity ?? 'account').toLowerCase()
    formData.append('entity', entityValue)
    // Send project name and client name so the backend stores them correctly
    if (details?.projectName) formData.append('project_name', details.projectName)
    if (details?.clientName)  formData.append('client_name',  details.clientName)

    const response = await request<BackendUploadResponse>('/api/upload', {
      method: 'POST',
      body: formData,
    })

    const state: ActiveProjectState = {
      projectId: response.project_id,
      tableName: response.table_name,
      filename: response.filename,
      rows: response.rows,
      columns: response.columns,
      schemaProfile: response.schema_profile,
      projectName: details?.projectName,
      clientName: details?.clientName,
      entity: details?.entity,
      auditEntries: [
        {
          id: Date.now(),
          timestamp: new Date().toLocaleString(),
          user: 'Current User',
          action: 'File uploaded',
          status: 'Success',
          details: `${response.filename} uploaded with ${response.rows} rows`,
        },
      ],
      createdAt: new Date().toISOString(),
    }

    writeActiveProject(state)
    saveToProjectHistory(state)
    return response
  },

  processJob: async () => {
    const project = requireActiveProject()
    const response = await request<BackendProcessJobResponse>('/api/process-job', {
      method: 'POST',
      body: JSON.stringify({
        project_id: project.projectId,
        table_name: project.tableName,
      }),
    })

    writeActiveProject({
      ...project,
      mappings: response.mapping_results.mappings,
      rows: response.total_rows,
    })
    addAudit('AI mapping completed', 'Success', `${response.mapping_results.mappings.length} mappings generated`)

    return response
  },

  getProjects: async (): Promise<Project[]> => {
    try {
      // Fetch from backend API — returns all projects from the database
      const response = await request<{ projects: Project[] }>('/api/projects')
      return (response.projects ?? []).map(p => ({
        ...p,
        name: p.name || '(Unnamed)',
        createdAt: p.createdAt ?? new Date().toISOString(),
      }))
    } catch (error) {
      // Fallback: read project history from localStorage
      console.warn('Failed to fetch projects from API, using localStorage fallback:', error)
      const history = readProjectHistory()
      if (history.length > 0) return history as Project[]

      // Last resort: build entry from active project
      const project = readActiveProject()
      if (!project) return []
      return [{
        id: project.projectId,
        name: project.projectName || project.filename || '(Unnamed)',
        client: project.clientName || 'Demo Client',
        entity: project.entity || 'Account',
        status: project.migration ? 'completed' : 'in_progress',
        sourceRecords: project.rows,
        loadedRecords:
          'total_success' in (project.migration ?? {})
            ? (project.migration as BackendMigrateResponse).total_success
            : (project.migration as BackendMigrationResult | undefined)?.loaded_records ?? null,
        failedRecords:
          'total_failed' in (project.migration ?? {})
            ? (project.migration as BackendMigrateResponse).total_failed
            : (project.migration as BackendMigrationResult | undefined)?.failed_records ?? null,
        createdAt: project.createdAt ?? new Date().toISOString(),
        confidence: project.mappings?.length
          ? Math.round(project.mappings.reduce((s, m) => s + m.confidence, 0) / project.mappings.length * 100)
          : null,
      }]
    }
  },

  getSchemaProfiles: async () => {
    const project = requireActiveProject()
    
    // Try to fetch from backend API first
    try {
      const response = await request<{
        schema_profile: BackendSchemaProfile[]
        total_rows: number
      }>(`/api/projects/${project.projectId}/schema`)
      
      return response.schema_profile.map(profile => toUiSchema(profile, response.total_rows))
    } catch (error) {
      // Fallback to localStorage
      console.warn('Failed to fetch schema from API, using localStorage fallback:', error)
      return project.schemaProfile.map(profile => toUiSchema(profile, project.rows))
    }
  },

  getMappings: async () => {
    const project = requireActiveProject()
    // Read from backend DB — reflects manual overrides saved in the Mapping page
    // Falls back to localStorage if the DB call fails
    try {
      interface SavedMappingsResponse {
        mappings: Array<{
          source_column: string
          d365_field: string
          d365_display_name: string
          confidence_score: number
          mapping_method: string
          is_approved: boolean
          notes: string
        }>
      }
      const saved = await request<SavedMappingsResponse>(
        `/api/projects/${project.projectId}/mappings`
      )
      // Convert DB format → BackendMapping format → UI format
      const asMappings: BackendMapping[] = saved.mappings.map(m => ({
        source_column:    m.source_column,
        suggested_target: m.d365_field && m.d365_field !== 'no_match'
          ? { logical_name: m.d365_field, display_name: m.d365_display_name }
          : null,
        confidence:    m.confidence_score,
        method:        m.mapping_method,
        status:        m.is_approved ? 'Auto Approved' : 'Needs Review',
        notes:         m.notes ?? '',
        excluded:      !m.d365_field || m.d365_field === 'no_match',
      }))
      return asMappings.map(toUiMapping)
    } catch {
      // Fallback to localStorage
      const mappings = project.mappings ?? []
      return mappings.map(toUiMapping)
    }
  },

  runValidation: async () => {
    const project = requireActiveProject()
    const result = await request<BackendValidationResponse>(`/api/projects/${project.projectId}/validate`, {
      method: 'POST',
    })

    // Re-read the active project before writing to avoid stale snapshot overwrite
    const latest = readActiveProject() ?? project
    writeActiveProject({
      ...latest,
      validation: result,
    })
    addAudit('Validation completed', 'Success', `${result.invalid_count} invalid records found`)

    return {
      summary: toValidationSummary(result),
      errors: result.errors.map(toUiValidationError),
    }
  },

  getValidationResults: async () => {
    const project = requireActiveProject()
    if (project.validation) {
      return {
        summary: toValidationSummary(project.validation),
        errors: project.validation.errors.map(toUiValidationError),
      }
    }

    return api.runValidation()
  },

  downloadValidationReport: async () => {
    const project = requireActiveProject()
    // TASK-008: Corrected URL — backend route is /validation/download not /report/validation-errors/export
    return request<Blob>(`/api/projects/${project.projectId}/validation/download`)
  },

  getTransformationTypes: () =>
    request<{ transformation_types: Array<Record<string, unknown>> }>('/api/cleanse/transformation-types'),

  previewCleanse: (instruction: string, tableName = 'raw_data') => {
    const project = requireActiveProject()
    return request<{
      instruction: string
      transformation_type: string
      generated_sql: string
      affected_rows: number
      sample_before: Record<string, unknown>[]
      sample_after: Record<string, unknown>[]
      diff: Record<string, unknown>[]
      status: string
      error?: string
    }>(`/api/projects/${project.projectId}/cleanse/preview`, {
      method: 'POST',
      body: JSON.stringify({ instruction, table_name: tableName }),
    })
  },

  executeCleanse: async (body: {
    instruction: string
    sql: string
    tableName?: string
    affectedRows: number
  }) => {
    const project = requireActiveProject()
    const result = await request<{ status: string; rows_affected: number; error?: string }>(
      `/api/projects/${project.projectId}/cleanse/execute`,
      {
        method: 'POST',
        body: JSON.stringify({
          instruction: body.instruction,
          sql: body.sql,
          table_name: body.tableName ?? 'raw_data',
          affected_rows: body.affectedRows,
        }),
      },
    )

    addAudit('Cleansing step applied', result.error ? 'Failed' : 'Success', body.instruction)
    return result
  },

  getPlaybook: async () => {
    const project = requireActiveProject()
    const response = await request<{ steps: Array<Record<string, unknown>> }>(
      `/api/projects/${project.projectId}/cleanse/playbook`,
    )
    return response.steps
  },

  replayPlaybook: () => {
    const project = requireActiveProject()
    return request<{ steps_executed: number; steps_failed: number; failed_details: unknown[]; status: string }>(
      `/api/projects/${project.projectId}/cleanse/replay`,
      { method: 'POST' },
    )
  },

  getMigrationPreflight: () => {
    const project = requireActiveProject()
    return request<{
      checks: {
        mappings_approved: boolean
        d365_configured: boolean
        records_available: boolean
        validation_completed: boolean
        cleansing_complete: boolean
      }
      total_records: number
      approved_mappings: number
      simulation_mode: boolean
      ready_to_migrate: boolean
      d365_url: string
    }>(`/api/projects/${project.projectId}/migration/preflight`)
  },

  startMigration: async (tableName = 'raw_data') => {
    const project = requireActiveProject()
    const result = await request<BackendMigrateResponse>(`/api/projects/${project.projectId}/migrate`, {
      method: 'POST',
      body: JSON.stringify({ table_name: tableName }),
    })

    writeActiveProject({ ...project, migration: result })
    addAudit('Migration completed', result.error ? 'Failed' : 'Success', `${result.total_success} records loaded`)
    updateProjectHistoryStatus(project.projectId, {
      status: result.error ? 'failed' : 'completed',
      loadedRecords: result.total_success,
      failedRecords: result.total_failed,
      confidence: result.success_rate ? Math.round(result.success_rate) : null,
    })
    return result
  },

  getMigrationResults: async () => {
    const project = requireActiveProject()
    const result = await request<BackendMigrationResult>(`/api/projects/${project.projectId}/migration/results`)

    if (result.status !== 'no_migration_run') {
      writeActiveProject({ ...project, migration: result })
    }

    return result
  },

  getMigrationStreamUrl: () => {
    const project = requireActiveProject()
    const apiBase = import.meta.env.VITE_API_BASE_URL ?? ''
    if (apiBase) {
      // Production: replace https:// with wss:// (or http:// with ws://)
      const wsBase = apiBase.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://')
      return `${wsBase}/api/projects/${project.projectId}/migration/stream`
    }
    // Development: Vite proxies ws:// to the backend
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${wsProtocol}//${window.location.host}/api/projects/${project.projectId}/migration/stream`
  },

  // ── Report ──────────────────────────────────────────────────────────────────

  getReport: async (): Promise<ReportData> => {
    const project = requireActiveProject()

    interface BackendReport {
      project: Record<string, unknown>
      mappings: Array<Record<string, unknown>>
      validation_breakdown: Record<string, number>
      validation_summary: { total_count: number; valid_count: number; invalid_count: number }
      migration_stats: {
        total_records: number
        loaded_records: number
        failed_records: number
        success_rate: number
      } | null
      error?: string
    }

    const report = await request<BackendReport>(`/api/projects/${project.projectId}/report`)

    if (report.error) {
      throw new Error(report.error)
    }

    const mappings = await api.getMappings()

    const stats = report.migration_stats
    const loaded  = stats?.loaded_records  ?? 0
    const failed  = stats?.failed_records  ?? 0
    const total   = stats?.total_records   ?? project.rows
    const rate    = stats?.success_rate    ?? (total ? Math.round((loaded / total) * 1000) / 10 : 0)

    // Build error breakdown from validation_breakdown
    const errorsByType = Object.entries(report.validation_breakdown).map(([type, count]) => ({ 
      type, 
      count 
    }))

    return {
      totalSource: project.rows,
      loaded,
      failed,
      excluded: report.validation_summary.invalid_count,
      successRate: rate,
      batches: Math.max(1, Math.ceil(total / 500)),
      timeTaken: 'Less than 1 minute',
      errorsByType,
      confidenceDistribution: confidenceDistribution(mappings),
    }
  },

  downloadValidationErrorsExcel: () => {
    const project = requireActiveProject()
    return request<Blob>(`/api/projects/${project.projectId}/report/validation-errors/export`)
  },

  downloadMigrationErrorsExcel: () => {
    const project = requireActiveProject()
    return request<Blob>(`/api/projects/${project.projectId}/report/migration-errors/export`)
  },

  downloadMappingJson: () => {
    const project = requireActiveProject()
    return request<Record<string, unknown>>(`/api/projects/${project.projectId}/report/mappings/export`)
  },

  downloadFullReport: () => {
    const project = requireActiveProject()
    // Returns a Blob (Excel file)
    return request<Blob>(`/api/projects/${project.projectId}/report/full/export`)
  },

  // ── Save mappings to backend DB ────────────────────────────────────────────
  saveMappings: async (mappings: MappingSuggestion[]) => {
    const project = requireActiveProject()
    return request<{ saved: number; approved: number; message: string }>(
      `/api/projects/${project.projectId}/mappings`,
      {
        method: 'PUT',
        body: JSON.stringify({ mappings }),
      }
    )
  },

  getEntityFields: (entity: string) =>
    request<{ entity: string; fields: Array<{ api: string; display: string }> }>(
      `/api/entities/${entity}/fields`
    ),

  // ── AI Validation Agent ─────────────────────────────────────────────────────

  askValidationAgent: (
    question: string,
    conversationHistory: Array<{ role: string; content: string }> = [],
  ) => {
    const project = requireActiveProject()
    return request<{
      answer: string
      suggested_fix: { row_number: number; column: string; new_value: string } | null
      requires_confirmation: boolean
      fix_parse_error: string | null
    }>(`/api/projects/${project.projectId}/validation/ask`, {
      method: 'POST',
      body: JSON.stringify({
        question,
        conversation_history: conversationHistory,
      }),
    })
  },

  explainValidationError: (rowNumber: number) => {
    const project = requireActiveProject()
    return request<{ explanation: string }>(
      `/api/projects/${project.projectId}/validation/explain/${rowNumber}`,
      { method: 'POST' },
    )
  },

  suggestRowFix: (rowNumber: number) => {
    const project = requireActiveProject()
    return request<{
      row_number: number
      current_value: string
      column: string
      error_type: string
      ai_suggestion: string
      suggested_fix: { row_number: number; column: string; new_value: string } | null
    }>(`/api/projects/${project.projectId}/validation/suggest-fix/${rowNumber}`)
  },

  applyValidationFix: (fix: { row_number: number; column: string; new_value: string }) => {
    const project = requireActiveProject()
    return request<{ success: boolean; message: string }>(
      `/api/projects/${project.projectId}/validation/apply-fix`,
      {
        method: 'POST',
        body: JSON.stringify(fix),
      },
    )
  },

  // ── Confirm mappings — saves human corrections to DB history ───────────────
  confirmMappings: (mappings: MappingSuggestion[]) => {
    const project = requireActiveProject()
    const payload = mappings
      .filter(m => !m.excluded && m.d365Field && m.d365Field !== 'no_match')
      .map(m => ({
        source_column:     m.source,
        d365_field:        m.d365Field,
        d365_display_name: m.display,
      }))
    return request<{ confirmed: number; entity: string; message: string }>(
      `/api/projects/${project.projectId}/mappings/confirm`,
      {
        method: 'POST',
        body: JSON.stringify({ mappings: payload }),
      },
    )
  },

  deleteProject: (projectId: string) =>
    request<{ deleted: boolean; project_id: string }>(
      `/api/projects/${projectId}`,
      { method: 'DELETE' }
    ),

  bulkDeleteProjects: (projectIds: string[]) =>
    request<{ deleted: Record<string, boolean> }>(
      `/api/projects`,
      {
        method: 'DELETE',
        body: JSON.stringify(projectIds),
      }
    ),

  // ── Audit ───────────────────────────────────────────────────────────────────

  getAuditEntries: async (): Promise<AuditEntry[]> => {
    const project = readActiveProject()
    if (!project) return []

    // localStorage entries written by the frontend (upload, mapping, validation, cleansing, migration)
    const localEntries: AuditEntry[] = project.auditEntries ?? []

    try {
      interface BackendAuditEntry {
        action: string
        action_at: string | null
        details: Record<string, unknown> | null
        status: string
      }
      interface BackendAuditResponse {
        audit_log: BackendAuditEntry[]
        total: number
        summary: Record<string, number>
      }

      const response = await request<BackendAuditResponse>(
        `/api/projects/${project.projectId}/audit`,
      )

      const formatTs = (ts: string | null): string => {
        if (!ts) return new Date().toLocaleString('en-GB', {
          day: '2-digit', month: 'short', year: 'numeric',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        })
        // PostgreSQL returns UTC without 'Z' — append it so JS parses correctly
        const normalized = ts.endsWith('Z') ? ts : ts + 'Z'
        return new Date(normalized).toLocaleString('en-GB', {
          day: '2-digit', month: 'short', year: 'numeric',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        })
      }

      const backendEntries: AuditEntry[] = response.audit_log.map((entry, idx) => ({
        id: `backend-${idx}`,
        timestamp: formatTs(entry.action_at),
        user: 'System',
        action: entry.action
          .replace(/_/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase()),
        status: entry.status === 'success'
          ? 'Success'
          : entry.status === 'warning'
          ? 'Warning'
          : 'Failed',
        details: entry.details
          ? Object.entries(entry.details)
              .map(([k, v]) => `${k}: ${v}`)
              .join(', ')
          : '',
      }))

      // Merge: backend entries are authoritative; add any localStorage-only entries
      // that don't have a matching backend action (e.g. "File uploaded" before backend audit was added)
      const backendActions = new Set(backendEntries.map(e => e.action.toLowerCase()))
      const localOnlyEntries = localEntries.filter(
        e => !backendActions.has(e.action.toLowerCase())
      )

      // Return backend entries first (newest first), then any local-only ones
      return [...backendEntries, ...localOnlyEntries]
    } catch {
      // Backend unreachable — fall back to localStorage only
      return localEntries
    }
  },
}
