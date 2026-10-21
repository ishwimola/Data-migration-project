import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Download, RotateCcw, CheckCircle } from 'lucide-react'
import {
  PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts'
import MetricCard from '../components/ui/MetricCard'
import { ConfidenceBadge, MethodBadge } from '../components/ui/Badge'
import { api } from '../services/api'
import { useApiData } from '../hooks/useApiData'

export default function Report() {
  const navigate = useNavigate()
  const [downloading, setDownloading] = useState<string | null>(null)

  const { data: reportData,  loading: reportLoading,   error: reportError   } = useApiData(api.getReport)
  const { data: mappings,    loading: mappingsLoading,  error: mappingsError  } = useApiData(api.getMappings)

  if (reportLoading || mappingsLoading) {
    return <div className="card p-6 text-center text-slate-400">Loading report...</div>
  }

  if (reportError || mappingsError || !reportData) {
    return (
      <div className="card p-5 text-sm text-red-600 bg-red-50 border-red-100">
        Unable to load migration report: {reportError ?? mappingsError ?? 'No report data returned'}
      </div>
    )
  }

  const d = reportData
  const pieData = [
    { name: 'Loaded',   value: d.loaded,   color: '#16A34A' },
    { name: 'Failed',   value: d.failed,   color: '#DC2626' },
    { name: 'Excluded', value: d.excluded, color: '#D97706' },
  ]
  const confData = d.confidenceDistribution

  const approvedMappings = (mappings ?? []).filter(m => !m.excluded && m.d365Field !== 'no_match')

  // ── Download helpers ────────────────────────────────────────────────────────

  const downloadBlob = async (
    key: string,
    fetcher: () => Promise<Blob>,
    filename: string,
  ) => {
    setDownloading(key)
    try {
      const blob = await fetcher()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      alert('Download failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setDownloading(null)
    }
  }

  const handleDownloadFullReport = () =>
    downloadBlob(
      'full',
      api.downloadFullReport,
      `DataBridge_Report_${new Date().toISOString().slice(0, 10)}.xlsx`,
    )

  const handleDownloadValidationErrors = () =>
    downloadBlob('validation', api.downloadValidationErrorsExcel, 'validation_errors.xlsx')

  const handleDownloadMigrationErrors = () =>
    downloadBlob('migration', api.downloadMigrationErrorsExcel, 'migration_errors.xlsx')

  const handleDownloadMappingJson = async () => {
    setDownloading('mapping')
    try {
      const data = await api.downloadMappingJson()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = 'mapping_config.json'
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      alert('Download failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setDownloading(null)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-header">📊 Migration Report</h1>
        <p className="text-slate-500 mt-1">Migration completed</p>
      </div>

      {/* Status banner */}
      <div className="p-5 bg-green-50 border-2 border-green-400 rounded-xl flex items-center gap-4">
        <CheckCircle size={28} className="text-green-500 shrink-0" />
        <div>
          <h2 className="text-lg font-bold text-green-800">✅ Migration Completed Successfully</h2>
          <p className="text-green-700 text-sm">
            {d.successRate}% success rate · {d.loaded.toLocaleString()} records loaded to D365
          </p>
        </div>
      </div>

      {/* Metrics row 1 */}
      <div className="grid grid-cols-3 gap-5">
        <MetricCard label="📋 Total Source Records" value={d.totalSource.toLocaleString()} colour="blue"  />
        <MetricCard label="✅ Successfully Loaded"  value={d.loaded.toLocaleString()}       colour="green" />
        <MetricCard label="❌ Failed Records"        value={d.failed}                        colour="red"   />
      </div>
      {/* Metrics row 2 */}
      <div className="grid grid-cols-3 gap-5">
        <MetricCard label="📊 Success Rate"  value={`${d.successRate}%`} colour="green" />
        <MetricCard label="📦 Total Batches" value={d.batches}           colour="blue"  />
        <MetricCard label="⏱ Time Taken"    value={d.timeTaken}         colour="blue"  />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-3 gap-5">
        {/* Donut */}
        <div className="card p-5">
          <h3 className="section-title">Record Outcome</h3>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={pieData}
                cx="50%" cy="50%"
                innerRadius={55} outerRadius={85}
                paddingAngle={3} dataKey="value"
              >
                {pieData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
              </Pie>
              <Tooltip formatter={(v: number) => v.toLocaleString()} />
              <Legend iconType="circle" iconSize={10} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Errors by type */}
        <div className="card p-5">
          <h3 className="section-title">Errors by Type</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={d.errorsByType} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
              <XAxis dataKey="type" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip />
              <Bar dataKey="count" fill="#DC2626" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Confidence distribution */}
        <div className="card p-5">
          <h3 className="section-title">Confidence Distribution</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={confData} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
              <XAxis dataKey="range" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip />
              <Bar dataKey="count" fill="#2563EB" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Mapping summary */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-100 bg-slate-50/50">
          <h3 className="font-semibold text-slate-800 text-sm">Mapping Configuration Used</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100">
                {['Source Column', 'D365 Field', 'API Name', 'Confidence', 'Method'].map(h => (
                  <th key={h} className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {approvedMappings.map(m => (
                <tr key={m.source} className="hover:bg-slate-50/50">
                  <td className="px-5 py-3">
                    <code className="text-xs font-mono bg-slate-100 px-1.5 py-0.5 rounded">{m.source}</code>
                  </td>
                  <td className="px-5 py-3 font-medium text-slate-800">{m.display}</td>
                  <td className="px-5 py-3">
                    <code className="text-xs text-slate-500">{m.d365Field}</code>
                  </td>
                  <td className="px-5 py-3"><ConfidenceBadge score={m.confidence} /></td>
                  <td className="px-5 py-3"><MethodBadge method={m.method} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Export */}
      <div className="card p-5">
        <h3 className="section-title">Export</h3>
        <p className="text-xs text-slate-400 mb-4">
          The full report includes an AI-generated executive summary, KPI dashboard, field mapping config,
          validation errors, and complete audit trail — all in one professional Excel workbook.
        </p>
        <div className="flex gap-3 flex-wrap">
          <button
            onClick={handleDownloadFullReport}
            disabled={downloading === 'full'}
            className="btn-primary flex items-center gap-2 disabled:opacity-50"
          >
            <Download size={14} />
            {downloading === 'full' ? 'Generating report...' : '📊 Download Full Migration Report (Excel)'}
          </button>
          <button
            onClick={handleDownloadValidationErrors}
            disabled={downloading === 'validation'}
            className="btn-secondary flex items-center gap-2 disabled:opacity-50"
          >
            <Download size={14} />
            {downloading === 'validation' ? 'Downloading...' : '📥 Validation Errors (Excel)'}
          </button>
          <button
            onClick={handleDownloadMigrationErrors}
            disabled={downloading === 'migration'}
            className="btn-secondary flex items-center gap-2 disabled:opacity-50"
          >
            <Download size={14} />
            {downloading === 'migration' ? 'Downloading...' : '📥 Migration Errors (Excel)'}
          </button>
          <button
            onClick={handleDownloadMappingJson}
            disabled={downloading === 'mapping'}
            className="btn-secondary flex items-center gap-2 disabled:opacity-50"
          >
            <Download size={14} />
            {downloading === 'mapping' ? 'Downloading...' : '📋 Mapping Config (JSON)'}
          </button>
          {d.failed > 0 && (
            <button
              onClick={() => navigate('/migration')}
              className="btn-secondary flex items-center gap-2 text-red-600 border-red-200 hover:bg-red-50"
            >
              <RotateCcw size={14} /> Retry Failed Records ({d.failed})
            </button>
          )}
        </div>
      </div>

    </div>
  )
}
