/**
 * Committed-JSON golden-master mechanism for the behavior-lock harness.
 *
 * The repo deliberately uses explicit assertions over vitest snapshots, so
 * this mirrors that ethos: goldens are plain, key-sorted JSON committed
 * under `__golden__/`, compared with an explicit `expect().toEqual()`. We
 * control normalization (in `capture.ts`) and the update incantation
 * (`ATTA_UPDATE_GOLDEN=1`) rather than the `-u` snapshot footgun.
 *
 * Why a golden at all (vs. cross-adapter parity alone): the perf busts
 * target SHARED core (`create-form-store.ts`), which both adapters route
 * through. A regression there moves v3 and v4 identically, so parity stays
 * green while behavior drifts. The golden is the lock that catches it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '__golden__')
const SHOULD_UPDATE = process.env['ATTA_UPDATE_GOLDEN'] === '1'

/**
 * Recursively sort object keys so the serialized golden has a canonical,
 * order-independent shape — clean diffs, and capture-order changes don't
 * spuriously fail.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}

function serialize(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`
}

/**
 * Assert `actual` matches the committed golden for `name`.
 *
 * - Missing golden + local run: write it (bootstrap), pass.
 * - Missing golden + CI: throw — never let an absent golden silently pass.
 * - `ATTA_UPDATE_GOLDEN=1`: rewrite the golden, pass.
 * - Otherwise: deep-equal the parsed structures (precise diff on failure).
 */
export function assertGolden(name: string, actual: unknown): void {
  const file = join(GOLDEN_DIR, `${name}.json`)
  const serialized = serialize(actual)

  if (!existsSync(file)) {
    if (process.env['CI']) {
      throw new Error(
        `[behavior-lock] missing golden "${name}". Generate locally with ATTA_UPDATE_GOLDEN=1 and commit test/perf-lock/__golden__/${name}.json.`
      )
    }
    mkdirSync(GOLDEN_DIR, { recursive: true })
    writeFileSync(file, serialized)
    return
  }

  if (SHOULD_UPDATE) {
    writeFileSync(file, serialized)
    return
  }

  const expected = readFileSync(file, 'utf8')
  expect(JSON.parse(serialized)).toEqual(JSON.parse(expected))
}
