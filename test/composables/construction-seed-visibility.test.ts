// @vitest-environment jsdom
/**
 * Characterization: ARE construction-time sync-check error seeds
 * user-visible under default display-state gating on first paint?
 *
 * This is the evidence the stripAsyncChecks revisit trigger asked for
 * (size-teardown P7, agreed 2026-08-23). The answer is YES — the
 * seeds surface through `form.meta.valid` / `form.meta.errors` /
 * `form.errors(path)` on the very first render (a submit button bound
 * to `meta.valid` renders disabled on SSR first paint BECAUSE of the
 * seed), even though the per-field display gate keeps them out of the
 * field UI (`displayState` stays 'idle', `showErrors` false, until
 * interaction). Deleting `stripAsyncChecks` would silently drop these
 * seeds for any schema that also carries an async refine — an
 * observable regression, so the walker stays.
 *
 * The suite pins three facts:
 *  1. strict mode (the default) seeds sync-check violations found on
 *     the starting data, and the seed is meta-visible at first paint;
 *  2. an async refine elsewhere in the schema does NOT eat the seed —
 *     the strip walker preserves construction-seed parity between
 *     async-carrying and async-free schemas;
 *  3. the per-field display gate still hides the seed from the field
 *     UI, and lax mode (`strict: false`) produces no seed at all.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod-v4'
import { createAttaform } from '../../src/runtime/core/plugin'

type MetaView = { valid: boolean; errorCount: number; errors: readonly { path: unknown }[] }
type Surface = {
  meta: MetaView
  errors: (p?: string) => readonly { message: string }[]
  fields: (p: string) => { displayState: string; showErrors: boolean } | undefined
}

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
})

function mount(schema: z.ZodType, key: string, strict?: boolean): Surface {
  const handle: { api?: unknown } = {}
  const App = defineComponent({
    setup() {
      handle.api = useForm({
        schema: schema as never,
        key,
        ...(strict === undefined ? {} : { strict }),
      })
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.mount(document.createElement('div'))
  apps.push(app)
  return handle.api as Surface
}

const withAsyncRefine = () =>
  z.object({
    name: z.string().min(3),
    code: z.string().refine(async () => true, 'async gate'),
  })

const asyncFreeTwin = () =>
  z.object({
    name: z.string().min(3),
    code: z.string(),
  })

describe('construction-time sync-check seeds — first-paint visibility', () => {
  it('strict mode seeds the sync violation and the seed is meta-visible', () => {
    const api = mount(withAsyncRefine(), 'seed-strict-async')
    expect(api.meta.valid).toBe(false)
    expect(api.meta.errorCount).toBe(1)
    expect(api.meta.errors.map((e) => e.path)).toEqual([['name']])
    expect(api.errors('name').length).toBe(1)
    expect(api.errors('name')[0]?.message).toContain('3')
  })

  it('an async refine elsewhere does not eat the seed (strip-walker parity)', () => {
    const withAsync = mount(withAsyncRefine(), 'seed-parity-async')
    const withoutAsync = mount(asyncFreeTwin(), 'seed-parity-sync')
    expect(withAsync.meta.valid).toBe(withoutAsync.meta.valid)
    expect(withAsync.meta.errorCount).toBe(withoutAsync.meta.errorCount)
    expect(withAsync.errors('name').map((e) => e.message)).toEqual(
      withoutAsync.errors('name').map((e) => e.message)
    )
  })

  it('the per-field display gate hides the seed from the field UI at first paint', () => {
    const api = mount(withAsyncRefine(), 'seed-gated')
    expect(api.fields('name')?.displayState).toBe('idle')
    expect(api.fields('name')?.showErrors).toBe(false)
    // The same seed is simultaneously visible on the meta surface —
    // that split is exactly why the seeds count as user-visible.
    expect(api.meta.valid).toBe(false)
  })

  it('lax mode produces no seed at all', () => {
    const api = mount(withAsyncRefine(), 'seed-lax', false)
    expect(api.meta.valid).toBe(true)
    expect(api.meta.errorCount).toBe(0)
    expect(api.errors('name')).toEqual([])
  })
})
