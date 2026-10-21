import { useLocation, useNavigate } from 'react-router-dom'
import { useProject, PIPELINE_STAGES } from '../../context/ProjectContext'
import { ChevronRight, Layers, Check } from 'lucide-react'

const STAGE_MAP: Record<string, { label: string; step: number; emoji: string }> = {
  '/':           { label: 'Dashboard',    step: 0, emoji: '🏠' },
  '/sources':    { label: 'Import Data',  step: 0, emoji: '📁' },
  '/schema':     { label: 'Schema',       step: 2, emoji: '🔍' },
  '/mapping':    { label: 'AI Mapping',   step: 3, emoji: '🤖' },
  '/validation': { label: 'Validation',   step: 4, emoji: '✅' },
  '/cleansing':  { label: 'Cleansing',    step: 5, emoji: '✨' },
  '/migration':  { label: 'Migration',    step: 6, emoji: '🚀' },
  '/report':     { label: 'Report',       step: 7, emoji: '📊' },
  '/audit':      { label: 'Audit Log',    step: 0, emoji: '📋' },
}

const TOTAL_STEPS = 7

const STEP_LABELS = ['Upload', 'Schema', 'Mapping', 'Validation', 'Cleansing', 'Migration', 'Report']
const STEP_STAGES = ['upload', 'schema', 'mapping', 'validation', 'cleansing', 'migration', 'report'] as const

const STATUS_STYLES: Record<string, { bg: string; color: string; dot: string }> = {
  'In Progress': { bg: '#fef3c7', color: '#d97706', dot: '#f59e0b' },
  'Completed':   { bg: '#dcfce7', color: '#16a34a', dot: '#10b981' },
  'Failed':      { bg: '#fee2e2', color: '#dc2626', dot: '#ef4444' },
}

export default function GlobalHeader() {
  const location = useLocation()
  const navigate  = useNavigate()
  const { projectName, clientName, entity, status, isStageComplete } = useProject()

  const current     = STAGE_MAP[location.pathname] ?? { label: 'Dashboard', step: 0, emoji: '🏠' }
  // Progress based on actual completed stages, not current page
  const completedCount = PIPELINE_STAGES.filter(s => isStageComplete(s)).length
  const progressPct = completedCount > 0 ? Math.round((completedCount / TOTAL_STEPS) * 100) : 0
  const statusStyle = STATUS_STYLES[status] ?? STATUS_STYLES['In Progress']

  const hiddenPaths = ['/', '/audit', '/sources']
  if (hiddenPaths.includes(location.pathname)) return null

  return (
    <header
      className="sticky top-0 z-30 px-8 py-3"
      style={{
        background: 'rgba(255,255,255,0.95)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderBottom: '1px solid #e2e8f0',
      }}
    >
      <div className="max-w-7xl mx-auto">
        {/* Top row */}
        <div className="flex items-center justify-between mb-2.5">

          {/* Left: project meta */}
          <div className="flex items-center gap-5">
            <div className="flex items-center gap-2">
              <Layers size={14} style={{ color: '#94a3b8' }} />
              <span className="text-xs font-medium" style={{ color: '#64748b' }}>
                {projectName || 'No project'}
              </span>
            </div>

            {clientName && (
              <>
                <div style={{ width: 1, height: 16, background: '#e2e8f0' }} />
                <span className="text-xs" style={{ color: '#94a3b8' }}>{clientName}</span>
              </>
            )}

            {entity && (
              <>
                <div style={{ width: 1, height: 16, background: '#e2e8f0' }} />
                <span
                  className="text-xs px-2 py-0.5 rounded-md font-semibold"
                  style={{ background: '#dbeafe', color: '#2563eb' }}
                >
                  {entity}
                </span>
              </>
            )}
          </div>

          {/* Right: status + breadcrumb */}
          <div className="flex items-center gap-4">
            {/* Breadcrumb */}
            <div className="flex items-center gap-1 text-xs" style={{ color: '#94a3b8' }}>
              <button
                onClick={() => navigate('/')}
                className="hover:text-slate-900 transition-colors"
              >
                Home
              </button>
              <ChevronRight size={12} />
              <span style={{ color: '#6366f1' }}>{current.emoji} {current.label}</span>
            </div>

            {/* Status pill */}
            <div
              className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold"
              style={{ background: statusStyle.bg, color: statusStyle.color }}
            >
              <div
                className="w-1.5 h-1.5 rounded-full pulse-dot"
                style={{ background: statusStyle.dot }}
              />
              {status}
            </div>
          </div>
        </div>

        {/* Step progress track */}
        {current.step > 0 && (
          <div className="flex items-center gap-1">
            {STEP_LABELS.map((label, i) => {
              const stepNum   = i + 1
              const stage     = STEP_STAGES[i]
              const isDone    = isStageComplete(stage)
              const isCurrent = stepNum === current.step

              return (
                <div key={label} className="flex items-center gap-1 flex-1">
                  <div className="flex flex-col items-center gap-1 flex-1">
                    {/* Track segment with tick */}
                    <div className="w-full flex items-center gap-1">
                      <div
                        className="flex-1 h-0.5 rounded-full transition-all duration-500"
                        style={{
                          background: isDone || isCurrent
                            ? 'linear-gradient(90deg, #6366f1, #06b6d4)'
                            : '#e2e8f0',
                          boxShadow: isCurrent ? '0 0 8px rgba(99,102,241,0.4)' : 'none',
                        }}
                      />
                      {/* Tick icon for completed steps */}
                      {isDone && (
                        <div
                          className="w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0"
                          style={{ background: 'linear-gradient(135deg,#6366f1,#06b6d4)' }}
                        >
                          <Check size={8} color="#fff" strokeWidth={3} />
                        </div>
                      )}
                    </div>
                    {/* Label */}
                    <span
                      className="text-xs transition-all duration-300 hidden lg:block"
                      style={{
                        color: isCurrent ? '#6366f1' : isDone ? '#475569' : '#cbd5e1',
                        fontWeight: isCurrent ? 600 : isDone ? 500 : 400,
                        fontSize: '0.65rem',
                      }}
                    >
                      {label}
                    </span>
                  </div>
                </div>
              )
            })}

            {/* Percentage — based on actual completed stages */}
            <span
              className="text-xs font-bold ml-2 shrink-0"
              style={{ color: '#6366f1', minWidth: '2.5rem', textAlign: 'right' }}
            >
              {progressPct}%
            </span>
          </div>
        )}
      </div>
    </header>
  )
}
