import clsx from 'clsx'

type Variant = 'green' | 'amber' | 'red' | 'blue' | 'purple' | 'slate' | 'teal' | 'cyan'

const variants: Record<Variant, string> = {
  green:  'badge-green',
  amber:  'badge-amber',
  red:    'badge-red',
  blue:   'badge-blue',
  purple: 'badge-purple',
  slate:  'badge-slate',
  teal:   'badge-green',
  cyan:   'badge-cyan',
}

export function Badge({ children, variant = 'slate', className }: {
  children: React.ReactNode
  variant?: Variant
  className?: string
}) {
  return (
    <span className={clsx('badge', variants[variant], className)}>
      {children}
    </span>
  )
}

export function ConfidenceBadge({ score }: { score: number }) {
  const pct     = Math.round(score * 100)
  const variant = score >= 0.85 ? 'green' : score >= 0.60 ? 'amber' : 'red'
  const icon    = score >= 0.85 ? '✓' : score >= 0.60 ? '⚠' : '✗'
  return <Badge variant={variant}>{icon} {pct}%</Badge>
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: Variant }> = {
    auto_approved: { label: 'Auto Approved', variant: 'green'  },
    needs_review:  { label: 'Needs Review',  variant: 'amber'  },
    uncertain:     { label: 'Uncertain',     variant: 'red'    },
    reused:        { label: 'Reused',        variant: 'blue'   },
    completed:     { label: 'Completed',     variant: 'green'  },
    validated:     { label: 'Validated',     variant: 'cyan'   },
    mapping:       { label: 'Mapping',       variant: 'amber'  },
    migrating:     { label: 'Migrating',     variant: 'purple' },
    in_progress:   { label: 'In Progress',   variant: 'amber'  },
    created:       { label: 'Created',       variant: 'slate'  },
    failed:        { label: 'Failed',        variant: 'red'    },
  }
  const { label, variant } = map[status] ?? { label: status, variant: 'slate' as Variant }
  return <Badge variant={variant}>{label}</Badge>
}

export function MethodBadge({ method }: { method: string }) {
  const map: Record<string, { label: string; variant: Variant }> = {
    ai:                  { label: '🤖 AI',          variant: 'purple' },
    semantic_ai_mapping: { label: '🤖 AI',          variant: 'purple' },
    synonym_match:       { label: '🔍 Fuzzy',       variant: 'amber'  },
    fuzzy:               { label: '🔍 Fuzzy',       variant: 'amber'  },
    history_match:       { label: '🧠 History',     variant: 'cyan'   },
    reused:              { label: '♻ Reused',       variant: 'blue'   },
    manual:              { label: '✏ Manual',       variant: 'green'  },
    failed:              { label: '❌ Failed',       variant: 'red'    },
  }
  const { label, variant } = map[method] ?? { label: method, variant: 'slate' as Variant }
  return <Badge variant={variant}>{label}</Badge>
}

export function TypeBadge({ type }: { type: string }) {
  const map: Record<string, Variant> = {
    text: 'slate', integer: 'blue', decimal: 'blue',
    date: 'purple', datetime: 'purple', email: 'cyan',
    phone: 'cyan', boolean: 'amber', currency: 'green',
  }
  return <Badge variant={map[type] ?? 'slate'}>{type}</Badge>
}
