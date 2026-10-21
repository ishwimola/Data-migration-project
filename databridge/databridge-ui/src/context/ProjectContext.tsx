import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import {
  ACTIVE_PROJECT_KEY,
  COMPLETED_STAGES_KEY,
  readCompletedStages,
  writeCompletedStages,
  clearCompletedStages,
  type Stage,
} from '../lib/storage'

export type { Stage }

export type ProjectStatus = 'In Progress' | 'Completed' | 'Failed'

// Ordered pipeline stages — used for completion tracking
export const PIPELINE_STAGES: Stage[] = [
  'upload', 'schema', 'mapping', 'validation', 'cleansing', 'migration', 'report',
]

interface ProjectContextType {
  projectName: string
  clientName: string
  entity: string
  stage: Stage
  status: ProjectStatus
  completedStages: Set<Stage>
  setProject: (name: string, client: string, entity: string) => void
  setStage: (stage: Stage) => void
  setStatus: (status: ProjectStatus) => void
  markStageComplete: (stage: Stage) => void
  isStageComplete: (stage: Stage) => boolean
  resetPipeline: () => void
}

const ProjectContext = createContext<ProjectContextType>({
  projectName: '',
  clientName: '',
  entity: '',
  stage: 'upload',
  status: 'In Progress',
  completedStages: new Set(),
  setProject: () => {},
  setStage: () => {},
  setStatus: () => {},
  markStageComplete: () => {},
  isStageComplete: () => false,
  resetPipeline: () => {},
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadProjectMeta(): { projectName: string; clientName: string; entity: string } {
  try {
    const raw = localStorage.getItem(ACTIVE_PROJECT_KEY)
    if (!raw) return { projectName: '', clientName: '', entity: '' }
    const parsed = JSON.parse(raw)
    return {
      projectName: parsed.projectName ?? '',
      clientName:  parsed.clientName  ?? '',
      entity:      parsed.entity      ?? '',
    }
  } catch {
    return { projectName: '', clientName: '', entity: '' }
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function ProjectProvider({ children }: { children: ReactNode }) {
  // Hydrate from localStorage on first render so state survives page refreshes
  const [projectName, setProjectName] = useState(() => loadProjectMeta().projectName)
  const [clientName, setClientName]   = useState(() => loadProjectMeta().clientName)
  const [entity, setEntity]           = useState(() => loadProjectMeta().entity)
  const [stage, setStageState]        = useState<Stage>('upload')
  const [status, setStatusState]      = useState<ProjectStatus>('In Progress')
  const [completedStages, setCompletedStages] = useState<Set<Stage>>(() => readCompletedStages())

  // Keep completedStages in sync with localStorage whenever it changes
  useEffect(() => {
    writeCompletedStages(completedStages)
  }, [completedStages])

  // Re-hydrate project meta if localStorage changes (e.g. after upload/connect)
  useEffect(() => {
    const handleStorage = () => {
      const meta = loadProjectMeta()
      if (meta.projectName) setProjectName(meta.projectName)
      if (meta.clientName)  setClientName(meta.clientName)
      if (meta.entity)      setEntity(meta.entity)
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  const setProject = (name: string, client: string, ent: string) => {
    setProjectName(name)
    setClientName(client)
    setEntity(ent)
  }

  const markStageComplete = (s: Stage) => {
    setCompletedStages(prev => new Set([...prev, s]))
  }

  const isStageComplete = (s: Stage) => completedStages.has(s)

  const resetPipeline = () => {
    setCompletedStages(new Set())
    setStageState('upload')
    setStatusState('In Progress')
    clearCompletedStages()
    // Note: we intentionally do NOT clear activeProject or projectHistory here.
    // The backend DB holds all projects; history is preserved for the fallback.
  }

  return (
    <ProjectContext.Provider value={{
      projectName, clientName, entity, stage, status, completedStages,
      setProject,
      setStage: setStageState,
      setStatus: setStatusState,
      markStageComplete,
      isStageComplete,
      resetPipeline,
    }}>
      {children}
    </ProjectContext.Provider>
  )
}

export const useProject = () => useContext(ProjectContext)
