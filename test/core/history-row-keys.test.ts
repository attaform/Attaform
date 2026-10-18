// @vitest-environment jsdom
/**
 * An undo keeps the row keys of a list the position predates tracking (#709).
 *
 * A list's identity tokens, the `form.list` keys a `v-for` renders by, are
 * seeded the first time something reads them or a typed op moves them. A
 * history position taken before that, such as the one taken at mount, holds
 * no tokens for the list, and restoring it used to drop the list's tokens:
 * the next read seeded fresh ones, so every row's key changed and a keyed
 * list remounted every row, focus and component state with it. Such a
 * position held its rows in their baseline order, so the list now takes that
 * order back with its own tokens, at any depth.
 *
 * Mirrored across both adapters: history and the identity tracker are
 * shared core.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it } from 'vitest'
import type { App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { historyPlugin } from '../../src/history'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'

const ADAPTERS = [
  { name: 'zod-v4', z: zV4 as any, useForm: useFormV4 as any },
  { name: 'zod-v3', z: zV3 as any, useForm: useFormV3 as any },
] as const

type Adapter = (typeof ADAPTERS)[number]

const ROWS = [
  { n: 'a', items: [{ q: 'a1' }, { q: 'a2' }] },
  { n: 'b', items: [] },
  { n: 'c', items: [{ q: 'c1' }] },
]

const apps: App[] = []

afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
})

function mount(adapter: Adapter): any {
  const { z } = adapter
  const schema = z.object({
    rows: z.array(z.object({ n: z.string(), items: z.array(z.object({ q: z.string() })) })),
    tags: z.array(z.string()).optional(),
  })
  const { api, app } = makeMounter(adapter.useForm, schema, {
    defaultValues: { rows: ROWS },
    history: historyPlugin(),
  })()
  apps.push(app)
  return api
}

const keys = (form: any, path: string): string[] => form.list(path).map((field: any) => field.key)

describe.each(ADAPTERS)('$name: row keys across undo and redo', (adapter) => {
  it.each([
    ['swap', (form: any) => form.swap('rows', 0, 2)],
    ['move', (form: any) => form.move('rows', 0, 2)],
    ['remove', (form: any) => form.remove('rows', 1)],
    ['insert', (form: any) => form.insert('rows', 1, { n: 'x', items: [] })],
  ] as const)('an undo of a %s to the first position keeps every key', (_name, op) => {
    const form = mount(adapter)
    const before = keys(form, 'rows')
    op(form)
    const after = keys(form, 'rows')
    form.history.undo()
    expect(keys(form, 'rows')).toEqual(before)
    expect(form.meta.dirty).toBe(false)
    form.history.redo()
    expect(keys(form, 'rows')).toEqual(after)
  })

  it('a nested list keeps its keys, at the slot its row lands at', () => {
    const form = mount(adapter)
    const inner = keys(form, 'rows.0.items')
    form.swap('rows', 0, 2)
    form.swap('rows.2.items', 0, 1)
    form.history.undo()
    form.history.undo()
    expect(keys(form, 'rows.0.items')).toEqual(inner)
    expect(form.meta.dirty).toBe(false)
  })

  it('a list first read at another length than the position holds reads pristine there', () => {
    const form = mount(adapter)
    form.setValue('tags', ['t'])
    keys(form, 'tags')
    form.append('tags', 'u')
    form.history.undo()
    form.history.undo()
    expect(form.values.tags).toEqual([])
    expect(form.meta.dirty).toBe(false)
  })
})
