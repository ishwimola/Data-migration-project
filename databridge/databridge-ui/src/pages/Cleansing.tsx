import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Sparkles, ChevronRight, ChevronLeft, Play, RotateCcw,
  CheckCircle, AlertTriangle, ChevronDown, ChevronUp, Trash2,
} from 'lucide-react'
import { useProject } from '../context/ProjectContext'
import { api } from '../services/api'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PlaybookStep {
  id: string
  step_number: number
  instruction_text: string
  generated_sql: string
  affected_rows: number | null
  executed_at: string | null
  is_active: boolean
}

interface DryRunResult {
  affectedRows: number
  sql: string
  transformationType: string
  before: Record<string, string>[]
  after: Record<string, string>[]
}

const SUGGESTION_EXAMPLES = [
  'Set Country to United Kingdom where Country is blank',
  'Convert all email addresses to lowercase',
  'Delete all records where company name contains test or demo',
  'Replace all values in NationalID column with REDACTED',
  'Convert dates in created_date to YYYY-MM-DD format',
  'Populate FullName by concatenating FirstName and LastName',
  'Mark duplicate accounts — keep most recently modified',
  'Update Status to Inactive where LastModifiedDate is older than 3 years',
]

// ── Component ─────────────────────────────────────────────────────────────────

export default function Cleansing() {
  const navigate = useNavigate()
  const { markStageComplete } = useProject()

  const [instruction, setInstruction]         = useState('')
  const [generating, setGenerating]           = useState(false)
  const [generateError, setGenerateError]     = useState<string | null>(null)
  const [dryRun, setDryRun]                   = useState<DryRunResult | null>(null)
  const [confirming, setConfirming]           = useState(false)
  const [confirmError, setConfirmError]       = useState<string | null>(null)
  const [playbook, setPlaybook]               = useState<PlaybookStep[]>([])
  const [playbookLoading, setPlaybookLoading] = useState(true)
  const [expandedSQL, setExpandedSQL]         = useState<string | null>(null)
  const [replaying, setReplaying]             = useState(false)
  const [replayDone, setReplayDone]           = useState(false)
  const [replayError, setReplayError]         = useState<string | null>(null)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Load playbook on mount
  useEffect(() => {
    api.getPlaybook()
      .then(steps => setPlaybook(steps as unknown as PlaybookStep[]))
      .catch(() => setPlaybook([]))
      .finally(() => setPlaybookLoading(false))
  }, [])

  // ── Generate SQL from instruction ──────────────────────────────────────────

  const handleGenerate = async () => {
    if (!instruction.trim()) return
    setGenerating(true)
    setDryRun(null)
    setGenerateError(null)

    try {
      const result = await api.previewCleanse(instruction.trim())
      if (result.error) {
        setGenerateError(result.error)
        return
      }
      setDryRun({
        affectedRows:      result.affected_rows,
        sql:               result.generated_sql,
        transformationType: result.transformation_type,
        before: result.sample_before as Record<string, string>[],
        after:  result.sample_after  as Record<string, string>[],
      })
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Failed to generate SQL')
    } finally {
      setGenerating(false)
    }
  }

  // ── Confirm and add to playbook ────────────────────────────────────────────

  const handleConfirm = async () => {
    if (!dryRun) return
    setConfirming(true)
    setConfirmError(null)

    try {
      const result = await api.executeCleanse({
        instruction:  instruction.trim(),
        sql:          dryRun.sql,
        affectedRows: dryRun.affectedRows,
      })

      if (result.error) {
        setConfirmError(result.error)
        return
      }

      // Refresh playbook from backend
      const steps = await api.getPlaybook()
      setPlaybook(steps as unknown as PlaybookStep[])
      setInstruction('')
      setDryRun(null)
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : 'Failed to apply cleansing step')
    } finally {
      setConfirming(false)
    }
  }

  // ── Replay all ─────────────────────────────────────────────────────────────

  const handleReplayAll = async () => {
    setReplaying(true)
    setReplayDone(false)
    setReplayError(null)

    try {
      await api.replayPlaybook()
      setReplayDone(true)
    } catch (err) {
      setReplayError(err instanceof Error ? err.message : 'Replay failed')
    } finally {
      setReplaying(false)
    }
  }

  // ── Proceed ────────────────────────────────────────────────────────────────

  const handleProceed = () => {
    markStageComplete('cleansing')
    navigate('/migration')
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="page-header">✨ Data Cleansing</h1>
          <p className="text-slate-500 mt-1">
            Type plain English instructions — AI generates SQL, you preview and confirm
          </p>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 bg-purple-50 border border-purple-200 rounded-lg">
          <div className="w-2 h-2 rounded-full bg-purple-500 pulse-dot" />
          <span className="text-xs font-medium text-purple-700">AI SQL engine — ready</span>
        </div>
      </div>

      {/* Info banner */}
      <div className="flex items-start gap-3 p-4 bg-blue-50 border border-blue-100 rounded-xl">
        <Sparkles size={16} className="text-blue-600 mt-0.5 shrink-0" />
        <p className="text-sm text-blue-800">
          Describe what you want to clean in plain English. The AI converts your instruction to SQL,
          shows you a <strong>dry run preview</strong> before any data changes, and stores every
          confirmed step in the <strong>replayable playbook</strong>.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Left — instruction input + dry run */}
        <div className="col-span-2 space-y-5">

          {/* Instruction input */}
          <div className="card p-5 space-y-3">
            <h2 className="section-title">Cleansing Instruction</h2>

            {/* Suggestion chips */}
            <div>
              <button
                onClick={() => setShowSuggestions(s => !s)}
                className="text-xs text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1"
              >
                {showSuggestions ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                Show example instructions
              </button>
              {showSuggestions && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {SUGGESTION_EXAMPLES.map(ex => (
                    <button
                      key={ex}
                      onClick={() => { setInstruction(ex); setShowSuggestions(false); inputRef.current?.focus() }}
                      className="px-2.5 py-1 bg-slate-100 hover:bg-blue-50 hover:text-blue-700 text-slate-600 rounded-lg text-xs transition-colors"
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <textarea
              ref={inputRef}
              rows={3}
              className="input resize-none"
              placeholder="e.g. Set Country to United Kingdom where Country is blank"
              value={instruction}
              onChange={e => setInstruction(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && e.ctrlKey) handleGenerate() }}
            />
            <p className="text-xs text-slate-400">Ctrl+Enter to generate</p>

            {generateError && (
              <p className="text-xs text-red-600 bg-red-50 p-2 rounded">{generateError}</p>
            )}

            <button
              onClick={handleGenerate}
              disabled={!instruction.trim() || generating}
              className="btn-primary flex items-center gap-2 disabled:opacity-50"
            >
              {generating ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Generating SQL...
                </>
              ) : (
                <><Sparkles size={15} /> Generate SQL</>
              )}
            </button>
          </div>

          {/* Dry run result */}
          {dryRun && (
            <div className="card p-5 space-y-4 border-2 border-blue-200">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <h2 className="section-title mb-0">Dry Run Preview</h2>
                  <span className="text-xs text-slate-500 capitalize">
                    Type: <strong>{dryRun.transformationType.replace(/_/g, ' ')}</strong>
                  </span>
                </div>
                <span className="px-3 py-1 bg-amber-100 text-amber-800 rounded-full text-xs font-semibold">
                  {dryRun.affectedRows} rows will be affected
                </span>
              </div>

              {/* Generated SQL */}
              <div>
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
                  Generated SQL
                </p>
                <pre className="bg-slate-900 text-green-400 text-xs p-3 rounded-lg overflow-x-auto font-mono">
                  {dryRun.sql}
                </pre>
              </div>

              {/* Before / After comparison */}
              {dryRun.before.length > 0 && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs font-semibold text-red-600 uppercase tracking-wide mb-1.5">
                      Before (sample)
                    </p>
                    <div className="overflow-x-auto rounded-lg border border-red-100">
                      <table className="w-full text-xs">
                        <thead className="bg-red-50">
                          <tr>
                            {Object.keys(dryRun.before[0] ?? {}).map(k => (
                              <th key={k} className="text-left px-3 py-2 text-red-700 font-semibold">{k}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-red-50">
                          {dryRun.before.map((row, i) => (
                            <tr key={i}>
                              {Object.values(row).map((v, j) => (
                                <td key={j} className="px-3 py-2 text-slate-600">
                                  {v || <span className="text-slate-300 italic">empty</span>}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-green-600 uppercase tracking-wide mb-1.5">
                      After (preview)
                    </p>
                    <div className="overflow-x-auto rounded-lg border border-green-100">
                      <table className="w-full text-xs">
                        <thead className="bg-green-50">
                          <tr>
                            {Object.keys(dryRun.after[0] ?? {}).map(k => (
                              <th key={k} className="text-left px-3 py-2 text-green-700 font-semibold">{k}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-green-50">
                          {dryRun.after.map((row, i) => (
                            <tr key={i}>
                              {Object.values(row).map((v, j) => (
                                <td key={j} className="px-3 py-2 text-slate-700 font-medium">{String(v)}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {confirmError && (
                <p className="text-xs text-red-600 bg-red-50 p-2 rounded">{confirmError}</p>
              )}

              {/* Confirm / Discard */}
              <div className="flex gap-3 pt-1">
                <button
                  onClick={handleConfirm}
                  disabled={confirming}
                  className="btn-primary flex items-center gap-2 disabled:opacity-50"
                >
                  {confirming ? (
                    <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Applying...</>
                  ) : (
                    <><CheckCircle size={15} /> Confirm &amp; Apply</>
                  )}
                </button>
                <button
                  onClick={() => { setDryRun(null); setConfirmError(null) }}
                  className="btn-secondary flex items-center gap-2 text-sm"
                >
                  Discard
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right — playbook history */}
        <div className="space-y-4">
          <div className="card overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
              <h3 className="font-semibold text-slate-800 text-sm">
                Cleansing Playbook ({playbook.length} steps)
              </h3>
              <button
                onClick={handleReplayAll}
                disabled={replaying || playbook.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {replaying ? (
                  <><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> Replaying...</>
                ) : (
                  <><RotateCcw size={12} /> Replay All</>
                )}
              </button>
            </div>

            {replayDone && (
              <div className="px-5 py-3 bg-green-50 border-b border-green-100 flex items-center gap-2">
                <CheckCircle size={14} className="text-green-600" />
                <span className="text-xs text-green-700 font-medium">
                  All {playbook.length} steps replayed successfully
                </span>
              </div>
            )}

            {replayError && (
              <div className="px-5 py-3 bg-red-50 border-b border-red-100 text-xs text-red-600">
                Replay error: {replayError}
              </div>
            )}

            {playbookLoading ? (
              <div className="px-5 py-8 text-center text-slate-400 text-sm">Loading playbook...</div>
            ) : playbook.length === 0 ? (
              <div className="px-5 py-8 text-center text-slate-400 text-sm">
                No cleansing steps yet. Confirm an instruction above to add it here.
              </div>
            ) : (
              <div className="divide-y divide-slate-50">
                {playbook.map(step => (
                  <div key={step.id} className="px-5 py-3.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2 flex-1 min-w-0">
                        <span className="w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                          {step.step_number}
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm text-slate-800 font-medium leading-snug">
                            {step.instruction_text}
                          </p>
                          <p className="text-xs text-slate-400 mt-0.5">
                            {step.affected_rows != null ? `${step.affected_rows} rows` : ''}
                            {step.executed_at
                              ? ` · ${new Date(step.executed_at).toLocaleString('en-GB', {
                                  day: '2-digit', month: 'short', year: 'numeric',
                                  hour: '2-digit', minute: '2-digit', second: '2-digit',
                                })}`
                              : ''}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => setExpandedSQL(expandedSQL === step.id ? null : step.id)}
                          className="p-1 text-slate-400 hover:text-blue-600 transition-colors"
                          title="View SQL"
                        >
                          {expandedSQL === step.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </button>
                      </div>
                    </div>
                    {expandedSQL === step.id && (
                      <pre className="mt-2 bg-slate-900 text-green-400 text-xs p-2.5 rounded-lg overflow-x-auto font-mono">
                        {step.generated_sql}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Supported operations reference */}
          <div className="card p-4">
            <h4 className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">
              Supported Operations
            </h4>
            <ul className="space-y-1.5 text-xs text-slate-500">
              {[
                'Set default value where blank',
                'Update values based on condition',
                'Convert date formats',
                'Standardise text case',
                'Deduplicate records',
                'Mask PII data (REDACTED)',
                'Delete test/demo records',
                'Derive columns from existing values',
              ].map(op => (
                <li key={op} className="flex items-center gap-1.5">
                  <span className="text-green-500">✓</span> {op}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex justify-between">
        <button onClick={() => navigate('/validation')} className="btn-secondary flex items-center gap-2">
          <ChevronLeft size={16} /> Back to Validation
        </button>
        <div className="flex gap-3 items-center">
          {playbook.length === 0 && (
            <div className="flex items-center gap-2 text-sm text-amber-600">
              <AlertTriangle size={14} />
              <span>No cleansing steps added — you can proceed without cleansing</span>
            </div>
          )}
          <button onClick={handleProceed} className="btn-primary flex items-center gap-2">
            Proceed to Migration <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
