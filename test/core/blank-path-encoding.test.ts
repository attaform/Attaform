/**
 * PASS2-8 — `data.blankPaths` round-trips through persistence without
 * losing the structural distinction between literal-dot record keys
 * (`record["foo.bar"]`, segments `['record', 'foo.bar']`) and dotted
 * public-path segments (`record.foo.bar`, segments
 * `['record', 'foo', 'bar']`).
 *
 * v=5 wrote the blank set as an array of dotted public-path strings
 * (`'foo.bar'`), collapsing both shapes above onto the same wire. On
 * hydrate, the dotted decoder then split the literal-dot segment into
 * two — the blank-mark landed on the wrong slot, silently flipping
 * the displayed-blank UX and the synthesised required-blank error.
 *
 * v=6 keeps the canonical `PathKey` JSON shape on disk verbatim.
 * The JSON-array carries segment kind (string vs. number) and
 * tolerates literal dots inside a quoted segment — so the on-disk
 * shape and the in-memory `PathKey` are identical.
 *
 * The test pins the round-trip directly through the I/O helpers
 * (`buildPersistedPayload` / `readPersistedPayload`) so the
 * payload-shape contract is independently verified, decoupled from
 * adapter timing.
 */
import { describe, expect, it } from 'vitest'
import {
  buildPersistedPayload,
  PERSISTED_ENVELOPE_VERSION,
  readPersistedPayload,
} from '../../src/runtime/core/persistence/payload'
import { canonicalizePath } from '../../src/runtime/core/paths'
import type { PathKey } from '../../src/runtime/core/paths'

describe('persistence — blankPaths lossless encoding', () => {
  it('envelope version is v=6', () => {
    expect(PERSISTED_ENVELOPE_VERSION).toBe(6)
  })

  it('round-trips a blank-mark at a literal-dot record key', () => {
    // Internal: `record["foo.bar"]` produces the 2-segment path
    // `['record', 'foo.bar']` and the PathKey `'["record","foo.bar"]'`.
    // The dotted form `record.foo.bar` is the 3-segment path
    // `['record', 'foo', 'bar']` and PathKey `'["record","foo","bar"]'`.
    // These are distinct in-memory; the v=5 wire shape collapsed them.
    const literalDotKey = canonicalizePath(['record', 'foo.bar']).key
    const dottedSegmentsKey = canonicalizePath(['record', 'foo', 'bar']).key
    expect(literalDotKey).not.toBe(dottedSegmentsKey)

    const payload = buildPersistedPayload(
      { record: { 'foo.bar': '' } },
      'form',
      new Map(),
      new Map(),
      new Set<PathKey>([literalDotKey])
    )

    const read = readPersistedPayload<{ record: Record<string, string> }>(
      JSON.parse(JSON.stringify(payload))
    )
    expect(read).not.toBeNull()
    const persistedList = read?.data.blankPaths
    expect(persistedList).toBeDefined()
    expect(persistedList).toHaveLength(1)
    // v=6 stores the PathKey JSON verbatim — the on-disk shape IS the
    // in-memory PathKey, so the equality is direct.
    expect(persistedList?.[0]).toBe(literalDotKey)
    expect(persistedList?.[0]).not.toBe(dottedSegmentsKey)
  })

  it('plain segments still round-trip cleanly (the common case)', () => {
    const incomeKey = canonicalizePath(['income']).key
    const userNameKey = canonicalizePath(['user', 'name']).key

    const payload = buildPersistedPayload(
      { income: 0, user: { name: '' } },
      'form',
      new Map(),
      new Map(),
      new Set<PathKey>([incomeKey, userNameKey])
    )

    const read = readPersistedPayload<{ income: number; user: { name: string } }>(
      JSON.parse(JSON.stringify(payload))
    )
    expect(read?.data.blankPaths).toHaveLength(2)
    expect(read?.data.blankPaths).toEqual(expect.arrayContaining([incomeKey, userNameKey]))
  })

  it('a v=5 payload (the dotted-shape predecessor) is dropped', () => {
    const stale = { v: 5, data: { form: { income: 0 }, blankPaths: ['income'] } }
    const read = readPersistedPayload<{ income: number }>(stale)
    expect(read).toBeNull()
  })

  it('a v=6 payload with no blank set omits the field', () => {
    const payload = buildPersistedPayload({ income: 5 }, 'form', new Map(), new Map(), new Set())
    expect(payload.data.blankPaths).toBeUndefined()
  })
})
