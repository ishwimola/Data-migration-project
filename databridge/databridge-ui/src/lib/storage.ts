/**
 * TASK-020: Shared localStorage helpers extracted from api.ts and ProjectContext.tsx.
 * Single source of truth for all localStorage key names and read/write helpers.
 */

// ── Key constants ─────────────────────────────────────────────────────────────

export const ACTIVE_PROJECT_KEY   = 'databridge.activeProject'
export const PROJECT_HISTORY_KEY  = 'databridge.projectHistory'
export const COMPLETED_STAGES_KEY = 'databridge.completedStages'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StoredProject {
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

// ── Active project ────────────────────────────────────────────────────────────

export function readActiveProjectRaw(): Record<string, unknown> | null {
  const raw = localStorage.getItem(ACTIVE_PROJECT_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    localStorage.removeItem(ACTIVE_PROJECT_KEY)
    return null
  }
}

export function writeActiveProjectRaw(next: Record<string, unknown>) {
  localStorage.setItem(ACTIVE_PROJECT_KEY, JSON.stringify(next))
}

export function clearActiveProject() {
  localStorage.removeItem(ACTIVE_PROJECT_KEY)
}

// ── Project history ───────────────────────────────────────────────────────────

export function readProjectHistory(): StoredProject[] {
  try {
    const raw = localStorage.getItem(PROJECT_HISTORY_KEY)
    if (!raw) return []
    return JSON.parse(raw) as StoredProject[]
  } catch {
    return []
  }
}

export function writeProjectHistory(history: StoredProject[]) {
  localStorage.setItem(PROJECT_HISTORY_KEY, JSON.stringify(history))
}

export function upsertProjectHistory(entry: StoredProject) {
  const history = readProjectHistory()
  const updated = [entry, ...history.filter(p => p.id !== entry.id)]
  writeProjectHistory(updated)
}

export function updateProjectHistoryEntry(
  projectId: string,
  updates: Partial<StoredProject>,
) {
  const history = readProjectHistory()
  writeProjectHistory(history.map(p => (p.id === projectId ? { ...p, ...updates } : p)))
}

// ── Completed stages ──────────────────────────────────────────────────────────

export type Stage =
  | 'upload' | 'schema' | 'mapping' | 'validation'
  | 'cleansing' | 'migration' | 'report'

export function readCompletedStages(): Set<Stage> {
  try {
    const raw = localStorage.getItem(COMPLETED_STAGES_KEY)
    if (!raw) return new Set()
    return new Set(JSON.parse(raw) as Stage[])
  } catch {
    return new Set()
  }
}

export function writeCompletedStages(stages: Set<Stage>) {
  localStorage.setItem(COMPLETED_STAGES_KEY, JSON.stringify(Array.from(stages)))
}

export function clearCompletedStages() {
  localStorage.removeItem(COMPLETED_STAGES_KEY)
}
