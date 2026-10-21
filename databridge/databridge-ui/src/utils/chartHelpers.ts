/**
 * TASK-021: Chart/presentation utility functions moved from api.ts.
 * These are pure UI helpers with no API dependency.
 */

import type { MappingSuggestion } from '../services/api'

export interface ConfidenceBucket {
  range: string
  count: number
}

/**
 * Bucket a list of mappings into three confidence ranges for chart display.
 *   0–59%   → red / uncertain
 *   60–84%  → amber / needs review
 *   85–100% → green / auto approved
 */
export function confidenceDistribution(mappings: MappingSuggestion[]): ConfidenceBucket[] {
  const buckets: Array<ConfidenceBucket & { min: number; max: number }> = [
    { range: '0-59%',   min: 0,    max: 0.599, count: 0 },
    { range: '60-84%',  min: 0.6,  max: 0.849, count: 0 },
    { range: '85-100%', min: 0.85, max: 1,     count: 0 },
  ]

  mappings.forEach(mapping => {
    const bucket = buckets.find(
      b => mapping.confidence >= b.min && mapping.confidence <= b.max,
    )
    if (bucket) bucket.count += 1
  })

  return buckets.map(({ range, count }) => ({ range, count }))
}
