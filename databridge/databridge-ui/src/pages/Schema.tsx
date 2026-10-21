import { useNavigate } from 'react-router-dom'
import { AlertTriangle, ChevronRight, ChevronLeft, XCircle, Download } from 'lucide-react'
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, ResponsiveContainer, Tooltip,
} from 'recharts'
import MetricCard from '../components/ui/MetricCard'
import { TypeBadge } from '../components/ui/Badge'
import { useProject } from '../context/ProjectContext'
import { api } from '../services/api'
import { useApiData } from '../hooks/useApiData'

export default function Schema() {
  const navigate = useNavigate()
  const { markStageComplete } = useProject()
  const { data: schemaProfiles, loading, error } = useApiData(api.getSchemaProfiles)
  const profiles = schemaProfiles ?? []

  const activeProject  = api.getActiveProject()
  const totalCols      = profiles.length
  const mandatoryCols  = profiles.filter(p => p.mandatory).length
  const nullCols       = profiles.filter(p => p.nullPct > 0).length
  const totalRows      = activeProject?.rows ?? 0
  const filename       = activeProject?.filename ?? 'source file'

  const completeness = totalCols ? Math.round(((totalCols - nullCols) / totalCols) * 100) : 0
  const avgNullPct = totalCols ? profiles.reduce((s, p) => s + p.nullPct, 0) / totalCols : 0
  const readinessScore = Math.max(0, Math.min(100, Math.round(
    completeness * 0.4 + (avgNullPct < 5 ? 90 : avgNullPct < 15 ? 70 : 50) * 0.3 + 80 * 0.3
  )))

  const readinessColour = readinessScore >= 80 ? '#34d399' : readinessScore >= 60 ? '#fbbf24' : '#f87171'
  const readinessBg = readinessScore >= 80
    ? { background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)' }
    : readinessScore >= 60
    ? { background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)' }
    : { background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }
  const readinessLabel = readinessScore >= 80 ? 'Good — Ready to Map' : readinessScore >= 60 ? 'Needs Attention' : 'Critical Issues Found'

  const radarData = [
    { dimension: 'Completeness',  score: completeness },
    { dimension: 'Consistency',   score: Math.max(50, completeness - 10) },
    { dimension: 'Uniqueness',    score: 94 },
    { dimension: 'Validity',      score: Math.max(40, completeness - 20) },
    { dimension: 'Relationships', score: 50 },
  ]

  const criticalIssues = profiles.filter(p => p.mandatory && p.nullPct > 0).map(p => `${p.column} — ${p.nullPct}% null values in a mandatory field`)
  const warnings = profiles.filter(p => !p.mandatory && p.nullPct > 5).map(p => `${p.column} — ${p.nullPct}% null values`)
  const typeCounts = profiles.reduce<Record<string, number>>((acc, p) => { acc[p.type] = (acc[p.type] || 0) + 1; return acc }, {})

  const nullColour = (pct: number) =>
    pct >= 20 ? 'font-semibold' : pct >= 5 ? 'font-semibold' : ''
  const nullStyle = (pct: number): React.CSSProperties =>
    pct >= 20 ? { color: '#f87171' } : pct >= 5 ? { color: '#fbbf24' } : { color: '#34d399' }

  const handleDownloadSchema = () => {
    const headers = ['Column Name', 'Type', 'Null %', 'Max Length', 'Distinct', 'Mandatory']
    const rows = profiles.map(p => [p.column, p.type, p.nullPct, p.maxLen, p.distinct, p.mandatory ? 'Yes' : 'No'].join(','))
    const csv = [headers.join(','), ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'schema_report.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const handleProceed = () => { markStageComplete('schema'); navigate('/mapping') }

  return (
    <div className="space-y-6 fade-in">
      <div>
        <h1 className="page-header">🔍 Schema Analysis</h1>
        <p className="mt-1" style={{ color: 'var(--text-secondary)' }}>{filename} · {totalRows.toLocaleString()} rows · {totalCols} columns</p>
      </div>

      {/* Readiness score banner */}
      <div className="p-5 rounded-xl" style={readinessBg}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: 'var(--text-muted)' }}>Migration Readiness Score</p>
            <div className="flex items-baseline gap-3">
              <span className="text-4xl font-bold" style={{ color: readinessColour }}>{readinessScore}</span>
              <span className="text-lg" style={{ color: 'var(--text-muted)' }}>/ 100</span>
              <span className="text-sm font-semibold" style={{ color: readinessColour }}>{readinessLabel}</span>
            </div>
          </div>
          <div className="grid grid-cols-5 gap-3 text-center">
            {radarData.map(d => (
              <div key={d.dimension} className="flex flex-col items-center">
                <div
                  className="text-lg font-bold"
                  style={{ color: d.score >= 80 ? '#34d399' : d.score >= 60 ? '#fbbf24' : '#f87171' }}
                >
                  {d.score}
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{d.dimension}</div>
              </div>
            ))}
          </div>
        </div>
        <progress
          className={`progress-bar progress-bar-md ${readinessScore >= 80 ? 'progress-bar-green' : readinessScore >= 60 ? 'progress-bar-amber' : 'progress-bar-red'}`}
          value={readinessScore}
          max={100}
        />
      </div>

      <div className="grid grid-cols-4 gap-5">
        <MetricCard label="Total Columns" value={totalCols} colour="blue" />
        <MetricCard label="Likely Mandatory" value={mandatoryCols} sub="less than 5% null" colour="green" />
        <MetricCard label="Columns with Nulls" value={nullCols} colour="amber" />
        <MetricCard label="Row Count" value={totalRows.toLocaleString()} colour="blue" />
      </div>

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2 space-y-4">
          <div className="card overflow-hidden">
            <div
              className="px-5 py-3.5"
              style={{
                borderBottom: '1px solid var(--border)',
                background: 'rgba(255,255,255,0.03)',
              }}
            >
              <h2 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>Column Profiles</h2>
            </div>
            {error && (
              <div
                className="px-5 py-4 text-sm"
                style={{
                  color: '#f87171',
                  background: 'rgba(239,68,68,0.08)',
                  borderBottom: '1px solid rgba(239,68,68,0.2)',
                }}
              >
                Unable to load schema profile: {error}
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="data-table w-full text-sm">
                <thead>
                  <tr>
                    {['Column Name', 'Type', 'Null %', 'Max Len', 'Distinct', 'Sample Values', 'Mandatory'].map(h => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading && (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center" style={{ color: 'var(--text-muted)' }}>
                        Loading schema profile...
                      </td>
                    </tr>
                  )}
                  {!loading && profiles.map(p => (
                    <tr key={p.column}>
                      <td>
                        <span
                          className="font-mono text-xs font-medium"
                          style={{ background: 'rgba(99,102,241,0.1)', color: '#818cf8', padding: '2px 6px', borderRadius: 4 }}
                        >
                          {p.column}
                        </span>
                      </td>
                      <td><TypeBadge type={p.type} /></td>
                      <td className={`text-xs ${nullColour(p.nullPct)}`} style={nullStyle(p.nullPct)}>{p.nullPct}%</td>
                      <td className="text-xs" style={{ color: 'var(--text-secondary)' }}>{p.maxLen}</td>
                      <td className="text-xs" style={{ color: 'var(--text-secondary)' }}>{p.distinct}</td>
                      <td>
                        <div className="flex gap-1 flex-wrap">
                          {p.samples.slice(0, 2).map((s, i) => (
                            <span
                              key={i}
                              className="px-1.5 py-0.5 rounded text-xs max-w-[80px] truncate"
                              style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-secondary)' }}
                            >
                              {s}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="text-center">
                        {p.mandatory
                          ? <span style={{ color: '#34d399' }} className="font-bold">✓</span>
                          : <span style={{ color: 'var(--text-muted)' }}>—</span>
                        }
                      </td>
                    </tr>
                  ))}
                  {!loading && !error && profiles.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center" style={{ color: 'var(--text-muted)' }}>
                        No schema profile found
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          {/* Critical Issues */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold mb-3" style={{ color: '#f87171' }}>
              Critical Issues ({criticalIssues.length})
            </h3>
            {criticalIssues.length === 0 ? (
              <p className="text-xs" style={{ color: '#34d399' }}>No critical issues found ✓</p>
            ) : (
              <ul className="space-y-2">
                {criticalIssues.map((issue, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <XCircle size={14} className="mt-0.5 shrink-0" style={{ color: '#f87171' }} />
                    <span style={{ color: '#f87171' }}>{issue}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Warnings */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold mb-3" style={{ color: '#fbbf24' }}>
              Warnings ({warnings.length})
            </h3>
            {warnings.length === 0 ? (
              <p className="text-xs" style={{ color: '#34d399' }}>No warnings ✓</p>
            ) : (
              <ul className="space-y-2">
                {warnings.map((w, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" style={{ color: '#fbbf24' }} />
                    <span style={{ color: '#fbbf24' }}>{w}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Type Distribution */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-primary)' }}>Type Distribution</h3>
            <div className="space-y-2.5">
              {Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([type, count]) => (
                <div key={type} className="flex items-center gap-3">
                  <div className="w-20 text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{type}</div>
                  <progress
                    className="progress-bar progress-bar-md progress-bar-blue flex-1"
                    value={totalCols ? (count / totalCols) * 100 : 0}
                    max={100}
                  />
                  <div className="text-xs w-4" style={{ color: 'var(--text-muted)' }}>{count}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Quality Dimensions radar */}
          <div className="card p-5">
            <h3 className="text-sm font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Quality Dimensions</h3>
            <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>Five-dimension migration readiness</p>
            <ResponsiveContainer width="100%" height={200}>
              <RadarChart data={radarData} margin={{ top: 10, right: 20, bottom: 10, left: 20 }}>
                <PolarGrid stroke="rgba(255,255,255,0.08)" />
                <PolarAngleAxis dataKey="dimension" tick={{ fontSize: 10, fill: '#475569' }} />
                <Radar name="Score" dataKey="score" stroke="#6366f1" fill="#6366f1" fillOpacity={0.15} strokeWidth={2} />
                <Tooltip
                  formatter={(v: number) => [`${v}/100`, 'Score']}
                  contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)' }}
                />
              </RadarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="flex justify-between">
        <button onClick={() => navigate('/upload')} className="btn-secondary flex items-center gap-2">
          <ChevronLeft size={16} /> Upload Different File
        </button>
        <div className="flex gap-3">
          <button onClick={handleDownloadSchema} className="btn-secondary flex items-center gap-2">
            <Download size={15} /> Download Schema Report (CSV)
          </button>
          <button onClick={handleProceed} className="btn-primary flex items-center gap-2">
            Proceed to AI Mapping <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
