// @vitest-environment jsdom
/**
 * Work a form skips when its schema's root capabilities say nothing can
 * use it (#695), pinned on both adapters.
 *
 * - The authored-path set. The schema-error filter and the write path
 *   read it only where `isPreprocessOrCoerceLeaf` holds, so a schema
 *   with no preprocess or coerce leaf keeps it empty: construction,
 *   `setValue` and `reset()` record nothing. A schema with one keeps
 *   recording, and a verdict at a leaf the consumer authored with
 *   `undefined` still surfaces.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4, zodAdapter as zodAdapterV4 } from '../../src/zod-v4'
import { useForm as useFormV3, zodAdapter as zodAdapterV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import { getRegistryFromApp } from '../../src/runtime/core/registry'
import { wait, waitUntil } from '../utils/form-harness'

/* eslint-disable @typescript-eslint/no-explicit-any */
const ADAPTERS = [
  { name: 'zod-v4', z: zV4 as any, useForm: useFormV4 as any, zodAdapter: zodAdapterV4 as any },
  { name: 'zod-v3', z: zV3 as any, useForm: useFormV3 as any, zodAdapter: zodAdapterV3 as any },
] as const
type Adapter = (typeof ADAPTERS)[number]

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
})

let keySeq = 0

/** Mount one form; returns its API and its store. */
function mount(adapter: Adapter, schema: unknown, options: Record<string, unknown> = {}) {
  const key = `capability-gates-${(keySeq += 1)}`
  const handle: { api?: any } = {}
  const App = defineComponent({
    setup() {
      handle.api = adapter.useForm({ schema, key, ...options })
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.mount(document.createElement('div'))
  apps.push(app)
  const store: any = getRegistryFromApp(app).forms.get(key)
  return { api: handle.api, store }
}

const INVALID_URL = '__invalid__'

for (const adapter of ADAPTERS) {
  const z = adapter.z

  describe(`${adapter.name}: the authored-path set`, () => {
    it('stays empty on a schema with no preprocess or coerce leaf', async () => {
      const schema = z.object({
        name: z.string().min(2),
        rows: z.array(z.object({ a: z.string() })),
      })
      const { api, store } = mount(adapter, schema, {
        defaultValues: { name: 'x', rows: [{ a: 'y' }] },
      })
      expect(store.schema.hasPreprocessOrCoerce()).toBe(false)
      expect(store.authoredPaths.size).toBe(0)

      api.setValue('name', 'zz')
      api.setValue('rows', [{ a: '1' }, { a: '2' }])
      api.reset({ name: 'q', rows: [{ a: '3' }] })
      await wait(20)
      expect(store.authoredPaths.size).toBe(0)
    })

    it('is recorded on a schema with a coerce leaf', () => {
      const schema = z.object({ name: z.string(), age: z.coerce.number() })
      const { store } = mount(adapter, schema, { defaultValues: { name: 'x', age: 3 } })
      expect(store.schema.hasPreprocessOrCoerce()).toBe(true)
      expect(store.authoredPaths.size).toBe(2)
    })

    it('still surfaces a verdict at a preprocess leaf authored with undefined', async () => {
      const schema = z.object({
        url: z.preprocess(
          (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : INVALID_URL),
          z.string().refine(async (val: string) => val !== INVALID_URL, {
            message: 'Please enter a URL.',
          })
        ),
      })
      const { api } = mount(adapter, schema, { validateOn: 'change', debounceMs: 0 })
      await nextTick()
      await wait(20)
      // Nothing authored the leaf, so the verdict on its blank stays hidden.
      expect(api.errors.url).toEqual([])

      // Writing `undefined` over `undefined` authors the path, which is the
      // only thing that schedules a pass here.
      api.setValue('url', undefined)
      await waitUntil(() => (api.errors.url.length > 0 ? true : null))
      expect(api.errors.url[0]?.message).toBe('Please enter a URL.')
    })
  })
}
/* eslint-enable @typescript-eslint/no-explicit-any */
