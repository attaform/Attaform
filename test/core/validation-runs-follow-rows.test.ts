// @vitest-environment jsdom
/**
 * A field's validation run in flight follows its row (#705).
 *
 * A typed array op relocates a row's validation count with the row, but the
 * run it belongs to still counted down at the index it started at. So once a
 * shifted row's check settled, its new index read `validating` for good, and
 * a removal counted down whichever row slid into the vacated index, its own
 * run still in flight. A plain write that took a row away left its run
 * holding `meta.validating` up with nothing present waiting on it.
 *
 * The check is a real async refine held open until the test releases it, so
 * the run is the store's own, from schedule to settle.
 *
 * Mirrored across both adapters: the scheduler and the array bookkeeping are
 * shared core.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { flushMicrotasks, makeMounter, untilSettled } from '../utils/form-harness'

const ADAPTERS = [
  { name: 'zod-v4', z: zV4 as any, useForm: useFormV4 as any },
  { name: 'zod-v3', z: zV3 as any, useForm: useFormV3 as any },
] as const

type Adapter = (typeof ADAPTERS)[number]

let release: () => void = () => {}
let held: Promise<void> = Promise.resolve()

// A value starting with `slow` keeps its check in flight until `release()`.
async function settles(value: string): Promise<boolean> {
  if (value.startsWith('slow')) await held
  return true
}

const makeSchema = (z: any): any =>
  z.object({ rows: z.array(z.object({ n: z.string().refine(settles) })) })

const apps: App[] = []

beforeEach(() => {
  held = new Promise<void>((resolve) => {
    release = resolve
  })
})

afterEach(() => {
  release()
  while (apps.length > 0) apps.pop()?.unmount()
})

async function mount(adapter: Adapter): Promise<any> {
  const { api, app } = makeMounter(adapter.useForm, makeSchema(adapter.z), {
    defaultValues: { rows: [{ n: 'aa' }, { n: 'bb' }, { n: 'cc' }] },
  })()
  apps.push(app)
  await untilSettled(api)
  return api
}

const validating = (form: any, i: number): boolean => form.fields(['rows', i, 'n']).validating

describe.each(ADAPTERS)('$name: a validation run in flight follows its row', (adapter) => {
  it('settles at the index a swap moved its row to', async () => {
    const form = await mount(adapter)
    form.setValue('rows.0.n', 'slow')
    form.swap('rows', 0, 2)
    expect(validating(form, 2)).toBe(true)
    expect(validating(form, 0)).toBe(false)

    release()
    await untilSettled(form)
    expect(validating(form, 2)).toBe(false)
    expect(form.fields(['rows']).validating).toBe(false)
    expect(form.meta.validating).toBe(false)
  })

  it('a removal stops the removed row run and leaves the survivor run counting', async () => {
    const form = await mount(adapter)
    form.setValue('rows.0.n', 'slow-a')
    form.setValue('rows.1.n', 'slow-b')
    form.remove('rows', 0)
    // The row that slid into index 0 is still waiting on its own check.
    expect(validating(form, 0)).toBe(true)
    expect(form.meta.validating).toBe(true)

    release()
    await untilSettled(form)
    expect(validating(form, 0)).toBe(false)
    expect(form.meta.validating).toBe(false)
  })

  it('a write that takes a row away stops its run', async () => {
    const form = await mount(adapter)
    form.setValue('rows.2.n', 'slow')
    expect(form.meta.validating).toBe(true)
    form.setValue('rows', [{ n: 'aa' }, { n: 'bb' }])
    // Past the flush the write's own run has committed, and the held one is still held.
    await flushMicrotasks()
    expect(form.meta.validating).toBe(false)
    expect(form.fields(['rows']).validating).toBe(false)
  })
})
