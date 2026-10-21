import { useState } from 'react'
import { ScrollText, CheckCircle, XCircle, AlertTriangle, Filter, RefreshCw } from 'lucide-react'
import { api } from '../services/api'
import { useApiData } from '../hooks/useApiData'
import type { AuditEntry } from '../services/api'

type StatusFilter = 'all' | 'Success' | 'Warning' | 'Failed'

export default function AuditLog() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [search, setSearch]             = useState('')
  const [refreshKey, setRefreshKey]     = useState(0)

  const { data: auditEntries, loading, error } = useApiData(
    api.getAuditEntries,
    [refreshKey],
  )
  const entries: AuditEntry[] = auditEntries ?? []

  const filtered = entries.filter(e => {
    const matchStatus = statusFilter === 'all' || e.status === statusFilter
    const matchSearch =
      search === '' ||
      e.action.toLowerCase().includes(search.toLowerCase()) ||
      e.details.toLowerCase().includes(search.toLowerCase())
    return matchStatus && matchSearch
  })

  const statusIcon = (s: string) => {
    if (s === 'Success') return <CheckCircle  size={15} style={{ color: '#34d399' }} />
    if (s === 'Warning') return <AlertTriangle size={15} style={{ color: '#fbbf24' }} />
    return <XCircle size={15} style={{ color: '#f87171' }} />
  }

  const statusBadgeStyle = (s: string): React.CSSProperties => {
    if (s === 'Success') return { background: 'rgba(16,185,129,0.12)',  color: '#34d399', border: '1px solid rgba(16,185,129,0.25)' }
    if (s === 'Warning') return { background: 'rgba(245,158,11,0.12)',  color: '#fbbf24', border: '1px solid rgba(245,158,11,0.25)' }
    return                      { background: 'rgba(239,68,68,0.12)',   color: '#f87171', border: '1px solid rgba(239,68,68,0.25)' }
  }

  const counts = {
    success: entries.filter(e => e.status === 'Success').length,
    warning: entries.filter(e => e.status === 'Warning').length,
    failed:  entries.filter(e => e.status === 'Failed').length,
  }

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between fade-in">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: 'linear-gradient(135deg,#6366f1,#818cf8)', boxShadow: '0 4px 12px rgba(99,102,241,0.3)' }}
          >
            <ScrollText size={18} className="text-white" />
          </div>
          <div>
            <h1 className="page-header">📋 Audit Log</h1>
            <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>
              Complete trail of all actions taken in this project
            </p>
          </div>
        </div>
        <button
          onClick={() => setRefreshKey(k => k + 1)}
          disabled={loading}
          className="btn-secondary flex items-center gap-1.5 text-xs py-1.5"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-5 stagger">
        <div className="card p-5 flex items-center gap-4 fade-in">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: 'rgba(16,185,129,0.15)' }}
          >
            <CheckCircle size={18} style={{ color: '#34d399' }} />
          </div>
          <div>
            <div
              className="text-2xl font-bold"
              style={{ fontFamily: 'var(--font-heading)', color: '#34d399' }}
            >
              {counts.success}
            </div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Successful Actions</div>
          </div>
        </div>

        <div className="card p-5 flex items-center gap-4 fade-in">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: 'rgba(245,158,11,0.15)' }}
          >
            <AlertTriangle size={18} style={{ color: '#fbbf24' }} />
          </div>
          <div>
            <div
              className="text-2xl font-bold"
              style={{ fontFamily: 'var(--font-heading)', color: '#fbbf24' }}
            >
              {counts.warning}
            </div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Warnings</div>
          </div>
        </div>

        <div className="card p-5 flex items-center gap-4 fade-in">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: 'rgba(239,68,68,0.15)' }}
          >
            <XCircle size={18} style={{ color: '#f87171' }} />
          </div>
          <div>
            <div
              className="text-2xl font-bold"
              style={{ fontFamily: 'var(--font-heading)', color: '#f87171' }}
            >
              {counts.failed}
            </div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Failed Actions</div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap fade-in">
        <div className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--text-muted)' }}>
          <Filter size={14} />
          <span>Filter:</span>
        </div>
        {(['all', 'Success', 'Warning', 'Failed'] as StatusFilter[]).map(f => (
          <button
            key={f}
            onClick={() => setStatusFilter(f)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
            style={statusFilter === f ? {
              background: 'linear-gradient(135deg,rgba(99,102,241,0.25),rgba(6,182,212,0.15))',
              border: '1px solid rgba(99,102,241,0.3)',
              color: '#fff',
            } : {
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid var(--border)',
              color: 'var(--text-secondary)',
            }}
          >
            {f === 'all' ? `All (${entries.length})` : f}
          </button>
        ))}
        <input
          className="input ml-auto text-sm py-1.5"
          style={{ maxWidth: '14rem' }}
          placeholder="Search actions..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* Audit table */}
      <div className="card overflow-hidden fade-in">
        {error && (
          <div
            className="px-5 py-3 text-sm"
            style={{
              background: 'rgba(239,68,68,0.08)',
              color: '#f87171',
              borderBottom: '1px solid rgba(239,68,68,0.15)',
            }}
          >
            Unable to load audit entries: {error}
          </div>
        )}

        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {['Timestamp', 'Action', 'Status', 'Details'].map(h => (
                <th
                  key={h}
                  className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wide"
                  style={{ color: 'var(--text-muted)', background: 'rgba(255,255,255,0.02)' }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={4} className="px-5 py-10 text-center" style={{ color: 'var(--text-muted)' }}>
                  <div className="flex items-center justify-center gap-2">
                    <div
                      className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
                      style={{ borderColor: '#6366f1', borderTopColor: 'transparent' }}
                    />
                    Loading audit entries…
                  </div>
                </td>
              </tr>
            )}
            {!loading && filtered.map((e, idx) => (
              <tr
                key={e.id ?? idx}
                className="transition-colors"
                style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}
                onMouseEnter={ev => (ev.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}
              >
                <td className="px-5 py-3.5 font-mono text-xs whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                  {e.timestamp}
                </td>
                <td className="px-5 py-3.5 font-medium text-sm" style={{ color: 'var(--text-primary)' }}>
                  {e.action}
                </td>
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-1.5">
                    {statusIcon(e.status)}
                    <span
                      className="px-2 py-0.5 rounded-full text-xs font-semibold"
                      style={statusBadgeStyle(e.status)}
                    >
                      {e.status}
                    </span>
                  </div>
                </td>
                <td className="px-5 py-3.5 text-xs max-w-xs truncate" style={{ color: 'var(--text-secondary)' }}>
                  {e.details}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {filtered.length === 0 && !loading && (
          <div className="py-16 text-center" style={{ color: 'var(--text-muted)' }}>
            <ScrollText size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">No audit entries match your filter</p>
          </div>
        )}
      </div>

      <p className="text-xs text-center" style={{ color: 'var(--text-muted)' }}>
        {filtered.length} of {entries.length} entries shown — All times are local
      </p>
    </div>
  )
}
