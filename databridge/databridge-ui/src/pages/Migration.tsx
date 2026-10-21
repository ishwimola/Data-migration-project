import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Rocket, ChevronLeft, AlertTriangle, CheckCircle } from 'lucide-react'
import MetricCard from '../components/ui/MetricCard'
import { MigrationSkeleton } from '../components/ui/Skeleton'
import { useProject } from '../context/ProjectContext'
import { api } from '../services/api'

type Phase = 'preflight' | 'running' | 'done'

interface PreflightData {
  checks: {
    mappings_approved: boolean
    d365_configured: boolean
    records_available: boolean
    validation_completed: boolean
    cleansing_complete: boolean
  }
  total_records: number
  approved_mappings: number
  simulation_mode: boolean
  ready_to_migrate: boolean
  d365_url: string
}

interface MigrationResult {
  total_attempted: number
  total_success: number
  total_failed: number
  success_rate: number
  simulation_mode: boolean
}

const CHECK_LABELS: Record<string, string> = {
  mappings_approved:    'Mappings Approved',
  d365_configured:      'D365 Credentials Set',
  records_available:    'Records Available',
  validation_completed: 'Validation Completed',
  cleansing_complete:   'Cleansing Playbook Exists',
}

export default function Migration() {
  const navigate = useNavigate()
  const { markStageComplete } = useProject()

  const [phase, setPhase]             = useState<Phase>('preflight')
  const [confirmed, setConfirmed]     = useState(false)
  const [preflight, setPreflight]     = useState<PreflightData | null>(null)
  const [preflightError, setPreflightError] = useState<string | null>(null)
  const [preflightLoading, setPreflightLoading] = useState(true)

  const [progress, setProgress]       = useState(0)
  const [processed, setProcessed]     = useState(0)
  const [loaded, setLoaded]           = useState(0)
  const [failed, setFailed]           = useState(0)
  const [elapsed, setElapsed]         = useState(0)
  const [logLines, setLogLines]       = useState<string[]>([])
  const [migrationResult, setResult]  = useState<MigrationResult | null>(null)
  const [migrationError, setMigrationError] = useState<string | null>(null)

  const logRef   = useRef<HTMLDivElement>(null)
  const startRef = useRef<number>(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logLines])

  // Load preflight on mount
  useEffect(() => {
    api.getMigrationPreflight()
      .then(data => setPreflight(data))
      .catch(err => setPreflightError(err instanceof Error ? err.message : 'Failed to load preflight'))
      .finally(() => setPreflightLoading(false))
  }, [])

  const addLog = (msg: string) => {
    setLogLines(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`])
  }

  const startMigration = () => {
    if (!preflight) return
    setPhase('running')
    setProgress(0)
    setProcessed(0)
    setLoaded(0)
    setFailed(0)
    setLogLines([])
    setMigrationError(null)
    startRef.current = Date.now()

    timerRef.current = setInterval(
      () => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)),
      500,
    )

    const total = preflight.total_records

    // Track whether we already fell back to HTTP so onclose doesn't double-trigger
    let httpFallbackTriggered = false
    let wsCompleted = false

    const wsUrl = api.getMigrationStreamUrl()

    try {
      const ws = new WebSocket(wsUrl)

      // 10-second timeout — real Dataverse migrations take time to start.
      // The old 3s timeout was firing before the WS even finished the
      // handshake + first batch, causing the HTTP fallback to run instead.
      const wsTimeout = setTimeout(() => {
        if (!wsCompleted && !httpFallbackTriggered) {
          httpFallbackTriggered = true
          addLog('WebSocket timeout — falling back to HTTP migration...')
          ws.close()
          runHttpMigration(total)
        }
      }, 10000)

      ws.onopen = () => {
        clearTimeout(wsTimeout)
        addLog('Connected to migration stream...')
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)

          if (data.done) {
            wsCompleted = true
            clearTimeout(wsTimeout)
            const r: MigrationResult = data.result
            setResult(r)
            setProgress(100)
            setProcessed(r.total_attempted)
            setLoaded(r.total_success)
            setFailed(r.total_failed)
            if (timerRef.current) clearInterval(timerRef.current)
            markStageComplete('migration')
            setTimeout(() => setPhase('done'), 600)
            return
          }

          const msg: string = data.message ?? ''
          addLog(msg)

          const progressMatch = msg.match(/(\d+)\/(\d+)\s+processed/)
          if (progressMatch) {
            const proc = parseInt(progressMatch[1])
            const tot  = parseInt(progressMatch[2])
            setProcessed(proc)
            setProgress(Math.round((proc / tot) * 100))
          }

          const loadedMatch = msg.match(/(\d+)\s+loaded,\s*(\d+)\s+failed/)
          if (loadedMatch) {
            setLoaded(parseInt(loadedMatch[1]))
            setFailed(parseInt(loadedMatch[2]))
          }
        } catch {
          // non-JSON, ignore
        }
      }

      ws.onerror = () => {
        clearTimeout(wsTimeout)
        if (!httpFallbackTriggered && !wsCompleted) {
          httpFallbackTriggered = true
          addLog('WebSocket unavailable — falling back to HTTP migration...')
          runHttpMigration(total)
        }
      }

      ws.onclose = () => {
        clearTimeout(wsTimeout)
        // Only fall back if WS never completed and HTTP hasn't started yet
        if (!wsCompleted && !httpFallbackTriggered) {
          httpFallbackTriggered = true
          addLog('WebSocket closed — falling back to HTTP migration...')
          runHttpMigration(total)
        }
      }
    } catch {
      if (!httpFallbackTriggered) {
        httpFallbackTriggered = true
        addLog('WebSocket not available — using HTTP migration...')
        runHttpMigration(total)
      }
    }
  }

  const runHttpMigration = async (total: number) => {
    addLog('Starting HTTP migration...')
    try {
      // Simulate progress while waiting for HTTP response
      let fakeProgress = 0
      const progressInterval = setInterval(() => {
        fakeProgress = Math.min(fakeProgress + 8, 90)
        setProgress(fakeProgress)
        setProcessed(Math.floor((fakeProgress / 100) * total))
      }, 400)

      const result = await api.startMigration()

      clearInterval(progressInterval)

      if (result.error) {
        setMigrationError(result.error)
        if (timerRef.current) clearInterval(timerRef.current)
        setPhase('preflight')
        return
      }

      setResult(result)
      setProgress(100)
      setProcessed(result.total_attempted)
      setLoaded(result.total_success)
      setFailed(result.total_failed)
      addLog(`Migration complete — ${result.total_success} loaded, ${result.total_failed} failed`)
      addLog(`Success rate: ${result.success_rate}%`)
      if (result.simulation_mode) addLog('[SIMULATION MODE — no records sent to D365]')

      if (timerRef.current) clearInterval(timerRef.current)
      markStageComplete('migration')
      setTimeout(() => setPhase('done'), 600)
    } catch (err) {
      if (timerRef.current) clearInterval(timerRef.current)
      setMigrationError(err instanceof Error ? err.message : 'Migration failed')
      setPhase('preflight')
    }
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}m ${s % 60}s`

  // ── PRE-FLIGHT ──────────────────────────────────────────────────────────────

  if (phase === 'preflight') {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="page-header">🚀 Execute Migration</h1>
          <p className="text-slate-500 mt-1">
            {preflight ? `${preflight.total_records} records → D365 ${preflight.d365_url}` : 'Loading...'}
          </p>
        </div>

        {/* Simulation mode banner */}
        {preflight?.simulation_mode && (
          <div className="flex items-start gap-3 p-4 bg-amber-50 border-2 border-amber-300 rounded-xl">
            <AlertTriangle size={18} className="text-amber-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-bold text-amber-800">
                SIMULATION MODE — No data will be sent to Dynamics 365
              </p>
              <p className="text-sm text-amber-700 mt-0.5">
                D365 credentials are not configured. Records will be processed and counted locally only.
              </p>
            </div>
          </div>
        )}

        {migrationError && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
            Migration error: {migrationError}
          </div>
        )}

        {/* Pre-flight checks */}
        <div className="card p-5">
          <h2 className="section-title">Pre-Flight Checks</h2>
          {preflightLoading ? (
            <MigrationSkeleton />
          ) : preflightError ? (
            <div className="text-red-600 text-sm py-4">{preflightError}</div>
          ) : preflight ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                {Object.entries(preflight.checks).map(([key, ok]) => (
                  <div
                    key={key}
                    className={`flex items-center gap-3 p-3 rounded-lg border ${
                      ok ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'
                    }`}
                  >
                    <span className={`text-base ${ok ? 'text-green-600' : 'text-amber-500'}`}>
                      {ok ? '✔' : '⚠'}
                    </span>
                    <span className={`text-sm font-medium ${ok ? 'text-green-800' : 'text-amber-800'}`}>
                      {CHECK_LABELS[key] ?? key}
                    </span>
                  </div>
                ))}
              </div>
              {!preflight.checks.d365_configured && (
                <p className="text-xs text-amber-700 mt-3">
                  ⚠ D365 credentials not configured — migration will run in simulation mode
                </p>
              )}
            </>
          ) : null}
        </div>

        {/* Migration summary */}
        {preflight && (
          <div className="card p-6">
            <h2 className="section-title">Migration Summary</h2>
            <div className="grid grid-cols-2 gap-x-12 gap-y-3 text-sm">
              {[
                ['Total Records',      preflight.total_records],
                ['Approved Mappings',  preflight.approved_mappings],
                ['Target Environment', preflight.d365_url],
                ['Mode',               preflight.simulation_mode ? 'Simulation' : 'Live'],
              ].map(([k, v]) => (
                <div key={String(k)} className="flex justify-between py-2 border-b border-slate-50">
                  <span className="text-slate-500">{k}</span>
                  <span className="font-medium text-slate-800">{String(v)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Warning */}
        {preflight && !preflight.simulation_mode && (
          <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl">
            <AlertTriangle size={18} className="text-amber-600 mt-0.5 shrink-0" />
            <p className="text-sm text-amber-800">
              This action will write <strong>{preflight.total_records} records</strong> into your
              Dynamics 365 environment. This cannot be automatically undone.
            </p>
          </div>
        )}

        {/* Confirmation checkbox */}
        {preflight && (
          <label className="flex items-center gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={e => setConfirmed(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-slate-700">
              I confirm I want to migrate <strong>{preflight.total_records} records</strong>
              {preflight.simulation_mode ? ' (simulation mode)' : ` to ${preflight.d365_url}`}
            </span>
          </label>
        )}

        {/* Start button */}
        <button
          onClick={startMigration}
          disabled={!confirmed || !preflight?.ready_to_migrate}
          className="btn-danger w-full py-4 text-base flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Rocket size={20} />
          {preflight?.simulation_mode
            ? `Start Migration — Simulation (${preflight?.total_records ?? 0} records)`
            : `Start Migration (${preflight?.total_records ?? 0} records)`}
        </button>

        <button onClick={() => navigate('/cleansing')} className="btn-secondary flex items-center gap-2">
          <ChevronLeft size={16} /> Back to Cleansing
        </button>
      </div>
    )
  }

  // ── RUNNING ─────────────────────────────────────────────────────────────────

  if (phase === 'running') {
    const total = preflight?.total_records ?? 0
    return (
      <div className="space-y-5">
        <div>
          <h1 className="page-header">🚀 Execute Migration</h1>
        </div>

        <div className="card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-slate-800">Migration in progress...</span>
            <span className="text-sm text-slate-500">Elapsed: {fmt(elapsed)}</span>
          </div>
          <div className="relative">
            <progress
              className="progress-bar progress-bar-xl progress-bar-blue"
              value={progress}
              max={100}
              aria-label="Migration progress"
            />
            {progress > 15 && (
              <span className="absolute inset-y-0 right-2 flex items-center text-white text-xs font-bold">
                {progress}%
              </span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-4 gap-5">
          <MetricCard label="Records Processed" value={`${processed} / ${total}`} colour="blue"  />
          <MetricCard label="Loaded"             value={loaded}                    colour="green" />
          <MetricCard label="Failed"             value={failed}                    colour={failed > 0 ? 'red' : 'default'} />
          <MetricCard label="Batch"              value="1 / 1"                     colour="blue"  />
        </div>

        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 bg-slate-50">
            <h3 className="text-sm font-semibold text-slate-700">Activity Log</h3>
          </div>
          <div ref={logRef} className="h-48 overflow-y-auto p-4 font-mono text-xs space-y-1 bg-slate-50">
            {logLines.map((line, i) => (
              <div
                key={i}
                className={
                  line.toLowerCase().includes('fail') || line.includes('400') || line.includes('error')
                    ? 'text-red-600'
                    : line.toLowerCase().includes('success') || line.toLowerCase().includes('loaded') || line.toLowerCase().includes('complete')
                    ? 'text-green-600'
                    : line.toLowerCase().includes('simulation') || line.toLowerCase().includes('warning')
                    ? 'text-amber-600'
                    : 'text-slate-700'
                }
              >
                {line}
              </div>
            ))}
            {logLines.length > 0 && (
              <div className="text-slate-400 animate-pulse">|</div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── DONE ────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      <div>
        <h1 className="page-header">🚀 Execute Migration</h1>
      </div>

      <div className="p-6 bg-green-50 border-2 border-green-400 rounded-xl text-center">
        <CheckCircle size={40} className="text-green-500 mx-auto mb-3" />
        <h2 className="text-xl font-bold text-green-800">Migration Completed Successfully</h2>
        {migrationResult && (
          <p className="text-green-700 mt-1">
            {migrationResult.total_success} records loaded · {migrationResult.total_failed} failed ·{' '}
            {migrationResult.success_rate}% success rate
            {migrationResult.simulation_mode && ' (simulation)'}
          </p>
        )}
      </div>

      {migrationResult && (
        <div className="grid grid-cols-4 gap-5">
          <MetricCard label="Total Attempted" value={migrationResult.total_attempted} colour="blue"  />
          <MetricCard label="Loaded"          value={migrationResult.total_success}   colour="green" />
          <MetricCard label="Failed"          value={migrationResult.total_failed}    colour={migrationResult.total_failed > 0 ? 'red' : 'default'} />
          <MetricCard label="Success Rate"    value={`${migrationResult.success_rate}%`} colour="green" />
        </div>
      )}

      <button
        onClick={() => navigate('/report')}
        className="btn-primary w-full py-3 flex items-center justify-center gap-2"
      >
        View Migration Report
      </button>
    </div>
  )
}
