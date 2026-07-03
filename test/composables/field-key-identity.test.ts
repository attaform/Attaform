// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { useAbstractForm as useForm } from '../../src/abstract'
import { attachRegistryToApp, createRegistry } from '../../src/runtime/core/registry'
import type { UseFormReturnType } from '../../src/runtime/types/types-api'
import { fakeSchema } from '../utils/fake-schema'

/**
 * Runtime coverage for `FieldState.key`: the allocated identity token an
 * array element carries across structural mutations. Read through the
 * `form.fields` surface, the way a `v-for` template would reach for a
 * `:key`. Reorder semantics are pinned at the tracker level in
 * `test/core/array-identity.test.ts`; here we confirm the token reaches
 * the field surface and refreshes reactively.
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
        key: `lk-${Math.random().toString(36).slice(2)}`,
      })
      return () => h('div')
    },
  })
  const app = createApp(Probe)
  attachRegistryToApp(app, createRegistry())
  app.mount(document.createElement('div'))
  return { app, form: captured }
}

// Read FieldState.key through the call form. The terminal surface
// resolves state keys directly, whereas dot/bracket access descends at
// container paths (an object element like `rows.0`). `form.list` wraps
// this same read for iteration.
function fieldKeyAt(form: UseFormReturnType<ListForm>, path: string): string {
  const fields = form.fields as unknown as (p: string) => { readonly key: string }
  return fields(path).key
}

function elementKey(
  form: UseFormReturnType<ListForm>,
  path: 'tags' | 'rows',
  index: number
): string {
  return fieldKeyAt(form, `${path}.${index}`)
}

function tagKeys(form: UseFormReturnType<ListForm>, length: number): string[] {
  return Array.from({ length }, (_, i) => elementKey(form, 'tags', i))
}

describe('FieldState.key — element identity', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('is empty for fields that are not array elements', () => {
    const { app, form } = harness({ tags: ['a'], rows: [{ name: 'x' }] })
    apps.push(app)
    expect(fieldKeyAt(form, 'title')).toBe('')
    expect(fieldKeyAt(form, 'tags')).toBe('')
    expect(fieldKeyAt(form, 'rows')).toBe('')
    expect(form.meta.key).toBe('')
  })

  it('assigns a stable, distinct key to each array element', () => {
    const { app, form } = harness({ tags: ['a', 'b', 'c'] })
    apps.push(app)
    const k = tagKeys(form, 3)
    expect(k.every((s) => s.length > 0)).toBe(true)
    expect(new Set(k).size).toBe(3)
    expect(tagKeys(form, 3)).toEqual(k)
  })

  it('keeps distinct identity for duplicate element values', () => {
    const { app, form } = harness({ tags: ['dup', 'dup'] })
    apps.push(app)
    const [k0, k1] = tagKeys(form, 2)
    expect(k0).not.toBe(k1)
  })

  it('a token follows its element across a move', () => {
    const { app, form } = harness({ tags: ['a', 'b', 'c'] })
    apps.push(app)
    const [kA, kB, kC] = tagKeys(form, 3)
    form.move('tags', 0, 2)
    expect(tagKeys(form, 3)).toEqual([kB, kC, kA])
  })

  it('survivors keep their identity across a remove', () => {
    const { app, form } = harness({ tags: ['a', 'b', 'c'] })
    apps.push(app)
    const [kA, , kC] = tagKeys(form, 3)
    form.remove('tags', 1)
    expect(tagKeys(form, 2)).toEqual([kA, kC])
  })

  it('append keeps existing identities and allocates for the tail', () => {
    const { app, form } = harness({ tags: ['a', 'b'] })
    apps.push(app)
    const before = tagKeys(form, 2)
    form.append('tags', 'c')
    const after = tagKeys(form, 3)
    expect(after.slice(0, 2)).toEqual(before)
    expect(after[2]).not.toBe(before[1])
  })

  it('prepend shifts existing identities and allocates the new head', () => {
    const { app, form } = harness({ tags: ['a', 'b'] })
    apps.push(app)
    const before = tagKeys(form, 2)
    form.prepend('tags', 'z')
    const after = tagKeys(form, 3)
    expect(after.slice(1)).toEqual(before)
    expect(after[0]).not.toBe(before[0])
  })

  it('swap exchanges identities at the two slots', () => {
    const { app, form } = harness({ tags: ['a', 'b', 'c'] })
    apps.push(app)
    const [kA, kB, kC] = tagKeys(form, 3)
    form.swap('tags', 0, 2)
    expect(tagKeys(form, 3)).toEqual([kC, kB, kA])
  })

  it('replace resets identity at the slot, leaving siblings', () => {
    const { app, form } = harness({ tags: ['a', 'b', 'c'] })
    apps.push(app)
    const before = tagKeys(form, 3)
    form.replace('tags', 1, 'B')
    const after = tagKeys(form, 3)
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    expect(after[2]).toBe(before[2])
  })

  it('object-element containers carry identity and it follows a swap', () => {
    const { app, form } = harness({ rows: [{ name: 'a' }, { name: 'b' }] })
    apps.push(app)
    const k0 = elementKey(form, 'rows', 0)
    const k1 = elementKey(form, 'rows', 1)
    expect(k0).not.toBe('')
    expect(k0).not.toBe(k1)
    form.swap('rows', 0, 1)
    expect(elementKey(form, 'rows', 0)).toBe(k1)
    expect(elementKey(form, 'rows', 1)).toBe(k0)
  })
})
