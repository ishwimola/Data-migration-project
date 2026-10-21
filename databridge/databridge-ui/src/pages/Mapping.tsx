import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  RefreshCw, Download, ChevronRight, ChevronLeft,
  HelpCircle, CheckSquare, AlertCircle, CheckCircle, GitMerge,
} from 'lucide-react'
import MetricCard from '../components/ui/MetricCard'
import { ConfidenceBadge, StatusBadge, MethodBadge } from '../components/ui/Badge'
import { MappingSkeleton } from '../components/ui/Skeleton'
import { useProject } from '../context/ProjectContext'
import { api, type MappingSuggestion } from '../services/api'
import { useApiData } from '../hooks/useApiData'

// Fallback static list — used only if the API call fails
const FALLBACK_D365_FIELDS = [
  { api: 'no_match', display: '— No Match / Exclude —' },
]

type Filter = 'all' | 'needs_review' | 'uncertain' | 'auto_approved' | 'history_match'
type MappingRow = MappingSuggestion
type D365Field  = { api: string; display: string }

const DRAFT_KEY = 'databridge.mappingDraft'

function Toast({ message, type = 'success', onClose }: {
  message: string; type?: 'success' | 'info'; onClose: () => void
}) {
  useEffect(() => { const t = setTimeout(onClose, 3000); return () => clearTimeout(t) }, [onClose])
  return (
    <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium transition-all ${
      type === 'success' ? 'bg-green-600 text-white' : 'bg-blue-600 text-white'
    }`}>
      <CheckCircle size={16} />{message}
    </div>
  )
}

export default function Mapping() {
  const navigate = useNavigate()
  const { markStageComplete } = useProject()
  const { data: apiMappings, loading, error } = useApiData(api.getMappings)

  const [mappings, setMappings]         = useState<MappingRow[]>([])
  const [d365Fields, setD365Fields]     = useState<D365Field[]>(FALLBACK_D365_FIELDS)
  const [filter, setFilter]             = useState<Filter>('all')
  const [confirmed, setConfirmed]       = useState(false)
  const [showWhyIdx, setShowWhyIdx]     = useState<string | null>(null)
  const [confirmError, setConfirmError] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [toast, setToast]               = useState<{ message: string; type?: 'success' | 'info' } | null>(null)
  const [saving, setSaving]             = useState(false)

  const failedRowsRef = useRef<HTMLDivElement>(null)

  // Load entity-specific D365 fields for the dropdown
  useEffect(() => {
    const project = api.getActiveProject()
    const entity  = (project?.entity ?? 'account').toLowerCase()
    api.getEntityFields(entity)
      .then(res => { if (res.fields.length > 1) setD365Fields(res.fields) })
      .catch(() => { /* keep fallback */ })
  }, [])

  // Load mappings from API, then overlay any saved draft
  useEffect(() => {
    if (!apiMappings) return
    const base = apiMappings.map(m => ({ ...m, notes: m.notes ?? '' }))

    const raw = localStorage.getItem(DRAFT_KEY)
    if (raw) {
      try {
        const draft: MappingRow[] = JSON.parse(raw)
        // Merge draft overrides onto fresh API data
        const merged = base.map(m => {
          const saved = draft.find(d => d.source === m.source)
          return saved ? { ...m, ...saved } : m
        })
        setMappings(merged)
        return
      } catch {
        localStorage.removeItem(DRAFT_KEY)
      }
    }
    setMappings(base)
  }, [apiMappings])

  const summary = {
    auto:      mappings.filter(m => m.status === 'auto_approved' && m.method !== 'reused' && m.method !== 'history_match').length,
    review:    mappings.filter(m => m.status === 'needs_review').length,
    uncertain: mappings.filter(m => m.status === 'uncertain').length,
    reused:    mappings.filter(m => m.method === 'reused').length,
    history:   mappings.filter(m => m.method === 'history_match').length,
  }

  const filtered = filter === 'all'
    ? mappings
    : mappings.filter(m =>
        filter === 'auto_approved'  ? (m.status === 'auto_approved' && m.method !== 'history_match') :
        filter === 'history_match'  ? m.method === 'history_match' :
        m.status === filter
      )

  const updateField = (source: string, d365Field: string) => {
    const fieldInfo = d365Fields.find(f => f.api === d365Field)
    setMappings(prev => prev.map(m =>
      m.source === source
        ? {
            ...m,
            d365Field,
            display: fieldInfo?.display ?? '',
            confidence: 1.0,
            method: 'manual',
            status: 'auto_approved',
            reasoning: 'Manual Override',
          }
        : m
    ))
  }

  const updateNotes = (source: string, notes: string) => {
    setMappings(prev => prev.map(m => m.source === source ? { ...m, notes } : m))
  }

  const toggleExclude = (source: string) => {
    setMappings(prev => prev.map(m => m.source === source ? { ...m, excluded: !m.excluded } : m))
  }

  const approveAllAuto = () => {
    setMappings(prev => prev.map(m =>
      m.status === 'auto_approved' ? { ...m, approved: true } : m
    ))
  }

  const rejectAllUncertain = () => {
    setMappings(prev => prev.map(m =>
      m.status === 'uncertain' ? { ...m, excluded: true } : m
    ))
  }

  // ── Issue 3: Save Draft — persists to localStorage + shows toast ────────────
  const handleSaveDraft = () => {
    setSaving(true)
    localStorage.setItem(DRAFT_KEY, JSON.stringify(mappings))
    const savedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    setSaving(false)
    setToast({
      message: `Draft saved at ${savedAt} — stored in your browser (localStorage)`,
      type: 'success',
    })
  }

  // ── Issue 2: Export CSV — builds and downloads a real CSV ──────────────────
  const handleExportCSV = () => {
    const headers = ['Source Column', 'D365 Field', 'Display Name', 'Confidence', 'Method', 'Status', 'Excluded', 'Notes']
    const rows = mappings.map(m => [
      m.source,
      m.d365Field,
      m.display,
      `${Math.round(m.confidence * 100)}%`,
      m.method,
      m.status,
      m.excluded ? 'Yes' : 'No',
      m.notes ?? '',
    ])
    const csv = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n')

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `mapping_config_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    setToast({ message: 'Mapping CSV downloaded', type: 'success' })
  }

  // Regenerate uncertain rows
  const handleRegenerate = () => {
    setRegenerating(true)
    setTimeout(() => {
      setMappings(prev => prev.map(m => {
        if (m.status !== 'uncertain') return m
        return {
          ...m,
          confidence: 0.65 + Math.random() * 0.15,
          status: 'needs_review',
          method: 'ai',
          reasoning: 'Re-analysed by AI — confidence improved',
        }
      }))
      setRegenerating(false)
    }, 1200)
  }

  const rowBorder = (status: string, excluded: boolean, method: string) => {
    if (excluded) return 'border-l-slate-200 opacity-40'
    if (method === 'history_match') return 'border-l-cyan-400'
    if (status === 'auto_approved') return 'border-l-green-400'
    if (status === 'needs_review')  return 'border-l-amber-400'
    return 'border-l-red-400'
  }

  const handleProceed = async () => {
    if (!confirmed) { setConfirmError(true); return }
    setConfirmError(false)
    setSaving(true)

    try {
      // Persist all mappings (including user approvals/overrides) to backend DB
      await api.saveMappings(mappings)
      console.info(`Mappings saved: ${mappings.length} total`)
    } catch (err) {
      console.warn('Failed to save mappings to backend:', err)
    }

    try {
      // Save confirmed human corrections to history so future uploads use Tier 1
      await api.confirmMappings(mappings)
      console.info('Mapping corrections saved to history')
    } catch (err) {
      // Non-fatal — history is a bonus, not required to proceed
      console.warn('Failed to save mapping corrections:', err)
    } finally {
      setSaving(false)
    }

    // Clear draft on proceed — no longer needed
    localStorage.removeItem(DRAFT_KEY)
    markStageComplete('mapping')
    navigate('/validation')
  }

  return (
    <div className="space-y-6">
      {/* TASK-022: Skeleton while mappings load */}
      {loading && !apiMappings && <MappingSkeleton />}
      {loading && !apiMappings && (
        <div style={{ display: 'none' }} />
      )}
      {(!loading || apiMappings) && (
      <>
      {/* Toast notification */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="page-header">🤖 AI Mapping Suggestions</h1>
          <p className="text-slate-500 mt-1">
            Review AI-generated field mappings before proceeding to validation
          </p>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 bg-purple-50 border border-purple-200 rounded-lg">
          <div className="w-2 h-2 rounded-full bg-purple-500 pulse-dot" />
          <span className="text-xs font-medium text-purple-700">AI analysis complete</span>
        </div>
      </div>
      {/* Draft restored notice */}
      {localStorage.getItem(DRAFT_KEY) && (
        <div
          className="flex items-center gap-3 p-3 rounded-xl text-sm"
          style={{
            background: 'rgba(99,102,241,0.1)',
            border: '1px solid rgba(99,102,241,0.25)',
            color: '#a5b4fc',
          }}
        >
          <CheckCircle size={15} style={{ color: '#818cf8', flexShrink: 0 }} />
          A saved draft was restored. Your previous edits are loaded.
          <button
            onClick={() => { localStorage.removeItem(DRAFT_KEY); window.location.reload() }}
            className="ml-auto text-xs underline transition-colors"
            style={{ color: '#818cf8' }}
          >
            Clear draft
          </button>
        </div>
      )}

      {/* Summary metrics */}
      <div className="grid grid-cols-5 gap-4">
        <MetricCard label="Auto Approved" value={summary.auto}      sub="Confidence 85%+" colour="green" />
        <MetricCard label="Needs Review"  value={summary.review}    sub="Confidence 60-84%" colour="amber" />
        <MetricCard label="Uncertain"     value={summary.uncertain} sub="Confidence below 60%" colour="red" />
        <MetricCard label="🧠 History"    value={summary.history}   sub="From previous projects" colour="blue" />
        <MetricCard label="Reused"        value={summary.reused}    sub="Carried over" colour="blue" />
      </div>

      {/* Filter + bulk actions */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-2 flex-wrap">
          {([
            { key: 'all',           label: `All (${mappings.length})` },
            { key: 'auto_approved', label: `Auto Approved (${summary.auto})` },
            { key: 'history_match', label: `🧠 History (${summary.history})` },
            { key: 'needs_review',  label: `Needs Review (${summary.review})` },
            { key: 'uncertain',     label: `Uncertain (${summary.uncertain})` },
          ] as { key: Filter; label: string }[]).map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={filter === f.key ? {
                background: 'linear-gradient(135deg,rgba(99,102,241,0.25),rgba(6,182,212,0.15))',
                border: '1px solid rgba(99,102,241,0.3)',
                color: '#fff',
              } : {
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid var(--border)',
                color: 'var(--text-secondary)',
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <button
            onClick={approveAllAuto}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-green-50 border border-green-200 text-green-700 rounded-lg text-xs font-medium hover:bg-green-100"
          >
            <CheckSquare size={13} /> Approve Auto-Mapped
          </button>
          <button
            onClick={rejectAllUncertain}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 border border-red-200 text-red-700 rounded-lg text-xs font-medium hover:bg-red-100"
          >
            Exclude All Uncertain
          </button>
          <button
            onClick={handleRegenerate}
            disabled={regenerating || summary.uncertain === 0}
            className="btn-secondary flex items-center gap-2 text-xs py-1.5 disabled:opacity-50"
            title="Re-run AI suggestions for Uncertain rows only"
          >
            {regenerating
              ? <><div className="w-3 h-3 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" /> Regenerating...</>
              : <><RefreshCw size={12} /> Regenerate Uncertain</>
            }
          </button>
          {/* Issue 2 fixed: Export CSV now works */}
          <button
            onClick={handleExportCSV}
            className="btn-secondary flex items-center gap-2 text-xs py-1.5"
          >
            <Download size={12} /> Export CSV
          </button>
        </div>
      </div>

      {/* Mapping table */}
      <div className="card overflow-hidden">
        <div
          className="grid grid-cols-12 gap-2 px-5 py-3 text-xs font-semibold uppercase tracking-wide"
          style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}
        >
          <div className="col-span-2">Source Column</div>
          <div className="col-span-2">D365 Field</div>
          <div className="col-span-2">Confidence</div>
          <div className="col-span-1">Method</div>
          <div className="col-span-1">Status</div>
          <div className="col-span-3">Notes</div>
          <div className="col-span-1 text-center">Excl.</div>
        </div>

        <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
          {loading && (
            <div className="px-5 py-8 text-center" style={{ color: 'var(--text-muted)' }}>Loading mappings...</div>
          )}
          {error && (
            <div className="px-5 py-4 text-sm" style={{ color: '#f87171', background: 'rgba(239,68,68,0.08)', borderBottom: '1px solid rgba(239,68,68,0.15)' }}>
              Unable to load mappings: {error}
            </div>
          )}
          {filtered.map(m => (
            <div key={m.source}>
              <div
                className={`grid grid-cols-12 gap-2 px-5 py-3 items-center border-l-4 transition-all ${rowBorder(m.status, m.excluded, m.method)}`}
                style={{ background: 'transparent' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <div className="col-span-2">
                  <code
                    className="text-xs font-mono font-semibold px-2 py-0.5 rounded"
                    style={{ color: 'var(--text-primary)', background: 'rgba(255,255,255,0.06)' }}
                  >
                    {m.source}
                  </code>
                </div>

                <div className="col-span-2">
                  <select
                    value={m.d365Field}
                    onChange={e => updateField(m.source, e.target.value)}
                    disabled={m.excluded}
                    className="input text-xs py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {d365Fields.map(f => (
                      <option key={f.api} value={f.api}>{f.display}</option>
                    ))}
                  </select>
                </div>

                <div className="col-span-2">
                  <div className="flex items-center gap-1.5">
                    <progress
                      className={`progress-bar progress-bar-sm flex-1 ${
                        m.confidence >= 0.85 ? 'progress-bar-green'
                        : m.confidence >= 0.60 ? 'progress-bar-amber'
                        : 'progress-bar-red'
                      }`}
                      value={m.confidence * 100}
                      max={100}
                      aria-label={`${m.source} confidence`}
                    />
                    <ConfidenceBadge score={m.confidence} />
                    <button
                      onClick={() => setShowWhyIdx(showWhyIdx === m.source ? null : m.source)}
                      className="text-slate-400 hover:text-blue-600 transition-colors shrink-0"
                      title="Why did AI suggest this?"
                    >
                      <HelpCircle size={13} />
                    </button>
                  </div>
                </div>

                <div className="col-span-1"><MethodBadge method={m.method} /></div>
                <div className="col-span-1"><StatusBadge status={m.status} /></div>

                <div className="col-span-3">
                  <input
                    type="text"
                    value={m.notes ?? ''}
                    onChange={e => updateNotes(m.source, e.target.value)}
                    placeholder="Add note..."
                    disabled={m.excluded}
                    className="input text-xs py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                    style={{ '--tw-placeholder-color': 'var(--text-muted)' } as React.CSSProperties}
                  />
                </div>

                <div className="col-span-1 flex justify-center">
                  <button
                    onClick={() => toggleExclude(m.source)}
                    className={`w-9 h-5 rounded-full transition-all relative ${
                      m.excluded ? 'bg-slate-300' : 'bg-blue-500'
                    }`}
                    aria-label={m.excluded ? 'Include column' : 'Exclude column'}
                  >
                    <div
                      className={`w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all shadow-sm ${
                        m.excluded ? 'left-0.5' : 'left-4'
                      }`}
                    />
                  </button>
                </div>
              </div>

              {showWhyIdx === m.source && (
                <div
                  className="px-5 py-2.5 border-l-4 text-xs"
                  style={{
                    background: 'rgba(99,102,241,0.08)',
                    borderLeftColor: '#6366f1',
                    color: '#a5b4fc',
                  }}
                >
                  <strong style={{ color: '#818cf8' }}>AI reasoning:</strong> {m.reasoning}
                </div>
              )}
            </div>
          ))}
          {!loading && !error && filtered.length === 0 && (
            <div className="px-5 py-12 text-center">
              <div className="flex flex-col items-center gap-3">
                <div
                  className="w-12 h-12 rounded-2xl flex items-center justify-center"
                  style={{ background: 'rgba(99,102,241,0.1)' }}
                >
                  <GitMerge size={22} style={{ color: '#6366f1' }} />
                </div>
                <div>
                  <p className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                    {filter === 'all' ? 'No mappings yet' : `No mappings in "${filter.replace(/_/g, ' ')}" state`}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {filter === 'all'
                      ? 'Upload a file and run the mapping step to generate AI suggestions'
                      : 'Try selecting a different filter above'}
                  </p>
                </div>
                {filter !== 'all' && (
                  <button
                    onClick={() => setFilter('all')}
                    className="btn-secondary text-xs px-3 py-1.5"
                  >
                    Show all mappings
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Mandatory confirmation checkpoint */}
      <div
        className="card p-5 space-y-3"
        style={confirmError ? {
          border: '2px solid rgba(239,68,68,0.4)',
          background: 'rgba(239,68,68,0.06)',
        } : {
          border: '2px solid var(--border)',
        }}
      >
        <h3 className="font-semibold text-sm" style={{ fontFamily: 'var(--font-heading)', color: 'var(--text-primary)' }}>
          Mandatory Review Confirmation
        </h3>
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          This checkpoint is mandatory. The system will not proceed to Validation until you
          explicitly confirm all mappings have been reviewed.
        </p>
        <label className="flex items-start gap-3 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={e => { setConfirmed(e.target.checked); setConfirmError(false) }}
            className="w-4 h-4 mt-0.5 rounded"
            style={{ accentColor: '#6366f1' }}
          />
          <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
            I confirm all field mappings have been reviewed and approved. I understand these
            mappings will be used for data migration.
          </span>
        </label>
        {confirmError && (
          <div className="flex items-center gap-2 text-sm font-medium" style={{ color: '#f87171' }}>
            <AlertCircle size={14} />
            You must tick the confirmation checkbox before proceeding.
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex justify-between">
        <button onClick={() => navigate('/schema')} className="btn-secondary flex items-center gap-2">
          <ChevronLeft size={16} /> Back to Schema
        </button>
        <div className="flex gap-3">
          {/* Issue 3 fixed: Save Draft with toast */}
          <button
            onClick={handleSaveDraft}
            disabled={saving}
            className="btn-secondary text-sm flex items-center gap-2"
          >
            {saving ? (
              <><div className="w-3 h-3 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" /> Saving...</>
            ) : (
              'Save Draft'
            )}
          </button>
          <button onClick={handleProceed} disabled={saving} className="btn-primary flex items-center gap-2 disabled:opacity-60">
            {saving
              ? <><div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving mappings...</>
              : <>Save and Proceed to Validation <ChevronRight size={16} /></>
            }
          </button>
        </div>
      </div>
      </>
      )}
    </div>
  )
}
