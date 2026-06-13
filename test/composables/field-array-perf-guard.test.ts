// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { computed, createApp, defineComponent, h, type App } from 'vue'
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
 *
 * The same N-independence is guarded on the RENDER side: an in-place reorder
 * reconciles the array without swapping its reference, so only the moved
 * indices' deps fire. The final case counts re-evaluations of one index-bound
 * computed per row across a swap and asserts exactly two recompute, flat in N —
 * a regression to whole-array reassignment fires the array-key dep every row
 * reads, so all N would recompute.
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

type Section = { title: string; questions: { text: string }[] }
type Sectioned = { sections: Section[] }

/** A nested-repeater form: outer `sections`, each with an inner `questions` list. */
function nestedHarness(sections: Section[]) {
  const schema = fakeSchema<Sectioned>({ sections })
  let form!: UseFormReturnType<Sectioned>
  const Probe = defineComponent({
    setup() {
      form = useForm<Sectioned>({ schema, key: `nested-guard-${sections.length}-${Math.random()}` })
      return () => h('div')
    },
  })
  const app = createApp(Probe)
  attachRegistryToApp(app, createRegistry())
  app.mount(document.createElement('div'))
  return { app, form }
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

  /** A row-shaped data object — what the funnel's symbol strip would descend. */
  function isRow(o: unknown): boolean {
    return typeof o === 'object' && o !== null && 'a' in o && 'b' in o && 'c' in o
  }

  /**
   * Row-object visits the funnel's `stripSymbolsDeep` pre-pass makes across one
   * op. It calls `Object.getOwnPropertySymbols` once per plain-object node, so
   * counting those calls (filtered to row shapes, to exclude Vue's own internal
   * calls) is a deterministic proxy for "how much of the array did the strip
   * re-walk." Scoped: only the fresh element. A regression to the whole-array
   * strip re-walks every existing element, so the count scales with N.
   */
  function rowSymbolStripsFor(n: number, op: (form: UseFormReturnType<Grid>) => void): number {
    const h = countingHarness(n)
    apps.push(h.app)
    const real = Object.getOwnPropertySymbols
    let visits = 0
    Reflect.set(Object, 'getOwnPropertySymbols', (o: object) => {
      if (isRow(o)) visits += 1
      return real(o)
    })
    try {
      op(h.form)
    } finally {
      Reflect.set(Object, 'getOwnPropertySymbols', real)
    }
    return visits
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

  it('append symbol-strips only the fresh element, flat in N', () => {
    const small = rowSymbolStripsFor(20, (f) => f.append('rows', newRow()))
    const large = rowSymbolStripsFor(200, (f) => f.append('rows', newRow()))
    // A whole-array strip visits every existing row, so the count would climb
    // by ~N between the two sizes. Scoped, it touches only the one fresh slot,
    // so the two sizes agree within a fresh element's fixed visit count.
    expect(large - small).toBeLessThanOrEqual(FRESH_ELEMENT_CAP)
  })

  it('swap symbol-strips nothing (a reorder introduces no new value)', () => {
    expect(rowSymbolStripsFor(200, (f) => f.swap('rows', 0, 199))).toBeLessThanOrEqual(
      FRESH_ELEMENT_CAP
    )
  })

  /**
   * Re-evaluations of per-row, index-bound bindings across an in-place swap.
   * One computed per row reads its own `rows[i]` — the shape of a
   * `register(...).displayValue` cell binding. The in-place reconcile fires
   * only the two moved indices' deps (not the array-key dep), so only those two
   * computeds recompute; the rest stay cached. A regression to whole-array
   * reassignment fires the array-key dep that EVERY row reads, so all N
   * recompute — the count would scale with N instead of staying at 2.
   */
  function reevalsOnSwap(n: number): number {
    const harness = countingHarness(n)
    apps.push(harness.app)
    const { form } = harness
    const evals = new Array<number>(n).fill(0)
    const cells = Array.from({ length: n }, (_, i) =>
      computed(() => {
        evals[i] = (evals[i] ?? 0) + 1
        return form.values.rows[i]?.a
      })
    )
    // Prime: evaluate each cell once so its index dep is tracked.
    cells.forEach((c) => void c.value)
    evals.fill(0)

    form.swap('rows', 0, n - 1)
    // Pull every cell; only those whose tracked index changed recompute.
    cells.forEach((c) => void c.value)

    return evals.reduce((sum, x) => sum + x, 0)
  }

  it('a swap recomputes only the two moved rows index-bound bindings, flat in N', () => {
    expect(reevalsOnSwap(20)).toBe(2)
    expect(reevalsOnSwap(200)).toBe(2) // flat in N — the two swapped rows only
  })

  /**
   * Re-evaluations of per-section inner-list IDENTITY bindings across an append
   * to ONE inner list of a nested repeater. One computed per section reads
   * `sections[i].questions` by reference — the array handle a
   * `form.list('sections.i.questions')` subscription holds. The deep in-place
   * reconcile keeps the touched inner array's reference (it mutates only the
   * appended slot) AND every untouched section's reference, so NO identity
   * binding recomputes — flat at zero in the number of outer sections. A
   * reconcile that reassigned the outer array would fire every section's index
   * dep (count climbs to the section count); one that reassigned just the
   * touched element would fire that single binding. The length binding on the
   * touched list is the positive control that reactivity is live.
   */
  function nestedAppendReevals(outerSections: number): { identity: number; touchedLen: number } {
    const sections = Array.from({ length: outerSections }, (_, i) => ({
      title: `s${i}`,
      questions: [{ text: `${i}-q0` }],
    }))
    const harness = nestedHarness(sections)
    apps.push(harness.app)
    const { form } = harness

    const identityEvals = new Array<number>(outerSections).fill(0)
    const identityCells = Array.from({ length: outerSections }, (_, i) =>
      computed(() => {
        identityEvals[i] = (identityEvals[i] ?? 0) + 1
        return form.values.sections[i]?.questions
      })
    )
    let touchedLen = 0
    const touchedLenCell = computed(() => {
      touchedLen += 1
      return form.values.sections[0]?.questions.length
    })

    // Prime so every dep is tracked, then zero the counters.
    identityCells.forEach((c) => void c.value)
    void touchedLenCell.value
    identityEvals.fill(0)
    touchedLen = 0

    form.append('sections.0.questions', { text: 'appended' })

    identityCells.forEach((c) => void c.value)
    void touchedLenCell.value

    return { identity: identityEvals.reduce((sum, x) => sum + x, 0), touchedLen }
  }

  it('appending to one inner list recomputes no section identity binding, flat in outer count', () => {
    const small = nestedAppendReevals(4)
    const large = nestedAppendReevals(40)
    // The touched inner array keeps its reference (append mutates the new slot in
    // place) and every untouched section keeps its reference, so no per-section
    // identity binding recomputes — regardless of how many sections exist.
    expect(small.identity).toBe(0)
    expect(large.identity).toBe(0)
    // Positive control: the touched list's length binding DID see the append, so
    // this is not a dead-form false zero.
    expect(small.touchedLen).toBeGreaterThan(0)
    expect(large.touchedLen).toBeGreaterThan(0)
  })
})
