// @vitest-environment jsdom
/**
 * Interaction records follow their rows through undo and redo (#709).
 *
 * `touched`, `interacted` and `blurredAfterInteraction` record that the user
 * worked on a field, and history never rewinds them. The typed array ops move
 * each row's records with the row; a history restore used to leave them where
 * the last op put them, so after undoing a swap the flags sat on the rows
 * that took the old slots, a removed row came back with none, and undoing a
 * prepend left the new row's flags on the row that slid into its slot.
 *
 * A restore now moves each record with its row, by identity: a row on both
 * sides keeps its own records, every flag set since included; a row the
 * restore takes away hands its history to the array and its ancestors, as a
 * typed `remove` does; a row it brings back gets the records it had when it
 * left. The reveal gate reads those records, so each row shows its own
 * verdict after every step.
 *
 * Row `a` and row `c` fail `min(2)`; only the rows a test works on are
 * flagged, so a verdict that shows on the wrong row is a misplaced record.
 * Mirrored across both adapters: history and the array bookkeeping are
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
import { makeMounter, untilNotPending, untilSettled } from '../utils/form-harness'

const ADAPTERS = [
  { name: 'zod-v4', z: zV4 as any, useForm: useFormV4 as any },
  { name: 'zod-v3', z: zV3 as any, useForm: useFormV3 as any },
] as const

type Adapter = (typeof ADAPTERS)[number]

const ROWS = [
  { n: 'a', items: [{ q: 'a1' }, { q: 'a2' }] },
  { n: 'bb', items: [] },
  { n: 'c', items: [{ q: 'c1' }] },
]

const ALL = { touched: true, interacted: true, blurredAfterInteraction: true }
const NONE = { touched: false, interacted: false, blurredAfterInteraction: false }

const apps: App[] = []

afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
})

function mount(adapter: Adapter): any {
  const { z } = adapter
  const schema = z.object({
    rows: z.array(z.object({ n: z.string().min(2), items: z.array(z.object({ q: z.string() })) })),
  })
  const { api, app } = makeMounter(adapter.useForm, schema, {
    defaultValues: { rows: ROWS },
    history: historyPlugin(),
  })()
  apps.push(app)
  return api
}

const flags = (form: any, path: string) => {
  const state = form.fields(path)
  return {
    touched: state.touched,
    interacted: state.interacted,
    blurredAfterInteraction: state.blurredAfterInteraction,
  }
}

const names = (form: any): string[] => form.values.rows.map((row: any) => row.n)

async function displayAt(form: any, path: string): Promise<string> {
  await untilSettled(form)
  await untilNotPending(() => form.fields(path))
  return form.fields(path).displayState
}

describe.each(ADAPTERS)('$name: interaction records follow their rows', (adapter) => {
  it('after a swap, undo and redo put the flags back on their own row', async () => {
    const form = mount(adapter)
    await form.interact('rows.0')
    form.swap('rows', 0, 2)
    expect(flags(form, 'rows.2.n')).toEqual(ALL)
    expect(flags(form, 'rows.0.n')).toEqual(NONE)

    form.history.undo()
    expect(names(form)).toEqual(['a', 'bb', 'c'])
    expect(flags(form, 'rows.0.n')).toEqual(ALL)
    expect(flags(form, 'rows.0.items.1.q')).toEqual(ALL)
    expect(flags(form, 'rows.2.n')).toEqual(NONE)
    expect(flags(form, 'rows.2.items.0.q')).toEqual(NONE)

    form.history.redo()
    expect(names(form)).toEqual(['c', 'bb', 'a'])
    expect(flags(form, 'rows.2.n')).toEqual(ALL)
    expect(flags(form, 'rows.0.n')).toEqual(NONE)
  })

  it('a removed row that was touched comes back touched', () => {
    const form = mount(adapter)
    form.touch('rows.0.n')
    form.remove('rows', 0)
    expect(form.fields('rows').touched).toBe(true)
    expect(form.fields('rows.0.n').touched).toBe(false)

    form.history.undo()
    expect(names(form)).toEqual(['a', 'bb', 'c'])
    expect(form.fields('rows.0.n').touched).toBe(true)
    expect(form.fields('rows.1.n').touched).toBe(false)
    expect(form.fields('rows.2.n').touched).toBe(false)

    // Redo takes it away again; the array keeps its history.
    form.history.redo()
    expect(names(form)).toEqual(['bb', 'c'])
    expect(form.fields('rows.0.n').touched).toBe(false)
    expect(form.fields('rows').touched).toBe(true)

    form.history.undo()
    expect(form.fields('rows.0.n').touched).toBe(true)
  })

  it('a removed row comes back with every flag it had, nested rows included', async () => {
    const form = mount(adapter)
    await form.interact('rows.0')
    form.remove('rows', 0)
    form.history.undo()
    expect(flags(form, 'rows.0.n')).toEqual(ALL)
    expect(flags(form, 'rows.0.items.0.q')).toEqual(ALL)
    expect(flags(form, 'rows.0.items.1.q')).toEqual(ALL)
    expect(flags(form, 'rows.1.n')).toEqual(NONE)
  })

  it('undoing an append leaves its flags on no other row, and redo brings them back', async () => {
    const form = mount(adapter)
    form.append('rows', { n: 'x', items: [] })
    await form.interact('rows.3')
    form.history.undo()
    expect(names(form)).toEqual(['a', 'bb', 'c'])
    for (const index of [0, 1, 2]) expect(flags(form, `rows.${index}.n`)).toEqual(NONE)
    // The row's history stays with the array, as for a typed `remove`.
    expect(flags(form, 'rows')).toEqual(ALL)

    form.history.redo()
    expect(names(form)).toEqual(['a', 'bb', 'c', 'x'])
    expect(flags(form, 'rows.3.n')).toEqual(ALL)
    for (const index of [0, 1, 2]) expect(flags(form, `rows.${index}.n`)).toEqual(NONE)
  })

  it('undoing a prepend leaves its flags on no other row', async () => {
    const form = mount(adapter)
    form.prepend('rows', { n: 'x', items: [] })
    await form.interact('rows.0')
    form.history.undo()
    expect(names(form)).toEqual(['a', 'bb', 'c'])
    for (const index of [0, 1, 2]) expect(flags(form, `rows.${index}.n`)).toEqual(NONE)

    form.history.redo()
    expect(flags(form, 'rows.0.n')).toEqual(ALL)
    expect(flags(form, 'rows.1.n')).toEqual(NONE)
  })

  it('a flag set after the position was taken stays with its row through the undo', async () => {
    const form = mount(adapter)
    form.swap('rows', 0, 2)
    await form.interact('rows.0')
    form.history.undo()
    // Row `c`, flagged at index 0 after the swap, is back at index 2.
    expect(flags(form, 'rows.2.n')).toEqual(ALL)
    expect(flags(form, 'rows.0.n')).toEqual(NONE)
    form.history.redo()
    expect(flags(form, 'rows.0.n')).toEqual(ALL)
    expect(flags(form, 'rows.2.n')).toEqual(NONE)
  })

  it('a nested list follows its own rows, and its parent row', async () => {
    const form = mount(adapter)
    await form.interact('rows.0.items.1')
    form.swap('rows.0.items', 0, 1)
    form.remove('rows', 0)
    expect(flags(form, 'rows.0.items.0.q')).toEqual(NONE)

    form.history.undo()
    expect(form.values.rows[0].items).toEqual([{ q: 'a2' }, { q: 'a1' }])
    expect(flags(form, 'rows.0.items.0.q')).toEqual(ALL)
    expect(flags(form, 'rows.0.items.1.q')).toEqual(NONE)

    form.history.undo()
    expect(form.values.rows[0].items).toEqual([{ q: 'a1' }, { q: 'a2' }])
    expect(flags(form, 'rows.0.items.1.q')).toEqual(ALL)
    expect(flags(form, 'rows.0.items.0.q')).toEqual(NONE)

    form.history.redo()
    form.history.redo()
    expect(names(form)).toEqual(['bb', 'c'])
    expect(flags(form, 'rows.1.items.0.q')).toEqual(NONE)
  })

  it('the reveal gate shows each row its own verdict after every step', async () => {
    const form = mount(adapter)
    await form.interact('rows.0')
    expect(await displayAt(form, 'rows.0.n')).toBe('error')
    expect(await displayAt(form, 'rows.2.n')).toBe('idle')

    form.swap('rows', 0, 2)
    expect(await displayAt(form, 'rows.2.n')).toBe('error')
    expect(await displayAt(form, 'rows.0.n')).toBe('idle')

    form.history.undo()
    expect(await displayAt(form, 'rows.0.n')).toBe('error')
    expect(await displayAt(form, 'rows.2.n')).toBe('idle')

    form.remove('rows', 0)
    expect(await displayAt(form, 'rows.1.n')).toBe('idle')

    form.history.undo()
    expect(await displayAt(form, 'rows.0.n')).toBe('error')
    expect(await displayAt(form, 'rows.2.n')).toBe('idle')

    form.history.redo()
    expect(await displayAt(form, 'rows.1.n')).toBe('idle')
  })
})
