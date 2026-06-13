// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { useForm } from '../../src'
import { attachRegistryToApp, createRegistry } from '../../src/runtime/core/registry'
import type { Path } from '../../src/runtime/core/paths'
import type { UseFormReturnType } from '../../src/runtime/types/types-api'
import { fakeSchema } from '../utils/fake-schema'

/**
 * Performance regression guard for the array-mutation write path.
 *
 * A structural array op (append / swap / insert / remove / ...) must scope its
 * per-element work to the element(s) the op actually introduces, never re-walk
 * all N. The write funnel's slim-primitive gate visits each node of the value
 * it validates, calling `getSlimPrimitiveTypesAtPath` once per node, so the
 * call count is a deterministic, non-flaky proxy for "how much of the array did
 * the funnel re-process." Scoped: O(element leaves), independent of N. A
 * regression to whole-array validation makes the count scale with N.
 *
 * The scoping lives in the schema-agnostic funnel (create-form-store), not in
 * either adapter, so a neutral `fakeSchema` is the right instrument here — it
 * isolates the funnel's behaviour from any adapter's parsing specifics.
 */

type Row = { a: string; b: string; c: string }
type Grid = { rows: Row[] }

function makeRows(n: number): Row[] {
  const rows: Row[] = []
  for (let i = 0; i < n; i++) rows.push({ a: `a${i}`, b: `b${i}`, c: `c${i}` })
  return rows
}

function newRow(): Row {
  return { a: 'x', b: 'y', c: 'z' }
}

/** A form whose schema counts every `getSlimPrimitiveTypesAtPath` visit. */
function countingHarness(n: number) {
  const base = fakeSchema<Grid>({ rows: makeRows(n) })
  let slimCalls = 0
  const schema = {
    ...base,
    getSlimPrimitiveTypesAtPath(path: Path) {
      slimCalls += 1
      return base.getSlimPrimitiveTypesAtPath(path)
    },
  }
  let form!: UseFormReturnType<Grid>
  const Probe = defineComponent({
    setup() {
      form = useForm<Grid>({ schema, key: `guard-${n}-${Math.random()}` })
      return () => h('div')
    },
  })
  const app = createApp(Probe)
  attachRegistryToApp(app, createRegistry())
  app.mount(document.createElement('div'))
  return {
    app,
    form,
    reset: () => {
      slimCalls = 0
    },
    calls: () => slimCalls,
  }
}

describe('field arrays — per-element work does not scale with N (perf guard)', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  // One fresh 3-field element costs a fixed number of slim-gate visits (the
  // element node plus its leaves), whatever N is. A generous cap that a
  // whole-array regression (N * that, so 80 at N=20) blows past immediately.
  const FRESH_ELEMENT_CAP = 8

  /** Slim-gate visits an op makes against an N-element form, op timed alone. */
  function callsFor(n: number, op: (form: UseFormReturnType<Grid>) => void): number {
    const h = countingHarness(n)
    apps.push(h.app)
    h.reset()
    op(h.form)
    return h.calls()
  }

  it('append validates only the fresh element, identically at N=20 and N=200', () => {
    const small = callsFor(20, (f) => f.append('rows', newRow()))
    const large = callsFor(200, (f) => f.append('rows', newRow()))
    expect(small).toBeLessThanOrEqual(FRESH_ELEMENT_CAP)
    expect(large).toBe(small) // constant in N — the whole point
  })

  it('insert at the head validates only the fresh element, not the N it shifts', () => {
    const small = callsFor(20, (f) => f.insert('rows', 0, newRow()))
    const large = callsFor(200, (f) => f.insert('rows', 0, newRow()))
    expect(small).toBeLessThanOrEqual(FRESH_ELEMENT_CAP)
    expect(large).toBe(small)
  })

  it('swap validates no elements (a pure reorder introduces no new values)', () => {
    expect(callsFor(200, (f) => f.swap('rows', 0, 199))).toBe(0)
  })

  it('remove validates no elements (it drops, never introduces)', () => {
    expect(callsFor(200, (f) => f.remove('rows', 0))).toBe(0)
  })
})
