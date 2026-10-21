/**
 * TASK-022: Skeleton shimmer components for data-fetching loading states.
 * Uses the .skeleton CSS class defined in index.css for the shimmer animation.
 */

interface SkeletonProps {
  className?: string
  style?: React.CSSProperties
}

/** Generic shimmer block */
export function Skeleton({ className = '', style }: SkeletonProps) {
  return (
    <div
      className={`skeleton ${className}`}
      style={style}
      aria-hidden="true"
    />
  )
}

/** A single stat card skeleton matching StatCard layout */
export function StatCardSkeleton() {
  return (
    <div className="card p-6 space-y-3">
      <div className="flex items-start justify-between mb-2">
        <Skeleton style={{ width: 44, height: 44, borderRadius: 12 }} />
        <Skeleton style={{ width: 14, height: 14, borderRadius: 4 }} />
      </div>
      <Skeleton style={{ width: '50%', height: 32, borderRadius: 6 }} />
      <Skeleton style={{ width: '70%', height: 14, borderRadius: 4 }} />
      <Skeleton style={{ width: '40%', height: 12, borderRadius: 4 }} />
    </div>
  )
}

/** A single table row skeleton */
export function TableRowSkeleton({ cols = 8 }: { cols?: number }) {
  return (
    <tr aria-hidden="true">
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} style={{ padding: '14px 16px' }}>
          <Skeleton style={{ height: 14, borderRadius: 4, width: i === 0 ? '60%' : '80%' }} />
        </td>
      ))}
    </tr>
  )
}

/** Dashboard skeleton — 4 stat cards + 5 table rows */
export function DashboardSkeleton() {
  return (
    <div className="space-y-8">
      {/* Stats */}
      <div className="grid grid-cols-4 gap-5">
        {Array.from({ length: 4 }).map((_, i) => <StatCardSkeleton key={i} />)}
      </div>
      {/* Table */}
      <div className="card overflow-hidden">
        <div className="px-6 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <Skeleton style={{ width: 140, height: 16, borderRadius: 4 }} />
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {Array.from({ length: 5 }).map((_, i) => (
              <TableRowSkeleton key={i} cols={9} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Mapping page skeleton — 4 metric cards + 6 mapping rows */
export function MappingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-4 gap-5">
        {Array.from({ length: 4 }).map((_, i) => <StatCardSkeleton key={i} />)}
      </div>
      <div className="card overflow-hidden">
        <div className="px-5 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <Skeleton style={{ width: 200, height: 14, borderRadius: 4 }} />
        </div>
        <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 px-5 py-3 items-center">
              <div className="col-span-2"><Skeleton style={{ height: 22, borderRadius: 4 }} /></div>
              <div className="col-span-2"><Skeleton style={{ height: 32, borderRadius: 8 }} /></div>
              <div className="col-span-2"><Skeleton style={{ height: 8, borderRadius: 99 }} /></div>
              <div className="col-span-1"><Skeleton style={{ height: 20, borderRadius: 99, width: 60 }} /></div>
              <div className="col-span-1"><Skeleton style={{ height: 20, borderRadius: 99, width: 70 }} /></div>
              <div className="col-span-3"><Skeleton style={{ height: 32, borderRadius: 8 }} /></div>
              <div className="col-span-1"><Skeleton style={{ height: 20, width: 36, borderRadius: 99, margin: '0 auto' }} /></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Validation page skeleton */
export function ValidationSkeleton() {
  return (
    <div className="grid grid-cols-3 gap-6">
      <div className="col-span-1 card p-5 space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="p-3 rounded-lg" style={{ border: '1px solid var(--border)' }}>
            <Skeleton style={{ height: 14, width: '70%', marginBottom: 8, borderRadius: 4 }} />
            <Skeleton style={{ height: 10, width: '90%', borderRadius: 4 }} />
          </div>
        ))}
      </div>
      <div className="col-span-2 space-y-4">
        <Skeleton style={{ height: 56, borderRadius: 12 }} />
        <div className="card p-5 space-y-3">
          <Skeleton style={{ height: 16, width: '30%', borderRadius: 4 }} />
          <div className="grid grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} style={{ height: 72, borderRadius: 8 }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Migration preflight skeleton */
export function MigrationSkeleton() {
  return (
    <div className="space-y-6">
      <div className="card p-5 space-y-3">
        <Skeleton style={{ height: 16, width: '20%', borderRadius: 4 }} />
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} style={{ height: 44, borderRadius: 8 }} />
          ))}
        </div>
      </div>
      <div className="card p-6 space-y-3">
        <Skeleton style={{ height: 16, width: '25%', borderRadius: 4 }} />
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} style={{ height: 32, borderRadius: 6 }} />
        ))}
      </div>
    </div>
  )
}
