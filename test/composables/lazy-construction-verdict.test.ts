// @vitest-environment jsdom
/**
 * The construction verdict is lazy (#691): a form validates its starting
 * value the first time anything reads or writes its errors, not when
 * `useForm` builds it. What every read sees is what it saw when the verdict
 * ran at construction.
 *
 * Each test drives two forms on one schema the same way: an `observed`
 * form, whose errors are read at mount as a template showing them would,
 * so its verdict runs then, and a `lazy` form nothing reads until the
 * operation under test is done. Their states must match at every moment.
 * The verdict is taken over the pristine starting value, so whatever
 * happens to the form's storage or the consumer's `defaultValues` before
 * the first read must not reach it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createFormStore } from '../../src/runtime/core/create-form-store'
import { fakeSchema } from '../utils/fake-schema'
import { makeMounter, wait } from '../utils/form-harness'
import { schemaOptions } from '../utils/store-options'

/* eslint-disable @typescript-eslint/no-explicit-any */
const ADAPTERS = [
  { name: 'v4', z: zV4 as any, useForm: useFormV4 as any },
  { name: 'v3', z: zV3 as any, useForm: useFormV3 as any },
] as const

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
  document.body.innerHTML = ''
})

/** Everything a read of the form's errors can see. */
function snap(api: any): unknown {
  return {
    errors: JSON.parse(JSON.stringify(api.errors)),
    metaErrors: api.meta.errors.map((e: any) => [e.path.join('.'), e.message]),
    errorCount: api.meta.errorCount,
    valid: api.meta.valid,
    values: JSON.parse(JSON.stringify(api.values)),
  }
}

async function settle(): Promise<void> {
  await wait(20)
  await nextTick()
}

describe.each(ADAPTERS)('lazy construction verdict ($name)', (a) => {
  function pair(schema: unknown, options: Record<string, unknown>) {
    const mount = makeMounter(a.useForm, schema, options)
    const observed = mount()
    apps.push(observed.app)
    void observed.api.meta.errors
    const lazy = mount()
    apps.push(lazy.app)
    return { observed: observed.api, lazy: lazy.api }
  }

  const issueSchema = () =>
    a.z
      .object({
        name: a.z.string().min(2, 'name too short'),
        tags: a.z.array(a.z.string().min(1, 'tag empty')),
        password: a.z.string(),
        confirm: a.z.string(),
      })
      .refine((v: any) => v.password === v.confirm, {
        message: 'passwords differ',
        path: ['confirm'],
      })

  const issueDefaults = () => ({ name: '', tags: [''], password: 'a', confirm: 'b' })

  for (const [label, op] of [
    ['setValue', (api: any) => api.setValue('name', 'Ada')],
    ['append', (api: any) => api.append('tags', 'b')],
    ['remove', (api: any) => api.remove('tags', 0)],
    ['reset', (api: any) => api.reset({ password: 'same', confirm: 'same' })],
    ['setErrors', (api: any) => api.setErrors([{ path: ['name'], message: 'taken' }])],
  ] as const) {
    it(`${label} before the first read leaves the state an observed form shows`, async () => {
      const { observed, lazy } = pair(issueSchema(), { defaultValues: issueDefaults() })
      op(observed)
      op(lazy)
      expect(snap(lazy)).toEqual(snap(observed))
      await settle()
      expect(snap(lazy)).toEqual(snap(observed))
    })
  }

  it('a reset before the first read runs one verdict, its own', () => {
    let runs = 0
    const schema = a.z.object({ name: a.z.string().min(2) }).superRefine(() => {
      runs += 1
    })
    const { api, app } = makeMounter(a.useForm, schema, { defaultValues: { name: '' } })()
    apps.push(app)
    expect(runs).toBe(0)
    api.reset()
    void api.meta.errors
    expect(runs).toBe(1)
    expect(api.meta.errors.map((e: any) => e.path.join('.'))).toEqual(['name'])
  })

  it('validates the pristine starting value, whatever reaches storage or defaultValues first', async () => {
    const schema = a.z.object({
      lookup: a.z.map(a.z.string(), a.z.number().min(5, 'entry too small')),
      tags: a.z.set(a.z.string()).refine((s: Set<string>) => s.size >= 2, 'two tags'),
      when: a.z.date().refine((d: Date) => d.getUTCFullYear() >= 2000, 'too early'),
      items: a.z.array(a.z.string().min(2, 'item too short')),
      notify: a.z.discriminatedUnion('channel', [
        a.z.object({ channel: a.z.literal('sms'), number: a.z.string().min(3, 'number') }),
        a.z.object({ channel: a.z.literal('email'), address: a.z.string().min(3, 'address') }),
      ]),
    })
    const defaults = () => ({
      lookup: new Map([['a', 1]]),
      tags: new Set(['x']),
      when: new Date('1990-01-01T00:00:00.000Z'),
      items: ['a'],
      // A discriminator naming no variant: storage holds the stub.
      notify: { channel: 'fax' },
    })
    const lazyDefaults = defaults()
    const mount = (defaultValues: unknown) =>
      makeMounter(a.useForm, schema, { defaultValues, validateOn: 'submit' })()
    const observed = mount(defaults())
    apps.push(observed.app)
    const expected = snap(observed.api)
    const lazy = mount(lazyDefaults)
    apps.push(lazy.app)

    // Writes that would each clear an error if the verdict saw them, on a
    // form that does not revalidate on write.
    lazy.api.setValue(['lookup', 'a'], 10)
    lazy.api.setValue('tags', new Set(['x', 'y']))
    lazy.api.setValue('when', new Date('2020-01-01T00:00:00.000Z'))
    lazy.api.setValue('items', ['ok'])
    lazy.api.setValue('notify', { channel: 'email', address: 'a@b.c' })
    // Edits to the consumer's own literal, which the form copied.
    lazyDefaults.items.push('b')
    lazyDefaults.lookup.set('b', 0)

    const seen = snap(lazy.api) as { metaErrors: unknown[]; values: unknown }
    expect(seen.metaErrors).toEqual((expected as { metaErrors: unknown[] }).metaErrors)
    expect(seen.metaErrors.map((e: any) => e[1])).toEqual(
      expect.arrayContaining(['entry too small', 'two tags', 'too early', 'item too short'])
    )
    await settle()
    expect((snap(lazy.api) as { metaErrors: unknown[] }).metaErrors).toEqual(seen.metaErrors)
  })
})

describe('lazy construction verdict: a custom adapter', () => {
  it('validates the starting value even when the adapter hands back the consumer subtrees', () => {
    // `getDefaultValues` building a fresh tree is not part of the contract:
    // this one spreads the constraints, so the derived value shares the
    // consumer's `items` array. The store derives from its own copy, so an
    // edit to the literal before the first read does not reach the verdict.
    type Form = { items: string[] }
    const schema = fakeSchema<Form>({ items: [] })
    schema.getDefaultValues = (config) => ({ items: [], ...config.constraints }) as Form
    schema.validateSync = (data) =>
      (data as Form).items.length > 1
        ? [{ path: ['items'], message: 'one item', formKey: 'custom', code: 'atta:test-fixture' }]
        : []
    const defaultValues = { items: ['a'] }
    const state = createFormStore<Form>({
      formKey: 'custom',
      ...schemaOptions(schema),
      defaultValues,
    })
    defaultValues.items.push('b')
    expect([...state.errorCells().keys()]).toEqual([])
  })
})
/* eslint-enable @typescript-eslint/no-explicit-any */
