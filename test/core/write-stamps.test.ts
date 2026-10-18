// @vitest-environment jsdom
/**
 * Recorded write stamps (#705): `updatedAt` at a container is the last write
 * at or under it, removals included, and it never moves backwards.
 *
 * A write that only changes values stamps the leaves it changed, and a
 * container reads the latest of its present leaves and its own record. A
 * write that takes leaves away (a shrink, an empty, a typed `remove`)
 * leaves nothing present that saw it, so it stamps the container and every
 * ancestor up to the root on their own records. Before that, a container
 * read the latest of the leaves present NOW, so a removal-only write left
 * `meta.updatedAt` where it was, or moved it backwards, and no watcher fired.
 *
 * The clock is faked (`Date` only) so every stamp is an exact instant:
 * `T0` at mount, `T1` for a write to another field, `T2` for the operation
 * under test.
 *
 * Mirrored across both adapters: the bookkeeping is shared core, so a
 * regression moves both, and running both keeps the parity explicit.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { renderToString } from '@vue/server-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, createSSRApp, defineComponent, h, watch, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import { useRegistry } from '../../src/runtime/core/registry'
import { hydrateAttaformState, renderAttaformState } from '../../src/runtime/core/serialize'

const ADAPTERS = [
  { name: 'zod-v4', z: zV4 as any, useForm: useFormV4 as any },
  { name: 'zod-v3', z: zV3 as any, useForm: useFormV3 as any },
] as const

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const T1 = T0 + 1_000
const T2 = T0 + 2_000
const iso = (t: number): string => new Date(t).toISOString()

const makeSchema = (z: any): any =>
  z.object({
    note: z.string(),
    tags: z.array(z.string()),
    rows: z.array(z.object({ n: z.string() })),
  })

const defaults = () => ({
  note: 'x',
  tags: ['a', 'b', 'c'],
  rows: [{ n: '1' }, { n: '2' }, { n: '3' }],
})

const apps: App[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
  vi.useRealTimers()
})

type Store = { fields: Map<string, { updatedAt: string | null }> }

function mount(adapter: (typeof ADAPTERS)[number]) {
  const key = `stamps-${Math.random().toString(36).slice(2)}`
  const handle: { form?: any; store?: Store } = {}
  const App = defineComponent({
    setup() {
      handle.form = adapter.useForm({
        schema: makeSchema(adapter.z),
        key,
        defaultValues: defaults(),
        validateOn: 'submit',
      })
      handle.store = useRegistry().forms.get(key) as unknown as Store
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.mount(document.createElement('div'))
  apps.push(app)
  return { form: handle.form, store: handle.store as Store }
}

/** Count `flush: 'sync'` firings of `meta.updatedAt` across `run`. */
function syncFirings(form: any, run: () => void): number {
  let fired = 0
  const stop = watch(
    () => form.meta.updatedAt,
    () => {
      fired++
    },
    { flush: 'sync' }
  )
  run()
  stop()
  return fired
}

const REMOVALS: ReadonlyArray<readonly [string, string, (form: any) => void]> = [
  ['a shrink', 'tags', (form) => form.setValue('tags', ['a'])],
  ['an empty', 'tags', (form) => form.setValue('tags', [])],
  ['a remove', 'tags', (form) => form.remove('tags', 1)],
  ['a remove of the first row', 'rows', (form) => form.remove('rows', 0)],
  ['a rows empty', 'rows', (form) => form.setValue('rows', [])],
]

// Each removal, with the leaf it takes away (or moves out of the way)
// holding the form's newest stamp.
const NEWEST_REMOVALS: ReadonlyArray<readonly [string, string, string, (form: any) => void]> = [
  ['a shrink', 'tags.2', 'tags', (form) => form.setValue('tags', ['a'])],
  ['an empty', 'tags.2', 'tags', (form) => form.setValue('tags', [])],
  ['a remove', 'tags.1', 'tags', (form) => form.remove('tags', 1)],
  ['a remove of the first row', 'rows.0.n', 'rows', (form) => form.remove('rows', 0)],
  ['a rows empty', 'rows.0.n', 'rows', (form) => form.setValue('rows', [])],
]

describe.each(ADAPTERS)('recorded write stamps ($name)', (adapter) => {
  it.each(REMOVALS)(
    '%s stamps the container and the root forward, with one sync firing',
    (_label, container, op) => {
      const { form } = mount(adapter)
      vi.setSystemTime(T1)
      form.setValue('note', 'y')
      expect(form.meta.updatedAt).toBe(iso(T1))

      vi.setSystemTime(T2)
      const fired = syncFirings(form, () => op(form))

      expect(form.meta.updatedAt).toBe(iso(T2))
      expect(form.fields([container]).updatedAt).toBe(iso(T2))
      expect(fired).toBe(1)
    }
  )

  it.each(NEWEST_REMOVALS)(
    '%s taking the newest stamp moves the container and the root forward once',
    (_label, hot, container, op) => {
      const { form } = mount(adapter)
      vi.setSystemTime(T1)
      form.setValue(hot, 'hot')
      vi.setSystemTime(T2)
      // Every reading a sync observer sees on the way, which must never fall
      // back to an older stamp before the removal's lands.
      const seen: (string | null)[] = []
      const stops = [
        watch(
          () => form.meta.updatedAt,
          (value) => seen.push(value),
          { flush: 'sync' }
        ),
        watch(
          () => form.fields([container]).updatedAt,
          (value) => seen.push(value),
          {
            flush: 'sync',
          }
        ),
      ]
      op(form)
      for (const stop of stops) stop()

      expect(seen).toEqual([iso(T2), iso(T2)])
    }
  )

  it('resetField lands its values before its stamp', () => {
    const { form } = mount(adapter)
    vi.setSystemTime(T1)
    form.setValue('tags', ['z'])
    vi.setSystemTime(T2)
    const seen: unknown[] = []
    const stop = watch(
      () => form.meta.updatedAt,
      () => seen.push([...form.values.tags]),
      { flush: 'sync' }
    )
    form.resetField('tags')
    stop()

    expect(seen).toEqual([['a', 'b', 'c']])
  })

  it('a write that changes nothing stamps nothing', () => {
    const { form } = mount(adapter)
    vi.setSystemTime(T1)
    const fired = syncFirings(form, () => {
      form.setValue('note', 'x')
      form.setValue('tags', ['a', 'b', 'c'])
      form.setValue('rows', [{ n: '1' }, { n: '2' }, { n: '3' }])
    })
    expect(fired).toBe(0)
    expect(form.meta.updatedAt).toBe(iso(T0))
    expect(form.fields(['tags']).updatedAt).toBe(iso(T0))
  })

  it('survivors keep their own stamps across an index shift', () => {
    const { form } = mount(adapter)
    vi.setSystemTime(T1)
    form.setValue('rows.2.n', '3x')
    vi.setSystemTime(T2)
    form.remove('rows', 0)

    // The row edited at T1 moved from index 2 to 1, and the untouched row
    // from 1 to 0; each reads its own stamp, not the removal's.
    expect(form.fields(['rows', 1, 'n']).updatedAt).toBe(iso(T1))
    expect(form.fields(['rows', 0, 'n']).updatedAt).toBe(iso(T0))
    expect(form.fields(['rows']).updatedAt).toBe(iso(T2))
  })

  it('an appended row shifted by a later remove keeps its baseline and stamp', () => {
    const { form } = mount(adapter)
    vi.setSystemTime(T1)
    form.append('rows', { n: 'new' })
    vi.setSystemTime(T2)
    form.remove('rows', 0)

    // The appended row moved from index 3 to 2. It is still the row the
    // append wrote: dirty against its absence baseline, stamped at T1.
    const moved = form.fields(['rows', 2, 'n'])
    expect(form.values.rows[2].n).toBe('new')
    expect(moved.dirty).toBe(true)
    expect(moved.updatedAt).toBe(iso(T1))
  })

  it('a removal leaves no record behind at the paths it took away', () => {
    // Twenty rows, more than one write's liveness-sweep slice covers, so
    // the release is the removal's own work and not the sweep's.
    const { form, store } = mount(adapter)
    form.setValue(
      'rows',
      Array.from({ length: 20 }, (_, i) => ({ n: `${i}` }))
    )
    form.setValue('rows', [{ n: '0' }])
    form.remove('tags', 2)

    const keys = [...store.fields.keys()]
    expect(keys.filter((k) => k.startsWith('["rows",') && !k.startsWith('["rows",0'))).toEqual([])
    expect(keys.filter((k) => k.startsWith('["tags",2'))).toEqual([])
  })
})

describe.each(ADAPTERS)('recorded write stamps across SSR ($name)', (adapter) => {
  it('the SSR round trip carries the container stamps', async () => {
    const key = 'stamps-ssr'
    const handle: { form?: any } = {}
    const makeApp = (ssr: boolean): App => {
      const App = defineComponent({
        setup() {
          handle.form = adapter.useForm({
            schema: makeSchema(adapter.z),
            key,
            defaultValues: defaults(),
            validateOn: 'submit',
          })
          return () => h('div')
        },
      })
      const app = ssr ? createSSRApp(App) : createApp(App)
      return app.use(createAttaform({ ssr }))
    }

    const server = makeApp(true)
    await renderToString(server)
    vi.setSystemTime(T1)
    handle.form.setValue('tags', ['a'])
    expect(handle.form.fields(['tags']).updatedAt).toBe(iso(T1))
    const payload = JSON.parse(JSON.stringify(renderAttaformState(server)))

    vi.setSystemTime(T2)
    const client = makeApp(false)
    hydrateAttaformState(client, payload)
    client.mount(document.createElement('div'))
    apps.push(client)

    expect(handle.form.values.tags).toEqual(['a'])
    expect(handle.form.fields(['tags']).updatedAt).toBe(iso(T1))
    expect(handle.form.meta.updatedAt).toBe(iso(T1))
  })
})
