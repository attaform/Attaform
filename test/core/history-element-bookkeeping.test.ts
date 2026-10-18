// @vitest-environment jsdom
/**
 * Undo and redo put back the per-element bookkeeping a typed array op moves
 * (#705).
 *
 * A typed op moves each element's baseline, blank membership and identity
 * with the element, and drops a removed element's. A history position used to
 * restore the value alone, by position, so after undoing a `remove`, a `swap`
 * or a `move` every row compared against the baseline of whichever row sat
 * there, and the identity order read reordered: the form read dirty with its
 * value back at its baseline. Each position now carries that bookkeeping, and
 * restores it with the value, against the baseline it was taken under.
 *
 * Row 1's `memo` is marked blank through `unset`, so a shift moves a blank
 * baseline too. Mirrored across both adapters: history and the array
 * bookkeeping are shared core.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it } from 'vitest'
import type { App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { historyPlugin } from '../../src/history'
import { unset as unsetV4, useForm as useFormV4 } from '../../src/zod-v4'
import { unset as unsetV3, useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'

const ADAPTERS = [
  { name: 'zod-v4', z: zV4 as any, useForm: useFormV4 as any, unset: unsetV4 as unknown },
  { name: 'zod-v3', z: zV3 as any, useForm: useFormV3 as any, unset: unsetV3 as unknown },
] as const

type Adapter = (typeof ADAPTERS)[number]

const makeSchema = (z: any): any =>
  z.object({
    note: z.string(),
    rows: z.array(z.object({ n: z.string(), memo: z.string().optional() })),
  })

const BASELINE = [{ n: 'a', memo: 'ma' }, { n: 'b' }, { n: 'c', memo: 'mc' }]

const apps: App[] = []

afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
})

function mount(adapter: Adapter): any {
  const { api, app } = makeMounter(adapter.useForm, makeSchema(adapter.z), {
    defaultValues: {
      note: 'n',
      rows: [
        { n: 'a', memo: 'ma' },
        { n: 'b', memo: adapter.unset },
        { n: 'c', memo: 'mc' },
      ],
    },
    validateOn: 'submit',
    history: historyPlugin(),
  })()
  apps.push(app)
  return api
}

/** Every row and leaf reads pristine, and so does every container above. */
function expectPristine(form: any): void {
  expect(form.values.rows).toEqual(BASELINE)
  expect(form.meta.dirty).toBe(false)
  expect(form.fields(['rows']).dirty).toBe(false)
  for (let i = 0; i < 3; i++) {
    expect(form.fields(['rows', i]).dirty).toBe(false)
    expect(form.fields(['rows', i, 'n']).dirty).toBe(false)
    expect(form.fields(['rows', i, 'memo']).dirty).toBe(false)
  }
}

/** Every `form.list` key is set and distinct, one per row. */
function expectKeysMatch(form: any): void {
  const keys = form.list('rows').map((field: any) => field.key)
  expect(keys).toHaveLength(form.values.rows.length)
  expect(new Set(keys).size).toBe(keys.length)
}

const OPS: ReadonlyArray<readonly [string, (form: any) => void]> = [
  ['remove first', (form) => form.remove('rows', 0)],
  ['remove last', (form) => form.remove('rows', 2)],
  ['swap', (form) => form.swap('rows', 0, 2)],
  ['move', (form) => form.move('rows', 0, 2)],
  ['insert', (form) => form.insert('rows', 1, { n: 'x' })],
  ['replace', (form) => form.replace('rows', 1, { n: 'x' })],
]

describe.each(ADAPTERS)('$name: history restores per-element bookkeeping', (adapter) => {
  describe.each(OPS)('%s', (_name, op) => {
    it('undo reads pristine, row by row', () => {
      const form = mount(adapter)
      op(form)
      expect(form.meta.dirty).toBe(true)
      expect(form.history.undo()).toBe(true)
      expectPristine(form)
      expectKeysMatch(form)
    })

    it('redo reads dirty again, with the value it had', () => {
      const form = mount(adapter)
      op(form)
      const after = JSON.parse(JSON.stringify(form.values.rows))
      form.history.undo()
      expect(form.history.redo()).toBe(true)
      expect(form.values.rows).toEqual(after)
      expect(form.meta.dirty).toBe(true)
      expectKeysMatch(form)
    })
  })

  it('an undo past an edit puts back the bookkeeping of the position it lands on', () => {
    const form = mount(adapter)
    form.remove('rows', 0)
    form.setValue('rows.0.n', 'edited')
    form.history.undo()
    // The row that moved to index 0 compares against its own baseline, `b`.
    expect(form.values.rows).toEqual([{ n: 'b' }, { n: 'c', memo: 'mc' }])
    expect(form.fields(['rows', 0]).dirty).toBe(false)
    expect(form.fields(['rows', 1]).dirty).toBe(false)
    expect(form.meta.dirty).toBe(true)
    form.history.undo()
    expectPristine(form)
  })

  it('an undo across a reset restores the value by position, against the new baseline', () => {
    const form = mount(adapter)
    form.remove('rows', 0)
    form.reset()
    expectPristine(form)
    form.history.undo()
    expect(form.values.rows).toEqual([{ n: 'b' }, { n: 'c', memo: 'mc' }])
    expect(form.meta.dirty).toBe(true)
    expectKeysMatch(form)
    form.history.redo()
    expectPristine(form)
  })
})
