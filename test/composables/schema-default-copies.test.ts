// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { zodAdapter as zodAdapterV4 } from '../../src/runtime/adapters/zod-v4'
import { zodAdapter as zodAdapterV3 } from '../../src/runtime/adapters/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * A schema's `.default(value)` and `.catch(value)` hold one value, which the
 * schema hands back on every parse. The form copies it wherever it fills a
 * slot from it, so two rows never share one list, and an edit to a row never
 * reaches the schema or the next parse.
 */

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
})

function mountWithApp<T>(setup: () => T): T {
  const handle: { captured?: T } = {}
  const Probe = defineComponent({
    setup() {
      handle.captured = setup()
      return () => h('div')
    },
  })
  const app = createApp(Probe).use(createAttaform())
  app.mount(document.createElement('div'))
  apps.push(app)
  if (handle.captured === undefined) throw new Error('mountWithApp: setup never returned')
  return handle.captured
}

describe('schema defaults are copied into the form, zod-V3 adapter', () => {
  const TAGS = ['x']
  const CAUGHT = ['c']
  const META = { inner: { q: 1 } }
  const row = zV3.object({
    n: zV3.string(),
    tags: zV3.array(zV3.string()).default(TAGS),
    meta: zV3.object({ inner: zV3.object({ q: zV3.number() }) }).default(META),
  })
  const schema = zV3.object({ rows: zV3.array(row) })

  function makeForm() {
    return mountWithApp(() =>
      useFormV3({ schema, key: `default-copies-v3-${Math.random()}`, defaultValues: { rows: [] } })
    )
  }

  it('two appended rows hold lists of their own', () => {
    const form = makeForm()
    form.append('rows', { n: 'a' })
    form.append('rows', { n: 'b' })
    form.append('rows.0.tags', 'y')
    expect(form.values.rows[1]?.tags).toEqual(['x'])
  })

  it('an edit inside a row never reaches the schema', () => {
    const form = makeForm()
    form.append('rows', { n: 'a' })
    form.append('rows.0.tags', 'y')
    form.setValue('rows.0.meta.inner.q', 5)
    expect(TAGS).toEqual(['x'])
    expect(META).toEqual({ inner: { q: 1 } })
    expect(row.parse({ n: 'p' })).toEqual({ n: 'p', tags: ['x'], meta: { inner: { q: 1 } } })
  })

  it('a nested default object belongs to its row', () => {
    const form = makeForm()
    form.append('rows', { n: 'a' })
    form.append('rows', { n: 'b' })
    form.setValue('rows.0.meta.inner.q', 5)
    expect(form.values.rows[1]?.meta.inner.q).toBe(1)
  })

  it('derivation hands back a copy of a .default or .catch value', () => {
    const lists = zV3.object({
      d: zV3.array(zV3.string()).default(TAGS),
      c: zV3.array(zV3.string()).catch(CAUGHT),
      m: zV3.object({ inner: zV3.object({ q: zV3.number() }) }).default(META),
    })
    const adapter = zodAdapterV3(lists)('f', { maxRecursionDepth: 64 })
    const first = adapter.getDefaultValues({ useDefaultSchemaValues: true })
    const second = adapter.getDefaultValues({ useDefaultSchemaValues: true })
    expect(first).toEqual({ d: ['x'], c: ['c'], m: { inner: { q: 1 } } })
    expect(first.d).not.toBe(TAGS)
    expect(first.c).not.toBe(CAUGHT)
    expect(first.m?.inner).not.toBe(META.inner)
    expect(first.c).not.toBe(second.c)
  })
})

describe('schema defaults are copied into the form, zod-V4 adapter', () => {
  const TAGS = ['x']
  const CAUGHT = ['c']
  const META = { inner: { q: 1 } }
  const row = zV4.object({
    n: zV4.string(),
    tags: zV4.array(zV4.string()).default(TAGS),
    meta: zV4.object({ inner: zV4.object({ q: zV4.number() }) }).default(META),
  })
  const schema = zV4.object({ rows: zV4.array(row) })

  function makeForm() {
    return mountWithApp(() =>
      useFormV4({ schema, key: `default-copies-v4-${Math.random()}`, defaultValues: { rows: [] } })
    )
  }

  it('two appended rows hold lists of their own', () => {
    const form = makeForm()
    form.append('rows', { n: 'a' })
    form.append('rows', { n: 'b' })
    form.append('rows.0.tags', 'y')
    expect(form.values.rows[1]?.tags).toEqual(['x'])
  })

  it('an edit inside a row never reaches the schema', () => {
    const form = makeForm()
    form.append('rows', { n: 'a' })
    form.append('rows.0.tags', 'y')
    form.setValue('rows.0.meta.inner.q', 5)
    expect(TAGS).toEqual(['x'])
    expect(META).toEqual({ inner: { q: 1 } })
    expect(row.parse({ n: 'p' })).toEqual({ n: 'p', tags: ['x'], meta: { inner: { q: 1 } } })
  })

  it('a nested default object belongs to its row', () => {
    const form = makeForm()
    form.append('rows', { n: 'a' })
    form.append('rows', { n: 'b' })
    form.setValue('rows.0.meta.inner.q', 5)
    expect(form.values.rows[1]?.meta.inner.q).toBe(1)
  })

  it('derivation hands back a copy of a .default or .catch value', () => {
    const lists = zV4.object({
      d: zV4.array(zV4.string()).default(TAGS),
      c: zV4.array(zV4.string()).catch(CAUGHT),
      m: zV4.object({ inner: zV4.object({ q: zV4.number() }) }).default(META),
    })
    const adapter = zodAdapterV4(lists)('f', { maxRecursionDepth: 64 })
    const first = adapter.getDefaultValues({ useDefaultSchemaValues: true })
    const second = adapter.getDefaultValues({ useDefaultSchemaValues: true })
    expect(first).toEqual({ d: ['x'], c: ['c'], m: { inner: { q: 1 } } })
    expect(first.d).not.toBe(TAGS)
    expect(first.c).not.toBe(CAUGHT)
    expect(first.m?.inner).not.toBe(META.inner)
    expect(first.c).not.toBe(second.c)
  })
})
