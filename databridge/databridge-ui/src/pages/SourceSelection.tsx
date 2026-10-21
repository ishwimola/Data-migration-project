import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Database, FileText, Cloud, Server,
  Link as LinkIcon, CheckCircle, CheckCircle2, AlertCircle, Loader2,
  Zap, ChevronRight, Upload as UploadIcon, FileSpreadsheet, Sparkles,
} from 'lucide-react'
import StepProgress from '../components/ui/StepProgress'
import { useProject } from '../context/ProjectContext'
import { api } from '../services/api'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8001'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Source {
  name: string
  category: string
  description: string
  connector: string
  fields: string[]
  optional: string[]
  default_streams: string[]
}

interface UploadRecord {
  name: string; size: string; time: string; status: 'Success' | 'Failed' | 'Uploading'
}

const DIRECT_DB = new Set(['MySQL', 'PostgreSQL', 'Microsoft SQL Server'])

type Tab = 'connect' | 'upload'

// ── Helpers ───────────────────────────────────────────────────────────────────

function CategoryIcon({ category }: { category: string }) {
  const cls = 'w-5 h-5 text-white'
  switch (category.toLowerCase()) {
    case 'database':   return <Database className={cls} />
    case 'crm':        return <Server className={cls} />
    case 'file':       return <FileText className={cls} />
    case 'payments':
    case 'e-commerce': return <Cloud className={cls} />
    default:           return <LinkIcon className={cls} />
  }
}

function categoryGradient(category: string): string {
  switch (category.toLowerCase()) {
    case 'database':   return 'linear-gradient(135deg,#6366f1,#818cf8)'
    case 'crm':        return 'linear-gradient(135deg,#06b6d4,#22d3ee)'
    case 'file':       return 'linear-gradient(135deg,#10b981,#34d399)'
    case 'payments':   return 'linear-gradient(135deg,#f59e0b,#fbbf24)'
    case 'e-commerce': return 'linear-gradient(135deg,#ec4899,#f472b6)'
    default:           return 'linear-gradient(135deg,#475569,#64748b)'
  }
}

// ── Main component ────────────────────────────────────────────────────────────

const SourceSelection: React.FC = () => {
  const navigate = useNavigate()
  const { setProject, setStage, markStageComplete, resetPipeline } = useProject()

  const [activeTab, setActiveTab] = useState<Tab>('connect')

  // ── Connect tab state ──────────────────────────────────────────────────────
  const [sources, setSources]               = useState<Source[]>([])
  const [pyairbyteReady, setPyairbyteReady] = useState<boolean | null>(null)
  const [selectedSource, setSelectedSource] = useState<Source | null>(null)
  const [config, setConfig]                 = useState<Record<string, string>>({})
  const [stream, setStream]                 = useState('')
  const [availableStreams, setAvailableStreams] = useState<string[]>([])
  const [streamsLive, setStreamsLive]        = useState(false)  // true = from live API, false = static defaults
  const [loadingStreams, setLoadingStreams]  = useState(false)
  const [connecting, setConnecting]         = useState(false)
  const [connectError, setConnectError]     = useState('')

  // ── Upload tab state ───────────────────────────────────────────────────────
  const [projectName, setProjectName]   = useState('')
  const [clientName, setClientName]     = useState('')
  const [entity, setEntity]             = useState('account')
  const [dragOver, setDragOver]         = useState(false)
  const [uploadedFile, setUploadedFile] = useState<File | null>(null)
  const [uploading, setUploading]       = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadLog, setUploadLog]       = useState<UploadRecord[]>([])
  const [uploadErrors, setUploadErrors] = useState<string[]>([])

  const entityMap: Record<string, string> = {
    account: 'Account', contact: 'Contact', lead: 'Lead', opportunity: 'Opportunity',
  }

  useEffect(() => {
    fetchSources()
    checkHealth()
  }, [])

  // ── Connect helpers ────────────────────────────────────────────────────────

  async function checkHealth() {
    try {
      const res = await fetch(`${API_BASE}/api/airbyte/health`)
      const data = await res.json()
      // available=true if either gspread or pyairbyte is ready
      setPyairbyteReady(data.available === true)
    } catch { setPyairbyteReady(false) }
  }

  async function fetchSources() {
    try {
      const res = await fetch(`${API_BASE}/api/airbyte/sources/popular`)
      const data = await res.json()
      setSources(data.sources ?? [])
    } catch { setSources([]) }
  }

  async function discoverStreams() {
    if (!selectedSource) return
    setLoadingStreams(true)
    setConnectError('')
    try {
      // Strip UI metadata fields from config before sending to connector
      const { project_name, client_name, target_entity, table_name, ...connectorConfig } = config
      
      const res = await fetch(`${API_BASE}/api/airbyte/sources/streams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_name: selectedSource.name, config: connectorConfig }),
      })
      const data = await res.json()
      // Backend always returns streams (static or live) — only throw on actual 4xx with no streams
      if (!res.ok && !data.streams?.length) {
        throw new Error(data.detail ?? 'Failed to discover streams')
      }
      const streams: string[] = data.streams ?? []
      setAvailableStreams(streams)
      setStreamsLive(data.live === true)
      if (streams.length === 1) setStream(streams[0])
    } catch (e: unknown) {
      setConnectError(e instanceof Error ? e.message : 'Unknown error discovering streams')
    } finally { setLoadingStreams(false) }
  }

  // Pre-populate streams from static defaults when source is selected
  function handleSelectSource(source: Source) {
    setSelectedSource(source)
    setConfig({})
    setStream('')
    setConnectError('')
    setStreamsLive(false)
    // Show default_streams immediately — no API call needed
    if (source.default_streams && source.default_streams.length > 0) {
      setAvailableStreams(source.default_streams)
      if (source.default_streams.length === 1) setStream(source.default_streams[0])
    } else {
      setAvailableStreams([])
    }
  }

  async function handleConnect() {
    if (!selectedSource) return
    setConnecting(true)
    setConnectError('')
    try {
      let projectId: string
      let rows = 0

      // Strip UI metadata fields from config before sending to connector
      const { project_name, client_name, target_entity, table_name, ...connectorConfig } = config

      if (DIRECT_DB.has(selectedSource.name)) {
        // Send raw credentials as JSON to /api/airbyte/connect
        // The backend assembles the connection string — never expose it to the browser
        const res = await fetch(`${API_BASE}/api/airbyte/connect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source_name:   selectedSource.name,
            config:        connectorConfig,
            stream:        table_name ?? stream,
            project_name:  project_name ?? '',
            client_name:   client_name  ?? 'Demo Client',
            target_entity: target_entity ?? 'account',
          }),
        })
        if (!res.ok) { const e = await res.json(); throw new Error(e.detail ?? 'Import failed') }
        const data = await res.json()
        projectId = data.project_id
        rows = data.rows ?? 0
      } else {
        const res = await fetch(`${API_BASE}/api/airbyte/connect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source_name: selectedSource.name,
            config: connectorConfig,
            stream,
            project_name: project_name ?? '',
            client_name: client_name ?? 'Demo Client',
            target_entity: target_entity ?? 'account',
          }),
        })
        if (!res.ok) { const e = await res.json(); throw new Error(e.detail ?? 'Import failed') }
        const data = await res.json()
        projectId = data.project_id
        rows = data.rows ?? 0
      }

      // ── Write a minimal active-project state so every downstream page
      //    (Schema, Mapping, Validation…) can resolve the project ────────────
      const projectName = project_name?.trim() || `${selectedSource.name} — ${stream || table_name || 'import'}`
      const clientName  = client_name?.trim()  || 'Demo Client'
      const entity      = target_entity        || 'account'

      const activeProject = {
        projectId,
        tableName:     'raw_data',
        filename:      projectName,
        rows,
        columns:       [],
        schemaProfile: [],          // Schema page fetches fresh from /api/projects/{id}/schema
        mappings:      [],          // Mapping page fetches after process-job below
        projectName,
        clientName,
        entity,
        auditEntries: [{
          id: Date.now(),
          timestamp: new Date().toLocaleString(),
          user: 'Current User',
          action: 'Source connected',
          status: 'Success',
          details: `${selectedSource.name} connected — ${rows} rows imported`,
        }],
        createdAt: new Date().toISOString(),
        source: selectedSource.name,
      }
      localStorage.setItem('databridge.activeProject', JSON.stringify(activeProject))

      // ── Run AI mapping (same as upload flow's process-job) ─────────────────
      try {
        const processRes = await fetch(`${API_BASE}/api/process-job`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: projectId, table_name: 'raw_data' }),
        })
        if (processRes.ok) {
          const processData = await processRes.json()
          // Save mapping results so the Mapping page can display them immediately
          const updatedProject = JSON.parse(localStorage.getItem('databridge.activeProject') || '{}')
          if (processData.mapping_results?.mappings) {
            updatedProject.mappings = processData.mapping_results.mappings
          }
          localStorage.setItem('databridge.activeProject', JSON.stringify(updatedProject))
        }
      } catch {
        // Non-fatal — Mapping page will show empty and user can re-trigger
      }

      resetPipeline()
      setProject(projectName, clientName, entity)
      markStageComplete('upload')
      navigate('/schema')
    } catch (e: unknown) {
      setConnectError(e instanceof Error ? e.message : 'Unknown error')
    } finally { setConnecting(false) }
  }

  // ── Upload helpers ─────────────────────────────────────────────────────────

  const handleFileSelect = (f: File) => {
    const ext = f.name.split('.').pop()?.toLowerCase()
    if (!['csv', 'xlsx', 'xls'].includes(ext ?? '')) {
      setUploadErrors(['Only CSV and Excel (.xlsx / .xls) files are supported.'])
      return
    }
    if (f.size / 1024 / 1024 > 30) {
      setUploadErrors([`File size ${(f.size / 1024 / 1024).toFixed(1)} MB exceeds the 30 MB limit.`])
      return
    }
    setUploadErrors([])
    setUploadedFile(f)
  }

  const handleUploadSubmit = async () => {
    const errs: string[] = []
    if (!projectName.trim()) errs.push('Project Name is required')
    if (!clientName.trim())  errs.push('Client Name is required')
    if (!uploadedFile)       errs.push('Please select a file')
    if (errs.length) { setUploadErrors(errs); return }

    setUploadErrors([])
    setUploading(true)
    setUploadProgress(0)
    resetPipeline()

    const sizeMB = (uploadedFile!.size / 1024 / 1024).toFixed(1)
    const now    = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    setUploadLog([{ name: uploadedFile!.name, size: `${sizeMB} MB`, time: now, status: 'Uploading' }])

    try {
      setUploadProgress(20)
      await api.uploadFile(uploadedFile!, {
        projectName: projectName.trim(),
        clientName:  clientName.trim(),
        entity:      entityMap[entity],
      })
      setUploadProgress(50)

      let fakeP = 50
      const ticker = setInterval(() => { fakeP = Math.min(fakeP + 3, 90); setUploadProgress(fakeP) }, 800)
      await api.processJob()
      clearInterval(ticker)

      setUploadProgress(100)
      setUploadLog([{ name: uploadedFile!.name, size: `${sizeMB} MB`, time: now, status: 'Success' }])
      setProject(projectName.trim(), clientName.trim(), entityMap[entity])
      setStage('schema')
      markStageComplete('upload')
      setTimeout(() => { setUploading(false); navigate('/schema') }, 600)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed'
      setUploadErrors([msg])
      setUploadLog([{ name: uploadedFile!.name, size: `${sizeMB} MB`, time: now, status: 'Failed' }])
      setUploading(false)
      setUploadProgress(0)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6 fade-in">

      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="badge badge-blue"><UploadIcon size={10} /> Step 1 of 7</span>
          <span className="badge badge-cyan" style={{ fontSize: '0.65rem' }}><Zap size={9} /> PyAirbyte</span>
        </div>
        <h1 className="page-header">Import Your Data</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
          Upload a file or connect directly to a database, CRM, or SaaS tool
        </p>
      </div>

      <StepProgress current={0} />

      {/* ── Tab switcher ── */}
      <div
        className="flex gap-1 p-1 rounded-xl w-fit"
        style={{ background: '#f1f5f9', border: '1px solid #e2e8f0' }}
      >
        {([
          { key: 'upload',  label: '📁 Upload File',      icon: <UploadIcon size={14} /> },
          { key: 'connect', label: '🔌 Connect a Source', icon: <LinkIcon size={14} /> },
        ] as { key: Tab; label: string; icon: React.ReactNode }[]).map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-200"
            style={activeTab === tab.key ? {
              background: 'linear-gradient(135deg,#6366f1,#06b6d4)',
              color: '#fff',
              boxShadow: '0 2px 8px rgba(99,102,241,0.3)',
            } : {
              color: '#64748b',
              background: 'transparent',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          UPLOAD TAB
      ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'upload' && (
        <div className="grid grid-cols-3 gap-6">
          {/* Main form */}
          <div className="col-span-2 space-y-5">

            {/* Errors */}
            {uploadErrors.length > 0 && (
              <div className="p-4 rounded-xl flex items-start gap-3 fade-in-fast"
                style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
                <AlertCircle size={16} style={{ color: '#ef4444', marginTop: 2, flexShrink: 0 }} />
                <div className="space-y-1">
                  {uploadErrors.map((e, i) => (
                    <p key={i} className="text-sm font-medium" style={{ color: '#ef4444' }}>{e}</p>
                  ))}
                </div>
              </div>
            )}

            {/* Project details */}
            <div className="card p-6 space-y-4">
              <h2 className="section-title">Project Details</h2>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Project Name *</label>
                  <input className="input" placeholder="e.g. Contoso — Account Migration"
                    value={projectName} onChange={e => setProjectName(e.target.value)} />
                </div>
                <div>
                  <label className="label">Client Name *</label>
                  <input className="input" placeholder="e.g. Contoso Ltd"
                    value={clientName} onChange={e => setClientName(e.target.value)} />
                </div>
              </div>
              <div>
                <label className="label">Target D365 Entity *</label>
                <select className="input" value={entity} onChange={e => setEntity(e.target.value)}>
                  <option value="account">Account (Company / Organisation)</option>
                  <option value="contact">Contact (Individual Person)</option>
                  <option value="lead">Lead (Sales Prospect)</option>
                  <option value="opportunity">Opportunity</option>
                </select>
              </div>
            </div>

            {/* Drop zone */}
            <div className="card p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="section-title" style={{ marginBottom: 0 }}>Source File</h2>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>CSV · Excel (.xlsx / .xls) · Max 30 MB</span>
              </div>
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFileSelect(f) }}
                onClick={() => document.getElementById('fileInput')?.click()}
                className="rounded-xl p-10 text-center cursor-pointer transition-all duration-300"
                style={{
                  border: `2px dashed ${dragOver ? '#6366f1' : uploadedFile ? '#10b981' : '#e2e8f0'}`,
                  background: dragOver ? 'rgba(99,102,241,0.04)' : uploadedFile ? 'rgba(16,185,129,0.04)' : '#fafafa',
                }}
              >
                <input id="fileInput" type="file" accept=".csv,.xlsx,.xls" className="hidden"
                  onChange={e => e.target.files?.[0] && handleFileSelect(e.target.files[0])} />
                {uploadedFile ? (
                  <div className="flex items-center justify-center gap-3">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(16,185,129,0.12)' }}>
                      <CheckCircle2 size={20} style={{ color: '#10b981' }} />
                    </div>
                    <div className="text-left">
                      <div className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{uploadedFile.name}</div>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        {(uploadedFile.size / 1024 / 1024).toFixed(1)} MB · Ready to upload
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-14 h-14 rounded-2xl flex items-center justify-center"
                      style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.15)' }}>
                      <UploadIcon size={24} style={{ color: '#6366f1' }} />
                    </div>
                    <div>
                      <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>Drag & drop your file here</p>
                      <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>or click to browse</p>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      {['CSV', 'XLSX', 'XLS'].map(f => <span key={f} className="badge badge-slate">{f}</span>)}
                    </div>
                  </div>
                )}
              </div>
              <div className="flex items-start gap-2 p-3 rounded-lg" style={{ background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                <FileSpreadsheet size={13} style={{ color: 'var(--text-muted)', marginTop: 2, flexShrink: 0 }} />
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  File is processed locally on the backend. Your data never leaves the system boundary.
                </p>
              </div>
            </div>

            {/* Upload log */}
            {uploadLog.length > 0 && (
              <div className="card overflow-hidden fade-in">
                <div className="px-5 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
                  <h3 className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Upload Status</h3>
                </div>
                <table className="data-table">
                  <thead><tr>{['File Name', 'Size', 'Time', 'Status'].map(h => <th key={h}>{h}</th>)}</tr></thead>
                  <tbody>
                    {uploadLog.map((row, i) => (
                      <tr key={i}>
                        <td className="font-medium" style={{ color: 'var(--text-primary)' }}>{row.name}</td>
                        <td>{row.size}</td><td>{row.time}</td>
                        <td>
                          <span className={`badge ${row.status === 'Success' ? 'badge-green' : row.status === 'Failed' ? 'badge-red' : 'badge-amber'}`}>
                            {row.status === 'Uploading' ? '⏳ Uploading…' : row.status === 'Success' ? '✓ Success' : '✗ Failed'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Progress bar */}
            {uploading && uploadProgress < 100 && (
              <div className="card p-5 space-y-3 fade-in">
                <div className="flex items-center gap-3">
                  <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin shrink-0"
                    style={{ borderColor: '#6366f1', borderTopColor: 'transparent' }} />
                  <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    {uploadProgress < 50 ? 'Uploading and building data store…' : 'AI mapping your columns to D365 fields…'}
                  </span>
                </div>
                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: '#e2e8f0' }}>
                  <div className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${uploadProgress}%`, background: 'linear-gradient(90deg,#6366f1,#06b6d4)' }} />
                </div>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {uploadProgress < 50
                    ? `${Math.round(uploadProgress)}% — Saving file and creating project`
                    : `${Math.round(uploadProgress)}% — Running AI mapping (Groq API)`}
                </p>
              </div>
            )}

            <button onClick={handleUploadSubmit} disabled={uploading}
              className="btn-primary w-full justify-center py-3.5 text-sm disabled:opacity-60">
              {uploading
                ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Analysing…</>
                : <>Upload & Analyse <ChevronRight size={16} /></>}
            </button>
          </div>

          {/* Right info panel */}
          <div className="space-y-4">
            <div className="card p-5">
              <h3 className="text-sm font-bold mb-4" style={{ fontFamily: 'var(--font-heading)', color: 'var(--text-primary)' }}>
                What happens next?
              </h3>
              <ol className="space-y-3">
                {[
                  { icon: <UploadIcon size={13} />, text: 'File uploaded and stored securely' },
                  { icon: <Sparkles size={13} />,   text: 'AI analyses columns and data types' },
                  { icon: <Zap size={13} />,        text: 'Field mappings suggested with confidence scores' },
                  { icon: <Database size={13} />,   text: 'Validation runs against D365 rules' },
                  { icon: <CheckCircle2 size={13} />, text: 'Migration executes after your confirmation' },
                ].map((s, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <div className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                      style={{ background: 'rgba(99,102,241,0.1)', color: '#6366f1' }}>
                      {s.icon}
                    </div>
                    <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{s.text}</span>
                  </li>
                ))}
              </ol>
            </div>
            <div className="card p-5">
              <h3 className="text-sm font-bold mb-4" style={{ fontFamily: 'var(--font-heading)', color: 'var(--text-primary)' }}>
                Supported Formats
              </h3>
              <div className="space-y-3">
                {[
                  { icon: '📄', name: 'CSV', sub: 'Comma-separated values' },
                  { icon: '📊', name: 'Excel (.xlsx)', sub: 'First sheet imported' },
                  { icon: '📋', name: 'Excel (.xls)', sub: 'Legacy Excel format' },
                ].map(f => (
                  <div key={f.name} className="flex items-center gap-3">
                    <span className="text-lg">{f.icon}</span>
                    <div>
                      <div className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{f.name}</div>
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{f.sub}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 pt-3 text-xs" style={{ borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                Maximum file size: <strong style={{ color: 'var(--text-primary)' }}>30 MB</strong>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          CONNECT TAB
      ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === 'connect' && (
        <div className="space-y-5">

          {/* PyAirbyte status banner */}
          <div
            className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium"
            style={{
              background: pyairbyteReady === true
                ? 'rgba(16,185,129,0.08)'
                : pyairbyteReady === false
                ? 'rgba(245,158,11,0.08)'
                : '#f8fafc',
              border: `1px solid ${
                pyairbyteReady === true ? 'rgba(16,185,129,0.2)'
                : pyairbyteReady === false ? 'rgba(245,158,11,0.2)'
                : '#e2e8f0'
              }`,
              color: pyairbyteReady === true ? '#059669'
                : pyairbyteReady === false ? '#d97706'
                : '#94a3b8',
            }}
          >
            {pyairbyteReady === true  && <CheckCircle size={15} className="shrink-0" />}
            {pyairbyteReady === false && <AlertCircle size={15} className="shrink-0" />}
            {pyairbyteReady === null  && <Loader2 size={15} className="shrink-0 animate-spin" />}
            <span>
              {pyairbyteReady === true  && 'Connectors ready'}
              {pyairbyteReady === false && 'Connectors not available. Restart the backend and try again.'}
              {pyairbyteReady === null  && 'Checking connector status…'}
            </span>
          </div>

          {!selectedSource ? (
            /* ── Source grid ── */
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 stagger">
              {sources.length === 0 ? (
                <div className="col-span-full flex flex-col items-center justify-center py-20 gap-3"
                  style={{ color: 'var(--text-muted)' }}>
                  <Loader2 size={32} className="animate-spin" style={{ color: '#6366f1' }} />
                  <span className="text-sm">Loading sources…</span>
                </div>
              ) : (
                sources.map(source => (
                  <button
                    key={source.name}
                    onClick={() => handleSelectSource(source)}
                    className="card p-5 text-left group fade-in"
                    style={{ cursor: 'pointer' }}
                  >
                    <div className="flex items-start gap-4">
                      <div
                        className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-transform duration-300 group-hover:scale-110"
                        style={{ background: categoryGradient(source.category), boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}
                      >
                        <CategoryIcon category={source.category} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm mb-0.5"
                          style={{ fontFamily: 'var(--font-heading)', color: 'var(--text-primary)' }}>
                          {source.name}
                        </p>
                        <p className="text-xs mb-1.5" style={{ color: '#6366f1' }}>{source.category}</p>
                        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                          {source.description}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 mt-4 text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                      style={{ color: '#6366f1' }}>
                      Connect <ChevronRight size={12} />
                    </div>
                  </button>
                ))
              )}
            </div>
          ) : (
            /* ── Connection form ── */
            <div className="max-w-xl mx-auto fade-in">
              <div className="card p-6">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                      style={{ background: categoryGradient(selectedSource.category), boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}
                    >
                      <CategoryIcon category={selectedSource.category} />
                    </div>
                    <div>
                      <h2 className="font-bold text-sm"
                        style={{ fontFamily: 'var(--font-heading)', color: 'var(--text-primary)' }}>
                        Connect to {selectedSource.name}
                      </h2>
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{selectedSource.category}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => { setSelectedSource(null); setConnectError('') }}
                    className="btn-secondary text-xs py-1.5 px-3"
                  >
                    ← Back
                  </button>
                </div>

                <div className="space-y-4">
                  {/* Required connector fields */}
                  {selectedSource.fields.map(field => {
                    const isJsonField = field === 'service_account_json' || field === 'credentials_json'
                    const label = field === 'service_account_json'
                      ? 'Service Account JSON'
                      : field.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                    const placeholder = field === 'service_account_json'
                      ? '{ "type": "service_account", "project_id": "...", ... }  — paste the full JSON key file'
                      : `Enter ${field.replace(/_/g, ' ')}`
                    const isSecret = field.includes('password') || field.includes('secret') || field.includes('token')
                    return (
                      <div key={field}>
                        <label className="label">{label}</label>
                        {isJsonField ? (
                          <textarea
                            rows={5}
                            value={config[field] ?? ''}
                            onChange={e => setConfig({ ...config, [field]: e.target.value })}
                            placeholder={placeholder}
                            className="input font-mono text-xs"
                            style={{ resize: 'vertical', fontFamily: 'monospace' }}
                          />
                        ) : (
                          <input
                            type={isSecret ? 'password' : 'text'}
                            value={config[field] ?? ''}
                            onChange={e => setConfig({ ...config, [field]: e.target.value })}
                            placeholder={placeholder}
                            className="input"
                          />
                        )}
                      </div>
                    )
                  })}

                  {/* DB-specific: table name */}
                  {DIRECT_DB.has(selectedSource.name) && (
                    <div>
                      <label className="label">Table Name</label>
                      <input type="text" value={config.table_name ?? ''}
                        onChange={e => setConfig({ ...config, table_name: e.target.value })}
                        placeholder="e.g. customers" className="input" />
                    </div>
                  )}

                  {/* Non-DB: stream selector */}
                  {!DIRECT_DB.has(selectedSource.name) && (
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="label" style={{ marginBottom: 0 }}>Stream / Object</label>
                        <button
                          type="button"
                          onClick={discoverStreams}
                          disabled={loadingStreams}
                          className="text-xs font-medium disabled:opacity-50 transition-colors flex items-center gap-1"
                          style={{ color: '#6366f1' }}
                        >
                          {loadingStreams
                            ? <><Loader2 size={11} className="animate-spin" /> Discovering…</>
                            : streamsLive
                            ? <><CheckCircle size={11} /> Live — Refresh</>
                            : 'Discover streams (with credentials)'}
                        </button>
                      </div>
                      {/* Static hint */}
                      {availableStreams.length > 0 && !streamsLive && (
                        <p className="text-xs mb-1.5" style={{ color: '#94a3b8' }}>
                          Showing default streams — enter credentials and click "Discover streams" to get live list
                        </p>
                      )}
                      {availableStreams.length > 0 ? (
                        <select value={stream} onChange={e => setStream(e.target.value)} className="input">
                          <option value="">Select a stream…</option>
                          {availableStreams.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={stream}
                          onChange={e => setStream(e.target.value)}
                          placeholder="e.g. contacts, accounts, leads"
                          className="input"
                        />
                      )}
                    </div>
                  )}

                  {/* Common project fields */}
                  <div>
                    <label className="label">Project Name</label>
                    <input type="text" value={config.project_name ?? ''}
                      onChange={e => setConfig({ ...config, project_name: e.target.value })}
                      placeholder="e.g. Salesforce Migration Q3" className="input" />
                  </div>
                  <div>
                    <label className="label">Client Name</label>
                    <input type="text" value={config.client_name ?? ''}
                      onChange={e => setConfig({ ...config, client_name: e.target.value })}
                      placeholder="e.g. Contoso Ltd" className="input" />
                  </div>
                  <div>
                    <label className="label">Target D365 Entity</label>
                    <select value={config.target_entity ?? 'account'}
                      onChange={e => setConfig({ ...config, target_entity: e.target.value })}
                      className="input">
                      <option value="account">Account</option>
                      <option value="contact">Contact</option>
                      <option value="lead">Lead</option>
                      <option value="opportunity">Opportunity</option>
                    </select>
                  </div>

                  {/* Error */}
                  {connectError && (
                    <div className="flex items-start gap-3 p-3 rounded-xl text-sm"
                      style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#ef4444' }}>
                      <AlertCircle size={15} className="shrink-0 mt-0.5" />
                      {connectError}
                    </div>
                  )}

                  <button onClick={handleConnect} disabled={connecting}
                    className="btn-primary w-full justify-center disabled:opacity-60">
                    {connecting && <Loader2 size={15} className="animate-spin" />}
                    {connecting ? 'Importing data…' : 'Connect & Import'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

    </div>
  )
}

export default SourceSelection
