/**
 * Canonical stringify for arbitrary values, shared by the v3 and v4
 * schema fingerprint walkers. Produces a stable string surface for
 * structural equality testing: object keys are sorted, arrays walk in
 * index order, and functions / symbols / cycles collapse to opaque
 * sentinels.
 *
 * This is NOT JSON. The output is not meant to round-trip through
 * `JSON.parse`; it exists purely so two structurally-equal values
 * serialise to the same string and two structurally-different values
 * do not.
 *
 * Cycle detection uses an ancestor-stack add / delete pattern: a
 * reference is only treated as cyclic while it sits on the path from
 * the root being stringified. Without the `delete` on the way back up,
 * two sibling properties pointing at the same object would see the
 * second one falsely labelled `<cyclic>`.
 */
export function canonicalStringify(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  const t = typeof value
  if (t === 'string') return JSON.stringify(value)
  if (t === 'number' || t === 'boolean') return String(value)
  if (t === 'bigint') return `${String(value)}n`
  if (t === 'function') return 'fn:*'
  if (t === 'symbol') return 'symbol:*'
  if (Array.isArray(value)) {
    if (seen.has(value)) return '<cyclic>'
    seen.add(value)
    try {
      const parts = value.map((v) => canonicalStringify(v, seen))
      return `[${parts.join(',')}]`
    } finally {
      seen.delete(value)
    }
  }
  if (t === 'object') {
    // `null` already returned above, so the remaining `object` branch is
    // non-null; narrowing against null again is redundant (eslint's
    // no-unnecessary-condition rule flags it).
    const obj = value as Record<string, unknown>
    if (seen.has(obj)) return '<cyclic>'
    seen.add(obj)
    try {
      if (value instanceof Date) return `date:${value.getTime()}`
      if (value instanceof RegExp) return `regex:${String(value)}`
      const entries = Object.entries(obj)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v, seen)}`)
      return `{${entries.join(',')}}`
    } finally {
      seen.delete(obj)
    }
  }
  return 'unknown'
}
