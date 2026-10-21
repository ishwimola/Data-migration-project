import { useEffect, useState, useCallback } from 'react'

interface ApiState<T> {
  data: T | null
  loading: boolean
  error: string | null
  refetch: () => void
}

export function useApiData<T>(load: () => Promise<T>, deps: unknown[] = []): ApiState<T> {
  const [data, setData]       = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [tick, setTick]       = useState(0)

  const refetch = useCallback(() => setTick(t => t + 1), [])

  useEffect(() => {
    let active = true

    setLoading(true)
    setError(null)

    load()
      .then(result => { if (active) setData(result) })
      .catch(err   => { if (active) setError(err instanceof Error ? err.message : 'Unable to load data') })
      .finally(()  => { if (active) setLoading(false) })

    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps])

  return { data, loading, error, refetch }
}
