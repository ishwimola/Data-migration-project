import { Routes, Route, Navigate } from 'react-router-dom'
import Layout          from './components/layout/Layout'
import Dashboard       from './pages/Dashboard'
import SourceSelection from './pages/SourceSelection'
import Schema          from './pages/Schema'
import Mapping         from './pages/Mapping'
import Validation      from './pages/Validation'
import Cleansing       from './pages/Cleansing'
import Migration       from './pages/Migration'
import Report          from './pages/Report'
import AuditLog        from './pages/AuditLog'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/"           element={<Dashboard       />} />
        {/* /upload redirects to the unified data-import page */}
        <Route path="/upload"     element={<Navigate to="/sources" replace />} />
        <Route path="/sources"    element={<SourceSelection />} />
        <Route path="/schema"     element={<Schema          />} />
        <Route path="/mapping"    element={<Mapping         />} />
        <Route path="/validation" element={<Validation      />} />
        <Route path="/cleansing"  element={<Cleansing       />} />
        <Route path="/migration"  element={<Migration       />} />
        <Route path="/report"     element={<Report          />} />
        <Route path="/audit"      element={<AuditLog        />} />
      </Route>
    </Routes>
  )
}
