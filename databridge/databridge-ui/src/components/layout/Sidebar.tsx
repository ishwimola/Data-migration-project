/**
 * TASK-025: Responsive sidebar — collapses to hamburger + overlay drawer on screens < 900px.
 */
import { useState, useEffect } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, Upload, ScanSearch, GitMerge,
  ShieldCheck, Sparkles, Rocket, BarChart3,
  Database, Zap, ScrollText, CheckCircle2,
  Activity, Menu, X,
} from 'lucide-react'
import clsx from 'clsx'
import { useProject, Stage } from '../../context/ProjectContext'

interface NavItem {
  to: string
  icon: React.ElementType
  label: string
  stage?: Stage
  divider?: boolean
  badge?: string
}

const NAV_ITEMS: NavItem[] = [
  { to: '/',           icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/sources',    icon: Upload,          label: 'Import Data',  stage: 'upload', divider: true },
  { to: '/schema',     icon: ScanSearch,      label: 'Schema',       stage: 'schema'     },
  { to: '/mapping',    icon: GitMerge,        label: 'AI Mapping',   stage: 'mapping'    },
  { to: '/validation', icon: ShieldCheck,     label: 'Validation',   stage: 'validation' },
  { to: '/cleansing',  icon: Sparkles,        label: 'Cleansing',    stage: 'cleansing'  },
  { to: '/migration',  icon: Rocket,          label: 'Migration',    stage: 'migration'  },
  { to: '/report',     icon: BarChart3,       label: 'Report',       stage: 'report',    divider: true },
  { to: '/audit',      icon: ScrollText,      label: 'Audit Log' },
]

const STEP_STAGES: Stage[] = ['upload','schema','mapping','validation','cleansing','migration','report']

// ── Sidebar content (shared between desktop and mobile drawer) ────────────────
function SidebarContent({ onClose }: { onClose?: () => void }) {
  const location = useLocation()
  const { isStageComplete } = useProject()

  const completedCount = STEP_STAGES.filter(s => isStageComplete(s)).length
  const progressPct    = Math.round((completedCount / STEP_STAGES.length) * 100)

  return (
    <>
      {/* ── Logo ── */}
      <div className="px-5 pt-6 pb-5" style={{ borderBottom: '1px solid #e2e8f0' }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: 'linear-gradient(135deg, #6366f1, #06b6d4)', boxShadow: '0 4px 15px rgba(99,102,241,0.3)' }}
            >
              <Zap size={17} className="text-white" />
            </div>
            <div>
              <div className="font-heading font-bold text-slate-900 text-sm leading-tight tracking-tight">
                DataBridge<span className="gradient-text">.AI</span>
              </div>
              <div className="text-xs mt-0.5" style={{ color: '#94a3b8' }}>
                D365 Migration Platform
              </div>
            </div>
          </div>
          {/* Close button — mobile only */}
          {onClose && (
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg transition-colors"
              style={{ color: '#94a3b8' }}
              aria-label="Close navigation"
            >
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      {/* ── Nav ── */}
      <nav className="flex-1 px-3 py-4 overflow-y-auto space-y-0.5">
        {NAV_ITEMS.map(({ to, icon: Icon, label, stage, divider, badge }) => {
          const active = to === '/'
            ? location.pathname === '/'
            : location.pathname.startsWith(to)
          const completed = stage ? isStageComplete(stage) : false

          return (
            <div key={to}>
              {divider && (
                <div className="my-3 mx-2" style={{ height: '1px', background: '#e2e8f0' }} />
              )}
              <NavLink
                to={to}
                onClick={onClose}
                className={clsx(
                  'group flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 relative',
                  active ? 'text-slate-900' : 'hover:text-slate-900',
                )}
                style={active ? {
                  background: 'linear-gradient(135deg, rgba(99,102,241,0.1), rgba(6,182,212,0.05))',
                  border: '1px solid rgba(99,102,241,0.2)',
                  color: '#0f172a',
                  boxShadow: '0 2px 8px rgba(99,102,241,0.1)',
                } : {
                  color: '#64748b',
                  border: '1px solid transparent',
                }}
              >
                {active && (
                  <div
                    className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-r-full"
                    style={{ background: 'linear-gradient(180deg, #6366f1, #06b6d4)' }}
                  />
                )}

                <Icon
                  size={15}
                  className="shrink-0 transition-all duration-200"
                  style={active ? { color: '#6366f1' } : {}}
                />

                <span className="flex-1 font-medium">{label}</span>

                {badge && !active && (
                  <span
                    className="text-xs px-1.5 py-0.5 rounded-md font-bold"
                    style={{ background: 'rgba(6,182,212,0.15)', color: '#0891b2', fontSize: '0.6rem' }}
                  >
                    {badge}
                  </span>
                )}

                {completed && !active && (
                  <CheckCircle2 size={13} style={{ color: '#10b981', flexShrink: 0 }} />
                )}
              </NavLink>
            </div>
          )
        })}
      </nav>

      {/* ── Progress ── */}
      {completedCount > 0 && (
        <div className="px-4 py-3" style={{ borderTop: '1px solid #e2e8f0' }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium" style={{ color: '#64748b' }}>Pipeline Progress</span>
            <span className="text-xs font-bold" style={{ color: '#6366f1' }}>{progressPct}%</span>
          </div>
          <div className="h-1 rounded-full overflow-hidden" style={{ background: '#e2e8f0' }}>
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{ width: `${progressPct}%`, background: 'linear-gradient(90deg, #6366f1, #06b6d4)', boxShadow: '0 0 8px rgba(99,102,241,0.3)' }}
            />
          </div>
        </div>
      )}

      {/* ── Status footer ── */}
      <div className="px-4 py-4" style={{ borderTop: '1px solid #e2e8f0' }}>
        <div className="flex items-center gap-2 mb-2">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 pulse-dot" />
          <span className="text-xs" style={{ color: '#64748b' }}>Groq AI — ready</span>
        </div>
        <div className="flex items-center gap-2">
          <Database size={11} style={{ color: '#94a3b8' }} />
          <span className="text-xs" style={{ color: '#94a3b8' }}>PostgreSQL connected</span>
        </div>
        <div className="flex items-center gap-2 mt-2">
          <Activity size={11} style={{ color: '#cbd5e1' }} />
          <span className="text-xs" style={{ color: '#cbd5e1' }}>v2.0 · Phase 2</span>
        </div>
      </div>
    </>
  )
}

// ── Main Sidebar export ───────────────────────────────────────────────────────
export default function Sidebar() {
  const [mobileOpen, setMobileOpen] = useState(false)

  // Close drawer when viewport grows above breakpoint
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 900px)')
    const handler = (e: MediaQueryListEvent) => { if (e.matches) setMobileOpen(false) }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  return (
    <>
      {/* ── Desktop sidebar (≥900px) ── */}
      <aside
        className="fixed left-0 top-0 h-screen w-64 flex flex-col z-40"
        style={{ background: '#ffffff', borderRight: '1px solid #e2e8f0' }}
        aria-label="Main navigation"
      >
        {/* Hide on mobile via inline media — Tailwind 'hidden' would need a breakpoint class */}
        <div className="flex flex-col h-full" style={{ display: 'flex' }}>
          <SidebarContent />
        </div>
      </aside>

      {/* ── Hamburger trigger (mobile, <900px) ── */}
      <button
        onClick={() => setMobileOpen(true)}
        className="fixed top-4 left-4 z-50 p-2 rounded-xl shadow-md"
        style={{
          background: '#ffffff',
          border: '1px solid #e2e8f0',
          display: 'none',   // shown via CSS below
        }}
        id="sidebar-hamburger"
        aria-label="Open navigation"
        aria-expanded={mobileOpen}
      >
        <Menu size={18} style={{ color: '#6366f1' }} />
      </button>

      {/* ── Mobile drawer overlay ── */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-50 flex"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0"
            style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)' }}
            onClick={() => setMobileOpen(false)}
          />
          {/* Drawer */}
          <aside
            className="relative flex flex-col w-64 h-full slide-in-left"
            style={{ background: '#ffffff', borderRight: '1px solid #e2e8f0' }}
          >
            <SidebarContent onClose={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      {/* ── Responsive CSS injected inline ── */}
      <style>{`
        @media (max-width: 899px) {
          aside[aria-label="Main navigation"] { display: none !important; }
          #sidebar-hamburger { display: flex !important; }
        }
      `}</style>
    </>
  )
}
