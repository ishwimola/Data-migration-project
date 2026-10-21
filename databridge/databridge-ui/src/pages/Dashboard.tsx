import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Plus, FolderOpen, TrendingUp, Database, Zap,
  Trash2, AlertTriangle, ArrowRight, Upload,
  GitMerge, BarChart3, Activity, Sparkles,
} from 'lucide-react'
import { api } from '../services/api'
import { useApiData } from '../hooks/useApiData'
import { DashboardSkeleton } from '../components/ui/Skeleton'

// ── Status badge ──────────────────────────────────────────────────────────────
function StatusPill({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    completed:   { bg: '#dcfce7',  color: '#16a34a', label: 'Completed'   },
    in_progress: { bg: '#fef3c7',  color: '#d97706', label: 'In Progress' },
    failed:      { bg: '#fee2e2',  color: '#dc2626', label: 'Failed'      },
    migrating:   { bg: '#ede9fe',  color: '#7c3aed', label: 'Migrating'   },
  }
  const s = map[status?.toLowerCase()] ?? map['in_progress']
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
      style={{ background: s.bg, color: s.color }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.color }} />
      {s.label}
    </span>
  )
}

// ── Metric card ───────────────────────────────────────────────────────────────
function StatCard({
  label, value, sub, icon, gradient,
}: {
  label: string
  value: string | number
  sub: string
  icon: React.ReactNode
  gradient: string
}) {
  return (
    <div className="card p-6 stagger fade-in">
      <div className="flex items-start justify-between mb-4">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center"
          style={{ background: gradient, boxShadow: `0 4px 15px rgba(0,0,0,0.3)` }}
        >
          {icon}
        </div>
        <TrendingUp size={14} style={{ color: 'rgba(255,255,255,0.15)' }} />
      </div>
      <div
        className="text-3xl font-bold mb-1"
        style={{ fontFamily: 'var(--font-heading)', color: 'var(--text-primary)' }}
      >
        {value}
      </div>
      <div className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</div>
      <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{sub}</div>
    </div>
  )
}

// ── Delete modal ──────────────────────────────────────────────────────────────
function DeleteModal({
  count, onConfirm, onCancel, loading,
}: { count: number; onConfirm: () => void; onCancel: () => void; loading: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}>
      <div className="card p-6 max-w-sm w-full mx-4 fade-in-fast" style={{ border: '1px solid rgba(239,68,68,0.2)' }}>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(239,68,68,0.1)' }}>
            <AlertTriangle size={18} style={{ color: '#dc2626' }} />
          </div>
          <div>
            <h3 className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>Delete {count} project{count > 1 ? 's' : ''}?</h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>This cannot be undone.</p>
          </div>
        </div>
        <p className="text-sm mb-5" style={{ color: 'var(--text-secondary)' }}>
          All mappings, validation errors, cleansing steps, audit logs and migration stats will be permanently deleted.
        </p>
        <div className="flex gap-3">
          <button onClick={onCancel} disabled={loading} className="btn-secondary flex-1 justify-center">Cancel</button>
          <button onClick={onConfirm} disabled={loading} className="btn-danger flex-1 justify-center">
            {loading ? (
              <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Deleting…</>
            ) : (
              <><Trash2 size={14} /> Delete</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Quick action card ─────────────────────────────────────────────────────────
function QuickCard({
  icon, title, desc, action, gradient,
}: { icon: React.ReactNode; title: string; desc: string; action: () => void; gradient: string }) {
  return (
    <button
      onClick={action}
      className="card p-5 text-left group w-full fade-in"
      style={{ cursor: 'pointer' }}
    >
      <div
        className="w-10 h-10 rounded-xl flex items-center justify-center mb-4 transition-transform duration-300 group-hover:scale-110"
        style={{ background: gradient }}
      >
        {icon}
      </div>
      <div className="font-semibold text-sm mb-1 transition-colors duration-200 group-hover:text-white" style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-heading)' }}>
        {title}
      </div>
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{desc}</div>
      <div className="flex items-center gap-1 mt-3 text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity duration-200" style={{ color: '#818cf8' }}>
        Open <ArrowRight size={12} />
      </div>
    </button>
  )
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const navigate = useNavigate()
  const { data: projects, loading, error, refetch } = useApiData(api.getProjects)
  const rows = projects ?? []

  const [selected, setSelected]         = useState<Set<string>>(new Set())
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [showBulkModal, setShowBulkModal] = useState(false)
  const [deleting, setDeleting]         = useState(false)

  const completed      = rows.filter(p => p.status === 'completed').length
  const migrated       = rows.reduce((s, p) => s + (p.loadedRecords ?? 0), 0)
  const confRows       = rows.filter(p => p.confidence !== null)
  const avgConf        = confRows.length
    ? confRows.reduce((s, p) => s + (p.confidence ?? 0), 0) / confRows.length
    : 0

  const toggleSelect    = (id: string) => setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const toggleSelectAll = () => setSelected(selected.size === rows.length ? new Set() : new Set(rows.map(p => p.id)))

  const clearActive = (ids: string[]) => {
    const a = api.getActiveProject()
    if (a && ids.includes(a.projectId)) localStorage.removeItem('databridge.activeProject')
  }

  const handleDeleteSingle = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try { await api.deleteProject(deleteTarget); clearActive([deleteTarget]); setDeleteTarget(null); refetch?.() }
    catch { alert('Delete failed.') }
    finally { setDeleting(false) }
  }

  const handleBulkDelete = async () => {
    setDeleting(true)
    try {
      const ids = Array.from(selected)
      await api.bulkDeleteProjects(ids); clearActive(ids); setSelected(new Set()); setShowBulkModal(false); refetch?.()
    } catch { alert('Bulk delete failed.') }
    finally { setDeleting(false) }
  }

  return (
    <div className="space-y-8">
      {/* TASK-022: Show full skeleton layout while projects are loading */}
      {loading && <DashboardSkeleton />}
      {loading && (
        <div style={{ display: 'none' }} />
      )}

      {!loading && (
        <>
      {deleteTarget && <DeleteModal count={1} onConfirm={handleDeleteSingle} onCancel={() => setDeleteTarget(null)} loading={deleting} />}
      {showBulkModal && <DeleteModal count={selected.size} onConfirm={handleBulkDelete} onCancel={() => setShowBulkModal(false)} loading={deleting} />}

      {/* ── Hero header ── */}
      <div className="flex items-start justify-between fade-in">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="badge badge-blue">
              <Activity size={10} /> Live
            </span>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Phase 2 · Batch API enabled</span>
          </div>
          <h1 className="page-header mb-1">
            Welcome to <span className="gradient-text">DataBridge.AI</span>
          </h1>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            AI-powered data migration platform for Microsoft Dynamics 365
          </p>
        </div>
        <button onClick={() => navigate('/sources')} className="btn-primary">
          <Plus size={15} /> New Migration
        </button>
      </div>

      {/* ── Stats ── */}
      <div className="grid grid-cols-4 gap-5 stagger">
        <StatCard
          label="Total Projects" value={loading ? '—' : rows.length}
          sub="All time" gradient="linear-gradient(135deg,#6366f1,#818cf8)"
          icon={<FolderOpen size={18} className="text-white" />}
        />
        <StatCard
          label="Completed" value={loading ? '—' : completed}
          sub="Successfully migrated" gradient="linear-gradient(135deg,#10b981,#34d399)"
          icon={<TrendingUp size={18} className="text-white" />}
        />
        <StatCard
          label="Records Migrated" value={loading ? '—' : migrated.toLocaleString()}
          sub="Across all projects" gradient="linear-gradient(135deg,#06b6d4,#22d3ee)"
          icon={<Database size={18} className="text-white" />}
        />
        <StatCard
          label="Avg Confidence" value={loading ? '—' : `${avgConf.toFixed(1)}%`}
          sub="AI mapping accuracy" gradient="linear-gradient(135deg,#f59e0b,#fbbf24)"
          icon={<Zap size={18} className="text-white" />}
        />
      </div>

      {/* ── Projects table ── */}
      <div className="card fade-in" style={{ overflow: 'hidden' }}>
        {/* Table header */}
        <div
          className="px-6 py-4 flex items-center justify-between"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="flex items-center gap-3">
            <h2 className="font-bold text-sm" style={{ fontFamily: 'var(--font-heading)', color: 'var(--text-primary)' }}>
              Recent Projects
            </h2>
            <span
              className="text-xs px-2 py-0.5 rounded-full font-semibold"
              style={{ background: 'rgba(99,102,241,0.15)', color: '#818cf8' }}
            >
              {rows.length}
            </span>
          </div>
          {selected.size > 0 && (
            <button
              onClick={() => setShowBulkModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
              style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171', border: '1px solid rgba(239,68,68,0.2)' }}
            >
              <Trash2 size={12} /> Delete ({selected.size})
            </button>
          )}
        </div>

        {error && (
          <div className="px-6 py-3 text-sm" style={{ background: 'rgba(239,68,68,0.08)', color: '#f87171', borderBottom: '1px solid rgba(239,68,68,0.15)' }}>
            Unable to load projects: {error}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th className="w-10">
                  <input
                    type="checkbox"
                    checked={rows.length > 0 && selected.size === rows.length}
                    onChange={toggleSelectAll}
                    className="w-3.5 h-3.5 rounded"
                    style={{ accentColor: '#6366f1' }}
                  />
                </th>
                {['Project', 'Client', 'Entity', 'Status', 'Records', 'Loaded', 'Confidence', 'Created', ''].map(h => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={10} className="text-center py-12" style={{ color: 'var(--text-muted)' }}>
                    <div className="flex items-center justify-center gap-2">
                      <div className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#6366f1', borderTopColor: 'transparent' }} />
                      Loading projects…
                    </div>
                  </td>
                </tr>
              )}
              {!loading && rows.map(p => (
                <tr
                  key={p.id}
                  style={selected.has(p.id) ? { background: 'rgba(99,102,241,0.06)' } : {}}
                >
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() => toggleSelect(p.id)}
                      className="w-3.5 h-3.5 rounded"
                      style={{ accentColor: '#6366f1' }}
                    />
                  </td>
                  <td>
                    <span className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{p.name || '—'}</span>
                  </td>
                  <td style={{ color: 'var(--text-secondary)' }}>{p.client}</td>
                  <td>
                    <span
                      className="text-xs px-2 py-0.5 rounded-md font-semibold"
                      style={{ background: 'rgba(6,182,212,0.12)', color: '#0891b2' }}
                    >
                      {p.entity}
                    </span>
                  </td>
                  <td><StatusPill status={p.status} /></td>
                  <td>{p.sourceRecords?.toLocaleString() ?? '—'}</td>
                  <td>{p.loadedRecords?.toLocaleString() ?? '—'}</td>
                  <td>
                    {p.confidence ? (
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-1 rounded-full overflow-hidden" style={{ background: '#e2e8f0' }}>
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${p.confidence}%`,
                              background: p.confidence >= 85
                                ? 'linear-gradient(90deg,#10b981,#34d399)'
                                : p.confidence >= 60
                                ? 'linear-gradient(90deg,#f59e0b,#fbbf24)'
                                : 'linear-gradient(90deg,#ef4444,#f87171)',
                            }}
                          />
                        </div>
                        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{p.confidence}%</span>
                      </div>
                    ) : '—'}
                  </td>
                  <td className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {p.createdAt ? new Date(p.createdAt).toLocaleString('en-GB', {
                      day: '2-digit', month: 'short', year: 'numeric',
                      hour: '2-digit', minute: '2-digit',
                    }) : '—'}
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => navigate(p.status === 'completed' ? '/report' : '/sources')}
                        className="text-xs font-semibold transition-colors flex items-center gap-1"
                        style={{ color: '#818cf8' }}
                      >
                        {p.status === 'completed' ? 'Report' : 'Resume'} <ArrowRight size={11} />
                      </button>
                      <button
                        onClick={() => setDeleteTarget(p.id)}
                        className="transition-colors"
                        style={{ color: 'rgba(255,255,255,0.15)' }}
                        title="Delete"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && !error && rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="text-center py-16" style={{ color: 'var(--text-muted)' }}>
                    <div className="flex flex-col items-center gap-3">
                      <div
                        className="w-12 h-12 rounded-2xl flex items-center justify-center"
                        style={{ background: 'rgba(99,102,241,0.1)' }}
                      >
                        <FolderOpen size={20} style={{ color: '#6366f1' }} />
                      </div>
                      <div>
                        <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>No projects yet</p>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Start your first migration to see it here</p>
                      </div>
                      <button onClick={() => navigate('/sources')} className="btn-primary text-xs px-4 py-2">
                        <Plus size={13} /> New Migration
                      </button>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Quick actions ── */}
      <div>
        <p className="section-title mb-4">Quick Actions</p>
        <div className="grid grid-cols-4 gap-4 stagger">
          <QuickCard
            icon={<Upload size={18} className="text-white" />}
            title="Import Data"
            desc="Upload CSV/Excel or connect a source"
            action={() => navigate('/sources')}
            gradient="linear-gradient(135deg,#6366f1,#818cf8)"
          />
          <QuickCard
            icon={<GitMerge size={18} className="text-white" />}
            title="AI Mapping"
            desc="Review field suggestions"
            action={() => navigate('/mapping')}
            gradient="linear-gradient(135deg,#06b6d4,#22d3ee)"
          />
          <QuickCard
            icon={<Sparkles size={18} className="text-white" />}
            title="Data Cleansing"
            desc="Natural language transforms"
            action={() => navigate('/cleansing')}
            gradient="linear-gradient(135deg,#f59e0b,#fbbf24)"
          />
          <QuickCard
            icon={<BarChart3 size={18} className="text-white" />}
            title="View Reports"
            desc="Migration stats & exports"
            action={() => navigate('/report')}
            gradient="linear-gradient(135deg,#10b981,#34d399)"
          />
        </div>
      </div>
        </>
      )}
    </div>
  )
}
