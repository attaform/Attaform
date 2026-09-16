// @vitest-environment jsdom
/**
 * Characterization: ARE construction-time sync-check error seeds
 * user-visible under default display-state gating on first paint?
 *
 * Yes, and that is why this file exists: the seeds surface through
 * `form.meta.valid` / `form.meta.errors` / `form.errors(path)` on the
 * very first render — a submit button bound to `meta.valid` renders
 * disabled on SSR first paint BECAUSE of the seed — even though the
 * per-field display gate keeps them out of the field UI
 * (`displayState` stays 'idle', `showErrors` false, until interaction).
 *
 * WHAT CHANGED, and it is a deliberate trade. A schema that mixes an
 * async refine with sync checks used to seed the sync half anyway: the
 * adapter rebuilt the entire schema with the async predicates removed
 * and parsed against that copy. The walker doing it was 206 lines and a
 * second, parallel understanding of every Zod kind — the shape this
 * codebase keeps finding drifted from the original with nothing to
 * notice. It is gone, and with it the construction seed for exactly
 * that mixed case: the verdict now arrives one async pass later, so on
 * SSR the submit button renders enabled and then disables.
 *
 * Nothing else moved. An async-free schema still seeds at construction,
 * the display gate still hides seeds from the field UI, lax mode still
 * seeds nothing, and the post-mount async pass was already the source of
 * truth for every verdict in every case.
 *
 * The suite pins four facts:
 *  1. strict mode (the default) seeds sync-check violations found on
 *     the starting data, and the seed is meta-visible at first paint;
 *  2. a schema that ALSO carries an async refine defers its whole
 *     verdict to the async pass rather than seeding — the trade above,
 *     pinned so it stays a decision;
 *  3. it converges on the same verdict once that pass lands;
 *  4. the per-field display gate still hides the seed from the field
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

/** Settle the post-mount async validation pass. */
async function waitForValidation(api: Surface): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    if (api.meta.errorCount > 0) return
  }
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
    const api = mount(asyncFreeTwin(), 'seed-strict-sync')
    expect(api.meta.valid).toBe(false)
    expect(api.meta.errorCount).toBe(1)
    expect(api.meta.errors.map((e) => e.path)).toEqual([['name']])
    expect(api.errors('name').length).toBe(1)
    expect(api.errors('name')[0]?.message).toContain('3')
  })

  it('an async refine elsewhere defers the seed to the async pass', () => {
    // The trade made when the strip walker was deleted. A schema mixing
    // async and sync checks can no longer be parsed at construction
    // without rebuilding it, so it seeds no ERRORS.
    const withAsync = mount(withAsyncRefine(), 'seed-parity-async')
    expect(withAsync.meta.errorCount).toBe(0)
    expect(withAsync.errors('name')).toEqual([])
    // But `meta.valid` is still false, and that is the part worth
    // knowing: a schema declaring async work is clamped invalid until
    // `firstValidationDone` whatever the seeds say. So the first-paint
    // consequence the deletion was expected to have — a submit button
    // bound to `meta.valid` rendering ENABLED on SSR and then disabling
    // — does not happen. The async gate was already covering it, which
    // means the strip walker's construction seed was buying a narrower
    // thing than it appeared to.
    expect(withAsync.meta.valid).toBe(false)
    // Its async-free twin, same sync check, still seeds — so this is
    // about the mixture, not about the check.
    const withoutAsync = mount(asyncFreeTwin(), 'seed-parity-sync')
    expect(withoutAsync.meta.valid).toBe(false)
    expect(withoutAsync.errors('name').length).toBe(1)
  })

  it('converges on the same verdict once the async pass lands', async () => {
    // The half that matters: deferring the seed must not lose it. Both
    // schemas agree about `name` as soon as validation has run once,
    // which is what keeps this a timing change rather than a
    // correctness one.
    const withAsync = mount(withAsyncRefine(), 'seed-converge-async')
    await waitForValidation(withAsync)
    expect(withAsync.meta.valid).toBe(false)
    expect(withAsync.errors('name').length).toBe(1)
    expect(withAsync.errors('name')[0]?.message).toContain('3')
  })

  it('the per-field display gate hides the seed from the field UI at first paint', () => {
    const api = mount(asyncFreeTwin(), 'seed-gated')
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
