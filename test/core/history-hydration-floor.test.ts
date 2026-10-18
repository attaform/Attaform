// @vitest-environment jsdom
/**
 * The hydration floor holds the baseline the resolved defaults adopt (#709).
 *
 * When a `defaultValues` factory resolves, its value lands as a hydration
 * write, and history reseeds from that write as its floor. The form then
 * adopts the value as its baseline, re-seeding `originals` and the row
 * order. The floor used to be taken inside the write, before the adoption,
 * so an undo back to it put the pre-adoption bookkeeping back: the form read
 * dirty with its value at the fetched defaults. History now reseeds once the
 * hydration step has finished.
 *
 * Mirrored across both adapters: history and the activation path are shared
 * core.
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
type Load = { title?: string; rows: { n: string }[] }

const FETCHED: Load = { title: 'T', rows: [{ n: 'a' }, { n: 'b' }, { n: 'c' }] }

const apps: App[] = []

afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
})

async function loaded(adapter: Adapter): Promise<{ form: any; loads: { next: Load } }> {
  const loads = { next: FETCHED }
  const schema = adapter.z.object({
    title: adapter.z.string(),
    rows: adapter.z.array(adapter.z.object({ n: adapter.z.string() })),
  })
  const { api, app } = makeMounter(adapter.useForm, schema, {
    defaultValues: () => Promise.resolve(loads.next),
    history: historyPlugin(),
  })()
  apps.push(app)
  await api.activate()
  return { form: api, loads }
}

function expectPristineAt(form: any, rows: Load['rows']): void {
  expect(form.values.rows).toEqual(rows)
  expect(form.meta.dirty).toBe(false)
  expect(form.fields('rows').dirty).toBe(false)
  rows.forEach((_row, i) => expect(form.fields(['rows', i]).dirty).toBe(false))
}

describe.each(ADAPTERS)('$name: the hydration floor', (adapter) => {
  it('is the only position once the defaults resolve', async () => {
    const { form } = await loaded(adapter)
    expect(form.history.size).toBe(1)
    expect(form.history.canUndo).toBe(false)
  })

  it('an undo of a swap back to it reads pristine', async () => {
    const { form } = await loaded(adapter)
    form.swap('rows', 0, 2)
    expect(form.history.undo()).toBe(true)
    expectPristineAt(form, FETCHED.rows)
  })

  it('an undo of a remove back to it reads pristine', async () => {
    const { form } = await loaded(adapter)
    form.remove('rows', 0)
    form.history.undo()
    expectPristineAt(form, FETCHED.rows)
  })

  it('an undo of an edit back to it reads pristine', async () => {
    const { form } = await loaded(adapter)
    form.setValue('rows.1.n', 'edited')
    form.history.undo()
    expectPristineAt(form, FETCHED.rows)
  })

  it('after rehydrate(), an undo back to it reads the new defaults pristine', async () => {
    const { form, loads } = await loaded(adapter)
    form.setValue('title', 'edited')
    loads.next = { rows: [{ n: 'x' }, { n: 'y' }] }
    await form.rehydrate()
    expect(form.history.canUndo).toBe(false)
    form.swap('rows', 0, 1)
    form.history.undo()
    expect(form.values.rows).toEqual(loads.next.rows)
    expect(form.fields('rows').dirty).toBe(false)
    // The factory leaves the title out, so the unsaved edit survives the
    // rehydrate, and stays dirty.
    expect(form.fields('title').dirty).toBe(true)
  })
})
