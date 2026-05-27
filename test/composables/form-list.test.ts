// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { useForm } from '../../src'
import { attachRegistryToApp, createRegistry } from '../../src/runtime/core/registry'
import type { UseFormReturnType } from '../../src/runtime/types/types-api'
import { fakeSchema } from '../utils/fake-schema'

/**
 * Runtime coverage for `form.list`: the per-element iteration view over
 * an array. Entries are the live `form.fields` terminals, each carrying
 * its element `key`, so a keyed `v-for` survives a reorder.
 */

type ListForm = {
  title: string
  tags: string[]
  rows: { name: string }[]
}

const defaults: ListForm = { title: 't', tags: [], rows: [] }

function harness(initial?: Partial<ListForm>) {
  let captured!: UseFormReturnType<ListForm>
  const Probe = defineComponent({
    setup() {
      captured = useForm<ListForm>({
        schema: fakeSchema<ListForm>({ ...defaults, ...initial }),
        key: `fl-${Math.random().toString(36).slice(2)}`,
      })
      return () => h('div')
    },
  })
  const app = createApp(Probe)
  attachRegistryToApp(app, createRegistry())
  app.mount(document.createElement('div'))
  return { app, form: captured }
}

describe('form.list', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('returns one entry per element, in order, tracking length', () => {
    const { app, form } = harness({ tags: ['a', 'b', 'c'] })
    apps.push(app)
    expect(form.list('tags')).toHaveLength(3)
    expect(form.list('tags').map((row) => row.value)).toEqual(['a', 'b', 'c'])
    form.append('tags', 'd')
    expect(form.list('tags')).toHaveLength(4)
    form.remove('tags', 0)
    expect(form.list('tags').map((row) => row.value)).toEqual(['b', 'c', 'd'])
  })

  it('entries are the same field states the form.fields call form returns', () => {
    const { app, form } = harness({ tags: ['a', 'b'] })
    apps.push(app)
    const fields = form.fields as unknown as (p: string) => unknown
    expect(form.list('tags')[0]).toBe(fields('tags.0'))
    expect(form.list('tags')[1]).toBe(fields('tags.1'))
  })

  it('each entry carries a non-empty key, distinct per row', () => {
    const { app, form } = harness({ tags: ['a', 'b', 'c'] })
    apps.push(app)
    const keys = form.list('tags').map((row) => row.key)
    expect(keys.every((k) => k.length > 0)).toBe(true)
    expect(new Set(keys).size).toBe(3)
  })

  it('a key follows its element across a move', () => {
    const { app, form } = harness({ tags: ['a', 'b', 'c'] })
    apps.push(app)
    const before = new Map(form.list('tags').map((row) => [row.value, row.key]))
    form.move('tags', 0, 2)
    expect(form.list('tags').map((row) => row.value)).toEqual(['b', 'c', 'a'])
    for (const row of form.list('tags')) {
      expect(row.key).toBe(before.get(row.value))
    }
  })

  it('exposes object-element rows, each with its own key', () => {
    const { app, form } = harness({ rows: [{ name: 'a' }, { name: 'b' }] })
    apps.push(app)
    const rows = form.list('rows')
    expect(rows).toHaveLength(2)
    expect(rows[0].key).not.toBe('')
    expect(rows[0].key).not.toBe(rows[1].key)
    const firstKey = rows[0].key
    form.swap('rows', 0, 1)
    expect(form.list('rows')[1].key).toBe(firstKey)
  })

  it('returns a frozen, read-only array', () => {
    const { app, form } = harness({ tags: ['a'] })
    apps.push(app)
    expect(Object.isFrozen(form.list('tags'))).toBe(true)
  })

  it('is empty for an empty array', () => {
    const { app, form } = harness({ tags: [] })
    apps.push(app)
    expect(form.list('tags')).toHaveLength(0)
  })
})
