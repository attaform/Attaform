// @vitest-environment jsdom
/**
 * Aria / directive display-state isolation lock — the directive-path companion
 * to render-isolation.lock.test.ts (PERF-ANALYSIS.md row P3 + its open
 * `ariaDisplayState` follow-up).
 *
 * THE FOLLOW-UP THIS CLOSES
 *
 *   P3 found that editing one field recomputed every field's `form.fields(path)`
 *   computed (O(F)), and busted it (lazy `formMeta` + own-key blank). The open
 *   question was whether the v-register DIRECTIVE path shared the cost: with
 *   `autoAria` on (the default), the directive reads `RegisterValue.ariaDisplayState`,
 *   which is `computed(() => getDisplayStateAt(segments))` =
 *   `getRootFieldStateAt(segments).value.displayState` (register-api.ts:334,
 *   build-form-api.ts:304) — the SAME field-state accessor `form.fields` uses,
 *   built over the same P3-lazy `getFormMetaBase`. So a register-only form with
 *   no component reading `form.fields` could still recompute the display engine
 *   O(F) times per keystroke. render-isolation.lock measures COMPONENT renders,
 *   not this directive-update recompute, so it didn't cover the path.
 *
 * WHY A REDUCER-CALL COUNTER, NOT A RENDER / EFFECT COUNTER
 *
 *   `ariaDisplayState` returns a STRING. Vue 3.4+ short-circuits a computed whose
 *   recomputed value is equal, so a component render or a `watchEffect` reading
 *   `ariaDisplayState.value` would NOT re-run when a sibling's display engine
 *   recomputes to the same string — a render/effect counter reads 0 siblings
 *   EVEN IF the engine ran (the exact wasted-recompute cost the follow-up flagged).
 *   The `getDisplayState` reducer, by contrast, runs DURING every field-state
 *   recompute, before any value comparison. Counting reducer invocations per path
 *   therefore counts display-engine recomputes directly, value-equality-proof.
 *   Pre-bust this would read O(F) siblings; post-bust it reads 0.
 *
 * HARNESS: a counting `getDisplayState` that delegates to `defaultDisplayState`
 * (behavior unchanged — we only tally), and one `watchEffect` per field reading
 * `ariaDisplayState.value` (the directive's reactive shape: read the verdict,
 * write `aria-*`). Edit one field; assert its engine recomputed (sanity) and the
 * siblings' did not. Both adapters — the accessor is shared core.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, watchEffect, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import { defaultDisplayState } from '../../src/runtime/core/display-state'
import type { GetDisplayState } from '../../src/runtime/types/types-api'
import { wait } from '../utils/form-harness'

const ADAPTERS = [
  { name: 'zod-v4', z: zV4 as any, useForm: useFormV4 as any },
  { name: 'zod-v3', z: zV3 as any, useForm: useFormV3 as any },
] as const

/** Cover the 0 ms validation debounce (setTimeout) + reactive flush. */
async function settle(): Promise<void> {
  await wait(20)
  await nextTick()
  await nextTick()
}

describe.each(ADAPTERS)(
  'aria/directive display-state isolation on a keystroke ($name)',
  (adapter) => {
    const apps: App[] = []
    let keySeq = 0

    // Reducer-call counter keyed by dotted path. The display engine runs the
    // reducer on every field-state recompute, so this counts recomputes directly
    // (value-equality-proof, unlike a render/effect counter). Cleared after the
    // initial mount+settle so counts reflect only the scripted write.
    const reducerCalls = new Map<string, number>()
    const countingGetDisplayState: GetDisplayState = (prev, ctx) => {
      const key = (ctx.field.path as ReadonlyArray<string | number>).join('.')
      reducerCalls.set(key, (reducerCalls.get(key) ?? 0) + 1)
      return defaultDisplayState(prev, ctx)
    }

    afterEach(() => {
      while (apps.length > 0) apps.pop()?.unmount()
      document.body.innerHTML = ''
      reducerCalls.clear()
    })

    const LEAVES = ['a', 'b', 'c', 'd', 'e'] as const

    /** Register-only autoAria form; one ariaDisplayState-reading effect per field. */
    function mountAutoAriaForm(): any {
      keySeq += 1
      let form: any
      const Harness = defineComponent({
        setup() {
          form = adapter.useForm({
            schema: adapter.z.object({
              a: adapter.z.string().min(2),
              b: adapter.z.string(),
              c: adapter.z.string(),
              d: adapter.z.string(),
              e: adapter.z.string().min(3),
            }),
            key: `aria-${adapter.name}-${keySeq}`,
            defaultValues: { a: '', b: '', c: '', d: '', e: '' },
            strict: false,
            validateOn: 'change',
            debounceMs: 0,
            autoAria: true,
            getDisplayState: countingGetDisplayState,
          })
          // Mimic the v-register directive: per field, an effect that reads
          // ariaDisplayState.value (autoAria) and would write aria-* to the node.
          for (const p of LEAVES) {
            const rv = form.register(p, { autoAria: true })
            watchEffect(() => {
              void rv.ariaDisplayState?.value
            })
          }
          return () => h('div')
        },
      })
      const app = createApp(Harness).use(createAttaform())
      const root = document.createElement('div')
      document.body.appendChild(root)
      app.mount(root)
      apps.push(app)
      return form
    }

    it('editing one field recomputes only that field’s display engine, not siblings’', async () => {
      const form = mountAutoAriaForm()
      await settle()
      reducerCalls.clear()

      form.setValue('a', 'Ada')
      await settle()

      const calls = Object.fromEntries(reducerCalls)
      // The edited field's engine ran (sanity: the write landed and the directive
      // re-read its verdict).
      expect(calls['a'] ?? 0).toBeGreaterThanOrEqual(1)
      // Siblings' engines did NOT recompute. P3 made the shared field-state
      // accessor granular; ariaDisplayState reads it, so the directive path
      // inherits the isolation. A regression that re-adds a whole-form dep turns
      // these O(F).
      for (const p of ['b', 'c', 'd', 'e']) {
        expect(calls[p] ?? 0, `sibling "${p}" display engine must not recompute`).toBe(0)
      }
    })

    it('a form-level change recomputes EVERY field’s engine (control: the harness sees O(F) when it is real)', async () => {
      const form = mountAutoAriaForm()
      await settle()
      reducerCalls.clear()

      // A submit bumps `submissionAttempts` — a form-level scalar every field's
      // display engine tracks EAGERLY (the P3 bust kept scalars eager precisely so
      // form-level changes still reach every field). So every field's engine must
      // recompute. This proves the reducer counter registers broad recompute, so
      // the 0-siblings result on the leaf edit above is genuine isolation, not a
      // dead harness — and it standing-locks the eager-scalar refinement.
      await form.handleSubmit(() => undefined)()
      await settle()

      const calls = Object.fromEntries(reducerCalls)
      for (const p of LEAVES) {
        expect(
          calls[p] ?? 0,
          `field "${p}" engine should recompute on a form-level change`
        ).toBeGreaterThanOrEqual(1)
      }
    })
  }
)
