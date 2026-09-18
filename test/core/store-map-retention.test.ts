// @vitest-environment jsdom
/**
 * Retention pins for the FormStore's own per-path maps (#612's other half).
 *
 * The liveness sweep landed with the caches that READ a path and never
 * reached the maps that RECORD one. So `fields`, `originals`,
 * `authoredPaths` and `fieldValidationState` still grew with every path
 * the form had ever held: a 200-row array emptied with `setValue('rows',
 * [])` left 400 field records, 400 originals entries and 601 authored
 * paths behind, and nothing ever dropped them. Unbounded, for the
 * lifetime of the form.
 *
 * These are `WeakRef`-proof but not `WeakRef`-testable, which is why
 * this file asserts SIZES where its sibling
 * `field-state-cache-retention.test.ts` asserts reachability. The store
 * maps hold bookkeeping, timestamps, interaction flags, an absence
 * baseline of `undefined`: so they pin no consumer value and a
 * reachability probe sees nothing wrong while the entry count climbs
 * without limit.
 *
 * The sweep is deliberately incremental (a bounded slice per write, so
 * the per-write cost stays flat as the form grows), so these drive
 * enough writes to cover the tracked set several times over. That makes
 * "released" a deterministic assertion rather than a timing one.
 */
import { describe, expect, it } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import { useRegistry } from '../../src/runtime/core/registry'

type SizedStore = {
  fields: { size: number }
  originals: { size: number }
  authoredPaths: { size: number }
  fieldValidationState: { size: number }
}

type Probe = { setValue(path: string, value: unknown): unknown }

function mountWithStore(schema: z.ZodObject, defaultValues: unknown) {
  const key = `retain-${Math.random().toString(36).slice(2)}`
  let api: unknown
  let store: unknown
  const App = defineComponent({
    setup() {
      api = (useForm as unknown as (c: unknown) => unknown)({ schema, key, defaultValues })
      store = useRegistry().forms.get(key)
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.config.warnHandler = () => {}
  app.mount(document.createElement('div'))
  return { form: api as Probe, store: store as unknown as SizedStore, app }
}

/**
 * Drive enough no-op writes that the incremental sweep covers the whole
 * tracked set several times. Writing the same empty value keeps the
 * form's state fixed while still advancing the sweep cursor, so this
 * settles the maps without disturbing what is being measured.
 */
function settle(form: Probe, path: string, empty: unknown, times = 200): void {
  for (let i = 0; i < times; i++) form.setValue(path, empty)
}

describe('the store releases per-path bookkeeping when a container shrinks', () => {
  it('emptying a 200-row array drops the rows it no longer has', () => {
    const schema = z.object({ rows: z.array(z.object({ a: z.string(), b: z.string() })) })
    const { form, store, app } = mountWithStore(schema, { rows: [] })
    form.setValue(
      'rows',
      Array.from({ length: 200 }, (_, i) => ({ a: `a${i}`, b: `b${i}` }))
    )
    expect(store.fields.size).toBeGreaterThanOrEqual(400)
    expect(store.originals.size).toBeGreaterThanOrEqual(400)

    form.setValue('rows', [])
    settle(form, 'rows', [])

    expect(store.fields.size).toBe(0)
    expect(store.originals.size).toBe(0)
    // `rows` itself survives: a path the schema shape bounds is never a
    // sweep candidate, which is what keeps a declared-but-absent field
    // from being dropped and rebuilt on a loop.
    expect(store.authoredPaths.size).toBeLessThanOrEqual(1)
    app.unmount()
  })

  it('churning record keys does not accumulate an entry per key ever held', () => {
    const schema = z.object({ prefs: z.record(z.string(), z.string()) })
    const { form, store, app } = mountWithStore(schema, { prefs: {} })
    for (let i = 0; i < 200; i++) {
      form.setValue('prefs', { [`k${i}`]: `v${i}` })
    }
    settle(form, 'prefs', {})
    // One key's worth of bookkeeping, not two hundred.
    expect(store.fields.size).toBeLessThanOrEqual(1)
    expect(store.originals.size).toBeLessThanOrEqual(1)
    expect(store.authoredPaths.size).toBeLessThanOrEqual(1)
    app.unmount()
  })

  it('a live path keeps its bookkeeping, so the sweep is not just a truncation', () => {
    // The counterweight. A fix that released memory by dropping live
    // state would pass the two pins above and break the form.
    const schema = z.object({ rows: z.array(z.object({ a: z.string() })) })
    const { form, store, app } = mountWithStore(schema, { rows: [] })
    form.setValue('rows', [{ a: 'kept' }, { a: 'dropped' }])
    form.setValue('rows', [{ a: 'kept' }])
    settle(form, 'rows', [{ a: 'kept' }])

    expect(store.fields.size).toBe(1)
    expect(store.originals.size).toBe(1)
    app.unmount()
  })

  it('a shrink followed by a regrow rebuilds what it needs', () => {
    const schema = z.object({ rows: z.array(z.object({ a: z.string() })) })
    const { form, store, app } = mountWithStore(schema, { rows: [] })
    form.setValue(
      'rows',
      Array.from({ length: 50 }, (_, i) => ({ a: `a${i}` }))
    )
    form.setValue('rows', [])
    settle(form, 'rows', [])
    expect(store.fields.size).toBe(0)

    form.setValue(
      'rows',
      Array.from({ length: 50 }, (_, i) => ({ a: `b${i}` }))
    )
    expect(store.fields.size).toBe(50)
    expect(store.originals.size).toBe(50)
    app.unmount()
  })
})
