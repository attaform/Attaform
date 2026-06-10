// @vitest-environment jsdom
/**
 * P1 — validation-cancel equivalence lock.
 *
 * GUARDS the AbortController → `aborted`-boolean swap on the field
 * validation scheduler (PERF-ANALYSIS.md "P1"). Profiling found the
 * per-keystroke `new AbortController()` at create-form-store.ts:2603 is
 * ~99% of the scheduler's synchronous alloc cost and unpoolable. The
 * validation controller is never a real abort signal — its `.signal`
 * never escapes to a consumer (`validateAtPath` takes none), it carries
 * no listeners, and it is used ONLY as a one-shot latch: `.abort()` at
 * five sites and `.signal.aborted` read at two. So it is a glorified
 * boolean, and a boolean `aborted` field on the entry (which already
 * exists) reproduces it with zero allocation — the same shape the
 * transform subsystem already uses (`holder.aborted`, create-form-store.ts:1731).
 *
 * The five abort sites the swap touches (all supersede / cancel, never a
 * consumer-facing abort):
 *   1. create-form-store.ts:2601 — supersede a prior run on the next schedule
 *   2. create-form-store.ts:2558 — DU variant-reshape: a late async result
 *      can't clobber the sync write
 *   3. create-form-store.ts:2772 — cancelFieldValidation (cancel-all: reset,
 *      handleSubmit, validateAsync, destroy)
 *   4. create-form-store.ts:2797 — cancelFieldValidationUnder (resetField)
 *   5. array-bookkeeping.ts:238   — abortValidationAtVacatedIndices (array remove)
 * Read at create-form-store.ts:2618 (pre-parse) and :2662 (post-resolve).
 *
 * WHY THIS HARNESS EXISTS: the existing field-validation suite only
 * exercises the cancellation sites through the TIMER path — a debounced
 * run whose `clearTimeout` fires before `run()` ever starts, so the
 * `.signal.aborted` reads are never reached. The load-bearing read is the
 * POST-RESOLVE one at :2658: `run()` has already fired, passed the
 * pre-parse guard, and is awaiting the async parse when a supersede/cancel
 * lands; the resolved verdict must then be DROPPED. That in-flight drop is
 * what the swap's correctness hinges on (a one-shot boolean read through
 * the run's own captured entry, surviving the entry's map-deletion exactly
 * as the closure-captured controller did) and it had no coverage. These
 * tests drive a deferred async refine (`makeGate`) so the parse is provably
 * mid-flight when the cancel happens, then release it and assert the stale
 * verdict never lands.
 *
 * The swap is byte-identical, so every test below is GREEN before AND after
 * it. Non-vacuity (that the lock can fail) is carried by the reset (:2772)
 * and resetField (:2797) cases: there the abort latch is the SOLE guard, so
 * neutering the :2662 drop turns exactly those two red (verified). Neither
 * schedules a later run that would win on the form-level epoch gate (:2670) —
 * reset even zeroes lastCommittedEpoch — so a no-op abort lets the stale
 * `async-invalid` COMMIT onto the just-reset field.
 *
 * The supersede (:2601), array-remove (array-bookkeeping.ts:238) and DU
 * variant-reshape (:2558) cases are co-guarded behavioral locks, kept because
 * they drive the same :2662 read through their own abort site:
 *   - supersede: the newer run wins on the epoch gate regardless of the abort.
 *   - array-remove / DU: a SECOND guard removes the target leaf, so a stale
 *     verdict can't surface in `meta.errors` even with the abort no-op'd.
 *     Array-remove: the vacated index is cleared by dropSchemaErrorsAtChangedIndices
 *     (create-form-store.ts:2355). DU: the variant reshape replaces notify.token
 *     with the sync variant's shape. Verified — both stay green with BOTH the
 *     :2662 drop AND the :2670 epoch gate neutered, so neither isolates the
 *     abort; they lock the integration. (The abort is still load-bearing there
 *     for counter bookkeeping — released explicitly at array-bookkeeping.ts:236 —
 *     and as defense-in-depth against a future reshape that stops clearing.)
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'

type Gate = {
  /** The async refine body — resolves only when the test releases it. */
  refine: () => Promise<boolean>
  /** How many refine invocations are currently parked (in-flight). */
  pending: () => number
  /** Release the oldest parked invocation (FIFO = schedule order). */
  release: (verdict: boolean) => void
  /** Release every currently-parked invocation (order-agnostic). */
  releaseAll: (verdict: boolean) => void
}

function makeGate(): Gate {
  const queue: Array<(verdict: boolean) => void> = []
  return {
    refine: () => new Promise<boolean>((resolve) => queue.push(resolve)),
    pending: () => queue.length,
    release: (verdict) => queue.shift()?.(verdict),
    releaseAll: (verdict) => {
      while (queue.length > 0) queue.shift()?.(verdict)
    },
  }
}

async function tick(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

const adapters = [
  {
    name: 'zod-v3',
    z: zV3 as unknown as typeof zV4,
    useForm: useFormV3 as unknown as typeof useFormV4,
  },
  { name: 'zod-v4', z: zV4, useForm: useFormV4 },
] as const

const INVALID = 'async-invalid'

describe.each(adapters)('P1 validation-cancel equivalence — $name', ({ z, useForm }) => {
  const apps: App[] = []
  let keySeq = 0
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    document.body.innerHTML = ''
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function mount(schema: any, options: Record<string, unknown> = {}): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let api: any
    keySeq += 1
    const App = defineComponent({
      setup() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        api = (useForm as any)({
          schema,
          key: `p1-cancel-${keySeq}`,
          strict: false,
          validateOn: 'change',
          debounceMs: 0,
          ...options,
        })
        return () => h('div')
      },
    })
    const app = createApp(App).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    apps.push(app)
    return api
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function hasInvalid(api: any): boolean {
    const errors = api.meta.errors as Array<{ message: string }>
    return errors.some((e) => e.message === INVALID)
  }

  function leafGateSchema(gate: Gate) {
    return z.object({
      name: z.string().refine(() => gate.refine(), { message: INVALID }),
    })
  }

  it('supersede: a newer write drops the prior in-flight run (:2601)', async () => {
    const gate = makeGate()
    const api = mount(leafGateSchema(gate))
    await tick()
    expect(gate.pending()).toBe(0)

    api.setValue('name', 'STALE') // run A fires; its parse starts
    await tick()
    expect(gate.pending()).toBe(1)

    api.setValue('name', 'LIVE') // :2601 aborts A's entry; run B fires
    await tick()
    expect(gate.pending()).toBe(2)

    gate.release(false) // A (FIFO) resolves invalid → dropped at :2658
    gate.release(true) // B resolves clean
    await tick()

    expect(hasInvalid(api)).toBe(false)
  })

  it('cancelFieldValidation via reset() drops an in-flight run (:2768)', async () => {
    const gate = makeGate()
    const api = mount(leafGateSchema(gate))
    await tick()

    api.setValue('name', 'STALE') // run A fires; its parse is in-flight
    await tick()
    expect(gate.pending()).toBe(1)

    api.reset() // cancelFieldValidation aborts A (:2768); zeroes the epoch
    gate.release(false) // A resolves invalid AFTER the cancel
    await tick()

    // Without the abort, A's resolve passes :2658, and reset zeroed
    // lastCommittedEpoch (create-form-store.ts:3619) so A's epoch beats the
    // gate at :2666 and COMMITS a stale 'async-invalid' onto the reset
    // field. The latch (set before the map clear, read via A's own entry)
    // drops it.
    expect(hasInvalid(api)).toBe(false)
  })

  it('cancelFieldValidationUnder via resetField() drops an in-flight run (:2793)', async () => {
    const gate = makeGate()
    const api = mount(leafGateSchema(gate))
    await tick()

    api.setValue('name', 'STALE')
    await tick()
    expect(gate.pending()).toBe(1)

    api.resetField('name') // cancelFieldValidationUnder aborts + deletes A (:2793)
    gate.release(false) // A resolves invalid AFTER the cancel
    await tick()

    expect(hasInvalid(api)).toBe(false)
  })

  it('abortValidationAtVacatedIndices via remove() drops an in-flight run (array-bookkeeping.ts:227)', async () => {
    const gate = makeGate()
    const schema = z.object({
      rows: z.array(
        z.object({
          name: z.string().refine(() => gate.refine(), { message: INVALID }),
        })
      ),
    })
    const api = mount(schema, { defaultValues: { rows: [{ name: '' }] } })
    await tick()
    expect(gate.pending()).toBe(0)

    api.setValue('rows.0.name', 'STALE') // run A fires at rows.0.name; in-flight
    await tick()
    expect(gate.pending()).toBe(1)

    api.remove('rows', 0) // vacates index 0 → aborts A (array-bookkeeping.ts:227)
    gate.release(false) // A resolves invalid AFTER the cancel
    await tick()

    // Co-guarded (see docblock): the vacated leaf is structurally gone, so
    // this locks the integration through the :227 abort site, not the abort
    // in isolation.
    expect(hasInvalid(api)).toBe(false)
  })

  it('DU variant-reshape sync arm drops an in-flight async run at the parent (:2558)', async () => {
    const gate = makeGate()
    const schema = z.object({
      notify: z.discriminatedUnion('channel', [
        z.object({
          channel: z.literal('async'),
          token: z.string().refine(() => gate.refine(), { message: INVALID }),
        }),
        z.object({ channel: z.literal('sync'), label: z.string() }),
      ]),
    })
    const api = mount(schema, { defaultValues: { notify: { channel: 'sync', label: '' } } })
    await tick()

    // Switch INTO the async variant: the reshape's sync arm can't apply (the
    // token refine is async), so it schedules a debounced async validation at
    // the DU parent (create-form-store.ts:2567) — now in-flight. The throwaway
    // sync probe (:2543) also parks phantom entries, but its result is
    // discarded and never reaches the scheduler's commit, so pending > 0 just
    // confirms the real :2567 run is in flight.
    api.setValue('notify.channel', 'async')
    await tick()
    expect(gate.pending()).toBeGreaterThan(0)

    // Switch to the sync variant: the reshape's sync arm applies and aborts
    // the in-flight async at the parent (:2558) before the sync write lands.
    api.setValue('notify.channel', 'sync')
    gate.releaseAll(false) // every in-flight async resolves invalid AFTER the cancel
    await tick()

    // Co-guarded (see docblock): switching to the sync variant removes
    // notify.token, so a stale verdict there can't surface regardless of the
    // abort. This locks the :2558 integration end-to-end, not the abort alone.
    expect(hasInvalid(api)).toBe(false)
  })
})
