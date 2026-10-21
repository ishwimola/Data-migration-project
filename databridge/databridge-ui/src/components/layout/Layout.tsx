import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import GlobalHeader from './GlobalHeader'

export default function Layout() {
  return (
    <div className="flex min-h-screen" style={{ background: 'var(--bg)' }}>
      <Sidebar />
      {/* TASK-025: margin-left only applied on desktop (≥900px) via style tag */}
      <div className="flex-1 flex flex-col min-h-screen layout-main-content">
        <GlobalHeader />
        <main className="flex-1">
          <div className="max-w-7xl mx-auto px-8 py-8 fade-in">
            <Outlet />
          </div>
        </main>
      </div>
      <style>{`
        .layout-main-content { margin-left: 16rem; }
        @media (max-width: 899px) {
          .layout-main-content { margin-left: 0; }
        }
      `}</style>
    </div>
  )
}
