/**
 * TASK-023: Global Toast notification system.
 * Usage:
 *   const { toast } = useToast()
 *   toast('Saved!', 'success')
 *   toast('Something went wrong', 'error')
 */

import { createContext, useContext, useState, useCallback, ReactNode } from 'react'
import { CheckCircle, AlertTriangle, Info, X, XCircle } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

export type ToastType = 'success' | 'error' | 'warning' | 'info'

interface ToastItem {
  id: string
  message: string
  type: ToastType
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void
}

// ── Context ───────────────────────────────────────────────────────────────────

const ToastContext = createContext<ToastContextValue>({
  toast: () => {},
})

// ── Provider ──────────────────────────────────────────────────────────────────

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const toast = useCallback((message: string, type: ToastType = 'info') => {
    const id = `${Date.now()}-${Math.random()}`
    setToasts(prev => [...prev, { id, message, type }])
    // Auto-dismiss after 4 seconds
    setTimeout(() => dismiss(id), 4000)
  }, [dismiss])

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* Toast stack — bottom-right */}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none"
        style={{ maxWidth: '20rem' }}
      >
        {toasts.map(t => (
          <ToastCard key={t.id} item={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

// ── Individual toast card ─────────────────────────────────────────────────────

const STYLES: Record<ToastType, { bg: string; border: string; icon: React.ElementType; iconColor: string }> = {
  success: { bg: '#f0fdf4', border: '#86efac', icon: CheckCircle,    iconColor: '#16a34a' },
  error:   { bg: '#fff1f2', border: '#fca5a5', icon: XCircle,        iconColor: '#dc2626' },
  warning: { bg: '#fffbeb', border: '#fcd34d', icon: AlertTriangle,  iconColor: '#d97706' },
  info:    { bg: '#eff6ff', border: '#93c5fd', icon: Info,           iconColor: '#2563eb' },
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  const s = STYLES[item.type]
  const Icon = s.icon

  return (
    <div
      role="alert"
      className="pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl shadow-lg fade-in-fast"
      style={{
        background: s.bg,
        border: `1px solid ${s.border}`,
        minWidth: '16rem',
      }}
    >
      <Icon size={16} style={{ color: s.iconColor, marginTop: 2, flexShrink: 0 }} />
      <span className="flex-1 text-sm font-medium" style={{ color: '#0f172a' }}>
        {item.message}
      </span>
      <button
        onClick={() => onDismiss(item.id)}
        className="shrink-0 transition-opacity opacity-60 hover:opacity-100"
        aria-label="Dismiss"
      >
        <X size={14} style={{ color: '#64748b' }} />
      </button>
    </div>
  )
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useToast() {
  return useContext(ToastContext)
}
