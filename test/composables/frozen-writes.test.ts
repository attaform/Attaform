// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * A frozen or sealed value written into the form (a constant, a store's
 * frozen state, a value handed back frozen) lands as a copy. The form edits
 * what it stores in place, so storing the frozen value itself would make every
 * later write under it fail.
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
  app.config.warnHandler = () => {}
  app.mount(document.createElement('div'))
  apps.push(app)
  if (handle.captured === undefined) throw new Error('mountWithApp: setup never returned')
  return handle.captured
}

describe('frozen values written into the form, zod-V3 adapter', () => {
  const schema = zV3.object({
    tags: zV3.array(zV3.string()),
    rows: zV3.array(zV3.object({ n: zV3.string(), items: zV3.array(zV3.string()) })),
  })

  function makeForm() {
    return mountWithApp(() =>
      useFormV3({
        schema,
        key: `frozen-writes-v3-${Math.random()}`,
        defaultValues: { tags: [], rows: [{ n: 'a', items: [] }] },
      })
    )
  }

  it('a frozen list takes later array ops', () => {
    const form = makeForm()
    const tags = ['a']
    Object.freeze(tags)
    form.setValue('tags', tags)
    form.append('tags', 'b')
    form.swap('tags', 0, 1)
    expect(form.values.tags).toEqual(['b', 'a'])
  })

  it('a frozen row takes later edits, at any depth', () => {
    const form = makeForm()
    const row = { n: 'f', items: ['i'] }
    Object.freeze(row.items)
    Object.freeze(row)
    form.setValue('rows.0', row)
    form.setValue('rows.0.n', 'edited')
    form.append('rows.0.items', 'j')
    expect(form.values.rows[0]).toEqual({ n: 'edited', items: ['i', 'j'] })
  })

  it('a list of frozen rows takes later edits', () => {
    const form = makeForm()
    const row = { n: 'r', items: [] }
    Object.freeze(row)
    form.setValue('rows', [row, row])
    form.setValue('rows.1.n', 'second')
    expect(form.values.rows.map((r) => r.n)).toEqual(['r', 'second'])
  })

  it('a sealed list takes later array ops', () => {
    const form = makeForm()
    const tags = ['a']
    Object.seal(tags)
    form.setValue('tags', tags)
    form.append('tags', 'b')
    expect(form.values.tags).toEqual(['a', 'b'])
  })
})

describe('frozen values written into the form, zod-V4 adapter', () => {
  const schema = zV4.object({
    tags: zV4.array(zV4.string()),
    rows: zV4.array(zV4.object({ n: zV4.string(), items: zV4.array(zV4.string()) })),
  })

  function makeForm() {
    return mountWithApp(() =>
      useFormV4({
        schema,
        key: `frozen-writes-v4-${Math.random()}`,
        defaultValues: { tags: [], rows: [{ n: 'a', items: [] }] },
      })
    )
  }

  it('a frozen list takes later array ops', () => {
    const form = makeForm()
    const tags = ['a']
    Object.freeze(tags)
    form.setValue('tags', tags)
    form.append('tags', 'b')
    form.swap('tags', 0, 1)
    expect(form.values.tags).toEqual(['b', 'a'])
  })

  it('a frozen row takes later edits, at any depth', () => {
    const form = makeForm()
    const row = { n: 'f', items: ['i'] }
    Object.freeze(row.items)
    Object.freeze(row)
    form.setValue('rows.0', row)
    form.setValue('rows.0.n', 'edited')
    form.append('rows.0.items', 'j')
    expect(form.values.rows[0]).toEqual({ n: 'edited', items: ['i', 'j'] })
  })

  it('a list of frozen rows takes later edits', () => {
    const form = makeForm()
    const row = { n: 'r', items: [] }
    Object.freeze(row)
    form.setValue('rows', [row, row])
    form.setValue('rows.1.n', 'second')
    expect(form.values.rows.map((r) => r.n)).toEqual(['r', 'second'])
  })

  it('a sealed list takes later array ops', () => {
    const form = makeForm()
    const tags = ['a']
    Object.seal(tags)
    form.setValue('tags', tags)
    form.append('tags', 'b')
    expect(form.values.tags).toEqual(['a', 'b'])
  })
})
