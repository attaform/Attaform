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
 * WHY A SCHEMA-SPI COUNTER, NOT A RENDER / EFFECT COUNTER
 *
 *   `ariaDisplayState` returns a STRING. Vue 3.4+ short-circuits a computed whose
 *   recomputed value is equal, so a component render or a `watchEffect` reading
 *   `ariaDisplayState.value` would NOT re-run when a sibling's display engine
 *   recomputes to the same string — a render/effect counter reads 0 siblings
 *   EVEN IF the engine ran (the exact wasted-recompute cost the follow-up flagged).
 *   `AbstractSchema.getFieldMetaAtPath`, by contrast, is called unconditionally
 *   by `buildLeafFieldStateBase` on every field-state rebuild, before any value
 *   comparison. Counting calls per path therefore counts display-engine recomputes
 *   directly, value-equality-proof. Pre-bust this would read O(F) siblings;
 *   post-bust it reads 0.
 *
 * HARNESS: each adapter wrapped in a Proxy that tallies `getFieldMetaAtPath` per
 * path and delegates (behaviour unchanged), driven through `useAbstractForm` so
 * the wrapper reaches the store; plus one `watchEffect` per field reading
 * `ariaDisplayState.value` (the directive's reactive shape: read the verdict,
 * write `aria-*`). Edit one field; assert its engine recomputed (sanity) and the
 * siblings' did not. Both adapters — the accessor is shared core.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, watchEffect, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useAbstractForm } from '../../src/abstract'
import { zodV4Adapter } from '../../src/runtime/adapters/zod-v4/adapter'
import { zodAdapter as zodV3Adapter } from '../../src/runtime/adapters/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { AbstractSchema, SchemaFactoryOptions } from '../../src/runtime/types/types-api'
import type { Path } from '../../src/runtime/core/paths'
import { wait } from '../utils/form-harness'

const ADAPTERS = [
  { name: 'zod-v4', z: zV4 as any, adapt: zodV4Adapter as any },
  { name: 'zod-v3', z: zV3 as any, adapt: zodV3Adapter as any },
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

    // Field-state rebuild counter keyed by dotted path. `buildLeafFieldStateBase`
    // calls `getFieldMetaAtPath` on every rebuild, so this counts recomputes
    // directly (value-equality-proof, unlike a render/effect counter). Cleared
    // after the initial mount+settle so counts reflect only the scripted write.
    const rebuilds = new Map<string, number>()
    function countingAdapter(schema: unknown) {
      return (key: string, options: SchemaFactoryOptions): AbstractSchema<any, any> => {
        const real = adapter.adapt(schema)(key, options) as AbstractSchema<any, any>
        return new Proxy(real, {
          get(target, prop, receiver) {
            if (prop !== 'getFieldMetaAtPath') return Reflect.get(target, prop, receiver)
            return (segments: Path) => {
              const dotted = segments.join('.')
              rebuilds.set(dotted, (rebuilds.get(dotted) ?? 0) + 1)
              return real.getFieldMetaAtPath?.(segments)
            }
          },
        })
      }
    }

    afterEach(() => {
      while (apps.length > 0) apps.pop()?.unmount()
      document.body.innerHTML = ''
      rebuilds.clear()
    })

    const LEAVES = ['a', 'b', 'c', 'd', 'e'] as const

    /** Register-only form; one ariaDisplayState-reading effect per field. */
    function mountAutoAriaForm(): any {
      keySeq += 1
      let form: any
      const zodSchema = adapter.z.object({
        a: adapter.z.string().min(2),
        b: adapter.z.string(),
        c: adapter.z.string(),
        d: adapter.z.string(),
        e: adapter.z.string().min(3),
      })
      const Harness = defineComponent({
        setup() {
          form = useAbstractForm({
            schema: countingAdapter(zodSchema),
            key: `aria-${adapter.name}-${keySeq}`,
            defaultValues: { a: '', b: '', c: '', d: '', e: '' },
            validateOn: 'change',
            debounceMs: 0,
          } as any)
          // Mimic the v-register directive: per field, an effect that reads
          // ariaDisplayState.value and would write aria-* to the node.
          for (const p of LEAVES) {
            const rv = form.register(p)
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
      rebuilds.clear()

      form.setValue('a', 'Ada')
      await settle()

      const calls = Object.fromEntries(rebuilds)
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
      rebuilds.clear()

      // A submit bumps `submissionAttempts` — a form-level scalar every field's
      // display engine tracks EAGERLY (the P3 bust kept scalars eager precisely so
      // form-level changes still reach every field). So every field's engine must
      // recompute. This proves the reducer counter registers broad recompute, so
      // the 0-siblings result on the leaf edit above is genuine isolation, not a
      // dead harness — and it standing-locks the eager-scalar refinement.
      await form.handleSubmit(() => undefined)()
      await settle()

      const calls = Object.fromEntries(rebuilds)
      for (const p of LEAVES) {
        expect(
          calls[p] ?? 0,
          `field "${p}" engine should recompute on a form-level change`
        ).toBeGreaterThanOrEqual(1)
      }
    })
  }
)
