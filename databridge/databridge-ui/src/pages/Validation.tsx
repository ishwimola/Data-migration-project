import { useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ShieldCheck, ChevronRight, ChevronLeft, Download,
  Lock, AlertTriangle, Bot,
} from 'lucide-react'
import { useProject } from '../context/ProjectContext'
import { api } from '../services/api'
import type { ValidationSummary, ValidationError } from '../services/api'
import { ValidationSkeleton } from '../components/ui/Skeleton'
import ValidationAgent, { ExplainRowButton } from '../components/ui/ValidationAgent'

const RULES = [
  {
    id: 'mandatory',
    label: 'Mandatory Field Check',
    desc: 'Flags rows where a required D365 field is blank or null',
    canDisable: false,
    on: true,
  },
  {
    id: 'datatype',
    label: 'Data Type Mismatch',
    desc: 'Flags rows where a text value appears in a numeric or date field',
    canDisable: true,
    on: true,
  },
  {
    id: 'length',
    label: 'Length Overflow',
    desc: 'Flags values exceeding the maximum character length of the target D365 field',
    canDisable: true,
    on: true,
  },
  {
    id: 'duplicate',
    label: 'Duplicate Detection',
    desc: 'Flags duplicate records based on key fields defined in the approved mapping',
    canDisable: true,
    on: true,
  },
  {
    id: 'email',
    label: 'Email Format Check',
    desc: 'Validates correct email address format in email-type columns',
    canDisable: true,
    on: true,
  },
  {
    id: 'phone',
    label: 'Phone Format Check',
    desc: 'Validates correct phone number format in phone-type columns',
    canDisable: true,
    on: false,
  },
]

export default function Validation() {
  const navigate = useNavigate()
  const { markStageComplete } = useProject()

  const [rules, setRules]               = useState(RULES)
  const [ran, setRan]                   = useState(false)
  const [running, setRunning]           = useState(false)
  const [runError, setRunError]         = useState<string | null>(null)
  const [validationSummary, setSummary] = useState<ValidationSummary | null>(null)
  const [validationErrors, setErrors]   = useState<ValidationError[]>([])
  const [downloading, setDownloading]   = useState(false)
  const [showFixModal, setShowFixModal] = useState(false)
  const [activeRuleFilter, setActiveRuleFilter] = useState<string | null>(null)
  const [agentOpen, setAgentOpen]       = useState(false)

  const failedRowsRef = useRef<HTMLDivElement>(null)

  const toggleRule = (id: string) => {
    setRules(prev => prev.map(r => r.id === id && r.canDisable ? { ...r, on: !r.on } : r))
  }

  const runValidation = async () => {
    setRunning(true)
    setRunError(null)
    try {
      const result = await api.runValidation()
      setSummary(result.summary)
      setErrors(result.errors)
      setRan(true)
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Validation failed')
    } finally {
      setRunning(false)
    }
  }

  const handleDownload = async () => {
    setDownloading(true)
    try {
      const blob = await api.downloadValidationReport()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = 'validation_errors.xlsx'
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      alert('Download failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setDownloading(false)
    }
  }

  const handleProceedWithValid = () => {
    markStageComplete('validation')
    navigate('/cleansing')
  }

  const handleFixErrors = async () => {
    await handleDownload()
    setShowFixModal(true)
  }

  const handleViewRows = (rule: string) => {
    setActiveRuleFilter(rule)
    setTimeout(() => {
      failedRowsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 50)
  }

  // Called by ValidationAgent after a fix is confirmed applied on the backend.
  // Single atomic setErrors call — filter + recompute summary in one React commit.
  const handleFixApplied = (fixedRow: number, fixedColumn: string) => {
    setErrors(prev => {
      const remaining = prev.filter(e => !(e.row === fixedRow && e.field === fixedColumn))

      // Recompute summary from what's left
      const invalidRowSet = new Set(remaining.map(e => e.row))
      const invalidCount  = invalidRowSet.size
      const ruleCounts: Record<string, number> = {}
      for (const e of remaining) {
        ruleCounts[e.rule] = (ruleCounts[e.rule] ?? 0) + 1
      }

      setSummary(s => {
        if (!s) return s
        const total = s.total
        return {
          total,
          valid:   total - invalidCount,
          invalid: invalidCount,
          breakdown: Object.entries(ruleCounts).map(([rule, count]) => ({
            rule,
            count,
            pct: total ? Math.round((count / total) * 1000) / 10 : 0,
          })),
        }
      })

      return remaining
    })
    // Note: no background re-validation — that would overwrite the optimistic state.
    // User can click "Run Validation" again to get a full fresh check.
  }

  const severityStyle = (s: string): React.CSSProperties =>
    s === 'error' ? { color: '#f87171' } : { color: '#fbbf24' }
  const severityRowStyle = (s: string): React.CSSProperties =>
    s === 'error'
      ? { background: 'rgba(239,68,68,0.06)' }
      : { background: 'rgba(245,158,11,0.06)' }

  return (
    <div className="space-y-6 fade-in">
      {/* Header */}
      <div>
        <h1 className="page-header">✅ Pre-Migration Validation</h1>
        <p className="mt-1" style={{ color: 'var(--text-secondary)' }}>
          Source data — validate against D365 field rules
        </p>
      </div>

      {/* Info banner */}
      <div
        className="flex items-start gap-3 p-4 rounded-xl"
        style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)' }}
      >
        <ShieldCheck size={18} className="mt-0.5 shrink-0" style={{ color: '#818cf8' }} />
        <p className="text-sm" style={{ color: '#818cf8' }}>
          Validation checks your source data against D365 requirements{' '}
          <strong>before any data moves</strong>. Errors are fixed here — not after migration.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Rules panel */}
        <div className="col-span-1 card p-5 space-y-3 h-fit">
          <h2 className="section-title">Validation Rules</h2>
          {rules.map(r => (
            <div
              key={r.id}
              className="p-3 rounded-lg transition-all"
              style={{
                border: '1px solid var(--border)',
                background: r.on ? 'rgba(99,102,241,0.06)' : 'rgba(255,255,255,0.02)',
              }}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{r.label}</span>
                {!r.canDisable ? (
                  <div
                    className="flex items-center gap-1.5 px-2 py-0.5 rounded text-xs select-none"
                    style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}
                  >
                    <Lock size={10} />
                    <span>locked</span>
                  </div>
                ) : (
                  <button
                    onClick={() => toggleRule(r.id)}
                    className="w-9 h-5 rounded-full transition-all relative"
                    style={{ background: r.on ? '#6366f1' : 'rgba(255,255,255,0.1)' }}
                    aria-label={r.on ? 'Disable rule' : 'Enable rule'}
                  >
                    <div
                      className={`w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all shadow-sm ${
                        r.on ? 'left-4' : 'left-0.5'
                      }`}
                    />
                  </button>
                )}
              </div>
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{r.desc}</p>
            </div>
          ))}
        </div>

        {/* Results area */}
        <div className="col-span-2 space-y-5">
          {/* Run button — with empty state guidance */}
          {!ran && !running && (
            <div className="card p-8 text-center space-y-4">
              <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto"
                style={{ background: 'rgba(99,102,241,0.1)' }}
              >
                <ShieldCheck size={26} style={{ color: '#6366f1' }} />
              </div>
              <div>
                <p className="font-semibold text-sm mb-1" style={{ color: 'var(--text-primary)' }}>
                  No validation results yet
                </p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Run validation to check your source data against D365 field rules before migration
                </p>
              </div>
              <button
                onClick={runValidation}
                className="btn-primary mx-auto flex items-center gap-2"
              >
                <ShieldCheck size={16} /> Run Validation on Source Data
              </button>
            </div>
          )}

          {/* Running spinner — TASK-022: replaced plain text with skeleton-style card */}
          {running && (
            <div className="card p-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#6366f1', borderTopColor: 'transparent' }} />
                <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                  Running validation rules against source data...
                </span>
              </div>
              <ValidationSkeleton />
            </div>
          )}

          {/* API error */}
          {runError && (
            <div
              className="card p-5 text-sm"
              style={{
                color: '#f87171',
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.2)',
              }}
            >
              Validation failed: {runError}
            </div>
          )}

          {/* Results */}
          {ran && validationSummary && (
            <>
              {/* Decision panel */}
              <div
                className="card p-5"
                style={{ border: '1px solid rgba(99,102,241,0.3)', background: 'rgba(99,102,241,0.06)' }}
              >
                <h3 className="font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Validation Summary</h3>
                <div className="grid grid-cols-3 gap-4 mb-4">
                  <div
                    className="text-center p-3 rounded-lg"
                    style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)' }}
                  >
                    <div className="text-2xl font-bold" style={{ color: '#34d399' }}>{validationSummary.valid}</div>
                    <div className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>Valid Records</div>
                  </div>
                  <div
                    className="text-center p-3 rounded-lg"
                    style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}
                  >
                    <div className="text-2xl font-bold" style={{ color: '#f87171' }}>{validationSummary.invalid}</div>
                    <div className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>Invalid Records</div>
                  </div>
                  <div
                    className="text-center p-3 rounded-lg"
                    style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)' }}
                  >
                    <div className="text-2xl font-bold" style={{ color: '#818cf8' }}>
                      {validationSummary.total
                        ? ((validationSummary.valid / validationSummary.total) * 100).toFixed(1)
                        : '0.0'}%
                    </div>
                    <div className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>Pass Rate</div>
                  </div>
                </div>
                <p className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>What would you like to do?</p>
                <div className="flex gap-3">
                  <button
                    onClick={handleFixErrors}
                    disabled={downloading || validationErrors.length === 0}
                    className="flex-1 py-2.5 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50"
                    style={{
                      border: '1px solid rgba(245,158,11,0.4)',
                      background: 'rgba(245,158,11,0.08)',
                      color: '#fbbf24',
                    }}
                  >
                    {downloading ? 'Downloading errors...' : '⬇ Fix Errors and Re-upload'}
                  </button>
                  <button
                    onClick={handleProceedWithValid}
                    className="btn-primary flex-1 py-2.5 text-sm font-semibold"
                  >
                    Proceed with {validationSummary.valid} Valid Records
                  </button>
                </div>
              </div>

              {/* Fix Errors modal */}
              {showFixModal && (
                <div
                  className="fixed inset-0 z-50 flex items-center justify-center"
                  style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
                >
                  <div className="card rounded-2xl p-6 max-w-md w-full mx-4 space-y-4">
                    <div className="flex items-center gap-3">
                      <AlertTriangle size={22} className="shrink-0" style={{ color: '#fbbf24' }} />
                      <h3 className="font-bold text-lg" style={{ color: 'var(--text-primary)' }}>Fix Errors and Re-upload</h3>
                    </div>
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                      The error report Excel file has been downloaded to your <strong>Downloads</strong> folder.
                    </p>
                    <ol className="space-y-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                      <li className="flex gap-2">
                        <span className="font-bold" style={{ color: '#818cf8' }}>1.</span>
                        Open the downloaded <strong style={{ color: 'var(--text-primary)' }}>validation_errors.xlsx</strong> file
                      </li>
                      <li className="flex gap-2">
                        <span className="font-bold" style={{ color: '#818cf8' }}>2.</span>
                        Fix the listed errors in your original source CSV
                      </li>
                      <li className="flex gap-2">
                        <span className="font-bold" style={{ color: '#818cf8' }}>3.</span>
                        Save the corrected CSV file
                      </li>
                      <li className="flex gap-2">
                        <span className="font-bold" style={{ color: '#818cf8' }}>4.</span>
                        Go back to the Upload page and upload the corrected file
                      </li>
                    </ol>
                    <div className="flex gap-3 pt-2">
                      <button
                        onClick={() => { setShowFixModal(false); navigate('/upload') }}
                        className="btn-primary flex-1 py-2.5 text-sm font-semibold"
                      >
                        Go to Upload Page
                      </button>
                      <button
                        onClick={() => setShowFixModal(false)}
                        className="btn-secondary flex-1 py-2.5 text-sm font-semibold"
                      >
                        Stay Here
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Error breakdown */}
              {validationSummary.breakdown.length > 0 && (
                <div className="card overflow-hidden">
                  <div
                    className="px-5 py-3.5"
                    style={{ borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.03)' }}
                  >
                    <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>Error Breakdown by Rule</h3>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      Click "View rows" to filter the table below to that rule
                    </p>
                  </div>
                  <table className="data-table w-full text-sm">
                    <thead>
                      <tr>
                        {['Rule Type', 'Error Count', '% of Total', ''].map(h => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {validationSummary.breakdown.map(b => (
                        <tr
                          key={b.rule}
                          style={activeRuleFilter === b.rule ? { background: 'rgba(99,102,241,0.08)' } : undefined}
                        >
                          <td className="font-medium" style={{ color: 'var(--text-primary)' }}>
                            {b.rule.replace(/_/g, ' ')}
                          </td>
                          <td>
                            <span
                              className="px-2 py-0.5 rounded text-xs font-semibold"
                              style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171' }}
                            >
                              {b.count}
                            </span>
                          </td>
                          <td style={{ color: 'var(--text-secondary)' }}>{b.pct}%</td>
                          <td>
                            <button
                              onClick={() => handleViewRows(b.rule)}
                              className="text-xs font-medium"
                              style={{ color: '#818cf8' }}
                            >
                              View rows ↓
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {activeRuleFilter && (
                    <div
                      className="px-5 py-2 flex items-center justify-between"
                      style={{
                        borderTop: '1px solid rgba(99,102,241,0.2)',
                        background: 'rgba(99,102,241,0.06)',
                      }}
                    >
                      <span className="text-xs" style={{ color: '#818cf8' }}>
                        Showing rows for: <strong>{activeRuleFilter.replace(/_/g, ' ')}</strong>
                      </span>
                      <button
                        onClick={() => setActiveRuleFilter(null)}
                        className="text-xs underline"
                        style={{ color: '#818cf8' }}
                      >
                        Clear filter
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Failed records preview */}
              <div ref={failedRowsRef} className="card overflow-hidden">
                <div
                  className="px-5 py-3.5 flex items-center justify-between"
                  style={{ borderBottom: '1px solid var(--border)', background: 'rgba(255,255,255,0.03)' }}
                >
                  <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                    {activeRuleFilter
                      ? `Rows failing: ${activeRuleFilter.replace(/_/g, ' ')} (${validationErrors.filter(e => e.rule === activeRuleFilter).length} rows)`
                      : `Failed Records (first ${Math.min(validationErrors.length, 10)})`}
                  </h3>
                  <button
                    onClick={handleDownload}
                    disabled={downloading}
                    className="flex items-center gap-1.5 text-xs font-medium disabled:opacity-50"
                    style={{ color: '#818cf8' }}
                  >
                    <Download size={12} />
                    {downloading ? 'Downloading...' : 'Download Full Error Report (Excel)'}
                  </button>
                </div>
                {validationErrors.length === 0 ? (
                  <div className="px-5 py-8 text-center text-sm font-medium" style={{ color: '#34d399' }}>
                    🎉 No validation errors found — all records passed!
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="data-table w-full text-sm">
                      <thead>
                        <tr>
                          {['Row #', 'Field', 'Rule', 'Message', 'Severity', 'AI'].map(h => (
                            <th key={h}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(activeRuleFilter
                          ? validationErrors.filter(e => e.rule === activeRuleFilter)
                          : validationErrors.slice(0, 10)
                        ).map((e, i) => (
                          <tr key={i} style={severityRowStyle(e.severity)}>
                            <td>
                              <span
                                className="font-mono text-xs"
                                style={{ background: 'rgba(99,102,241,0.1)', color: '#818cf8', padding: '2px 6px', borderRadius: 4 }}
                              >
                                {e.row}
                              </span>
                            </td>
                            <td className="font-medium" style={{ color: 'var(--text-primary)' }}>{e.field}</td>
                            <td className="text-xs" style={{ color: 'var(--text-secondary)' }}>{e.rule.replace(/_/g, ' ')}</td>
                            <td className="text-xs max-w-xs truncate" style={{ color: 'var(--text-secondary)' }}>{e.message}</td>
                            <td className="text-xs font-semibold uppercase" style={severityStyle(e.severity)}>
                              {e.severity}
                            </td>
                            <td>
                              <ExplainRowButton
                                rowNumber={e.row}
                                onExplain={rowNum => {
                                  window.dispatchEvent(
                                    new CustomEvent('databridge:explain-row', { detail: { rowNumber: rowNum } })
                                  )
                                }}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Bottom nav */}
      <div className="flex justify-between items-center">
        <button onClick={() => navigate('/mapping')} className="btn-secondary flex items-center gap-2">
          <ChevronLeft size={16} /> Back to Mapping
        </button>

        <div className="flex items-center gap-3">
          {/* AI Assistant toggle — sits left of Proceed button */}
          {ran && (
            <button
              onClick={() => setAgentOpen(o => !o)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all"
              style={{
                background: agentOpen
                  ? 'linear-gradient(135deg,#6366f1,#06b6d4)'
                  : 'rgba(99,102,241,0.1)',
                color: agentOpen ? '#fff' : '#6366f1',
                border: '1px solid rgba(99,102,241,0.3)',
                boxShadow: agentOpen ? '0 4px 14px rgba(99,102,241,0.35)' : 'none',
              }}
            >
              <Bot size={15} />
              AI Assistant
              {(validationSummary?.invalid ?? 0) > 0 && (
                <span
                  className="w-5 h-5 rounded-full flex items-center justify-center text-white text-xs font-bold"
                  style={{ background: '#ef4444', fontSize: '0.6rem' }}
                >
                  {(validationSummary?.invalid ?? 0) > 99 ? '!' : validationSummary?.invalid}
                </span>
              )}
            </button>
          )}

          {ran && (
            <button onClick={handleProceedWithValid} className="btn-primary flex items-center gap-2">
              Proceed to Cleansing <ChevronRight size={16} />
            </button>
          )}
        </div>
      </div>

      {/* AI Validation Agent — controlled open state, never remounted */}
      <ValidationAgent
        invalidCount={validationSummary?.invalid ?? 0}
        externalOpen={agentOpen}
        onOpenChange={setAgentOpen}
        onFixApplied={handleFixApplied}
      />
    </div>
  )
}
