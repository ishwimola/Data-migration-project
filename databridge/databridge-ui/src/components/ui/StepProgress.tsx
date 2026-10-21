import { Check } from 'lucide-react'
import { useProject, Stage } from '../../context/ProjectContext'

const STEPS: { label: string; stage: Stage }[] = [
  { label: 'Upload',     stage: 'upload'     },
  { label: 'Schema',     stage: 'schema'     },
  { label: 'Mapping',    stage: 'mapping'    },
  { label: 'Validation', stage: 'validation' },
  { label: 'Cleansing',  stage: 'cleansing'  },
  { label: 'Migration',  stage: 'migration'  },
  { label: 'Report',     stage: 'report'     },
]

interface StepProgressProps {
  current: number   // 0-based index
}

export default function StepProgress({ current }: StepProgressProps) {
  const { isStageComplete } = useProject()

  return (
    <div className="flex items-start w-full">
      {STEPS.map((step, i) => {
        const isDone    = isStageComplete(step.stage)
        const isCurrent = i === current
        const isPast    = i < current

        return (
          <div key={step.stage} className="flex items-start flex-1">
            {/* Step node */}
            <div className="flex flex-col items-center gap-1.5">
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-300 shrink-0"
                style={
                  isDone || isPast
                    ? { background: 'linear-gradient(135deg,#6366f1,#06b6d4)', color: '#fff', boxShadow: '0 0 12px rgba(99,102,241,0.4)' }
                    : isCurrent
                    ? { background: 'rgba(99,102,241,0.12)', color: '#6366f1', border: '2px solid #6366f1', boxShadow: '0 0 16px rgba(99,102,241,0.2)' }
                    : { background: '#f1f5f9', color: '#94a3b8', border: '1px solid #e2e8f0' }
                }
              >
                {isDone || isPast ? <Check size={12} /> : i + 1}
              </div>
              <span
                className="text-xs font-medium whitespace-nowrap"
                style={{
                  color: isCurrent ? '#6366f1' : isDone || isPast ? '#475569' : '#94a3b8',
                  fontWeight: isCurrent ? 600 : 400,
                }}
              >
                {step.label}
              </span>
            </div>

            {/* Connector */}
            {i < STEPS.length - 1 && (
              <div
                className="flex-1 h-0.5 mt-3.5 mx-1 rounded-full transition-all duration-500"
                style={{
                  background: isDone || isPast
                    ? 'linear-gradient(90deg,#6366f1,#06b6d4)'
                    : '#e2e8f0',
                }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
