interface MetricCardProps {
  label: string
  value: string | number
  sub?: string
  icon?: React.ReactNode
  colour?: 'green' | 'amber' | 'red' | 'blue' | 'cyan' | 'default'
}

const gradients: Record<string, string> = {
  green:   'linear-gradient(135deg,#10b981,#34d399)',
  amber:   'linear-gradient(135deg,#f59e0b,#fbbf24)',
  red:     'linear-gradient(135deg,#ef4444,#f87171)',
  blue:    'linear-gradient(135deg,#6366f1,#818cf8)',
  cyan:    'linear-gradient(135deg,#06b6d4,#22d3ee)',
  default: 'linear-gradient(135deg,#475569,#64748b)',
}

export default function MetricCard({ label, value, sub, icon, colour = 'default' }: MetricCardProps) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between mb-3">
        {icon && (
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: gradients[colour], boxShadow: '0 4px 12px rgba(0,0,0,0.25)' }}
          >
            <span style={{ color: '#fff' }}>{icon}</span>
          </div>
        )}
      </div>
      <div
        className="text-2xl font-bold mb-0.5"
        style={{ fontFamily: 'var(--font-heading)', color: 'var(--text-primary)' }}
      >
        {value}
      </div>
      <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </div>
      {sub && (
        <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{sub}</div>
      )}
    </div>
  )
}
