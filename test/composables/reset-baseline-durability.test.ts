// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { unset, useForm } from '../../src/zod'
import type { UseFormConfigV4 } from '../../src/zod'
import { attachRegistryToApp, createRegistry } from '../../src/runtime/core/registry'
import type { UseFormReturnType } from '../../src/runtime/types/types-api'

/**
 * Regression coverage for #576 — `reset(next)` moved the dirty baseline
 * but not the reset baseline.
 *
 * The report is worth restating because it explains why the suite had no
 * coverage here for so long: the bug is invisible on any surface whose
 * FIRST save is also its LAST. Construction defaults and last-saved
 * values are the same object until a second save happens, so a fixture
 * that saves once and discards once is green on the bug AND green on the
 * fix. Seeing it needs two saves' worth of history and three distinct
 * values, which is what `two saves` below sets up.
 *
 * The contract these tests pin:
 *   - `next` is DURABLE. It becomes the form's defaults, so a later bare
 *     `reset()` lands on it rather than rolling back across a save.
 *   - `next` is SPARSE. It folds over the defaults already in force;
 *     paths it doesn't name keep the value, and the blank mark, they had.
 *   - every baseline agrees. `reset()`, `resetField(path)`, `dirty`, and
 *     the blank set all read the same defaults.
 */

function setupForm<F extends z.ZodObject<z.ZodRawShape>>(
  schema: F,
  defaultValues?: UseFormConfigV4<F>['defaultValues']
) {
  let captured!: UseFormReturnType<z.output<F> & Record<string, unknown>>
  const Probe = defineComponent({
    setup() {
      captured = useForm({
        schema,
        key: `rbd-${Math.random().toString(36).slice(2)}`,
        ...(defaultValues !== undefined ? { defaultValues } : {}),
      }) as unknown as UseFormReturnType<z.output<F> & Record<string, unknown>>
      return () => h('div')
    },
  })
  const app = createApp(Probe)
  attachRegistryToApp(app, createRegistry())
  app.mount(document.createElement('div'))
  return { app, form: captured }
}

const address = z.object({ city: z.string(), state: z.string() })

describe('reset baseline durability (#576)', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('the reported repro: a later reset() does not roll back across the save', () => {
    const { app, form } = setupForm(address, { city: 'Ironton', state: 'oh' })
    apps.push(app)

    // The saved resource comes back from the server and is adopted.
    form.reset({ city: 'Wellston', state: 'OH' })
    expect(form.values()).toEqual({ city: 'Wellston', state: 'OH' })
    expect(form.meta.dirty).toBe(false)

    // The dirty baseline moved to the saved values (this half always worked).
    form.setValue('city', 'Portsmouth')
    expect(form.meta.dirty).toBe(true)
    form.setValue('city', 'Wellston')
    expect(form.meta.dirty).toBe(false)

    // Discard. It must return to the SAVED values, not to construction.
    form.reset()
    expect(form.values()).toEqual({ city: 'Wellston', state: 'OH' })
    expect(form.meta.dirty).toBe(false)
  })

  it('two saves: the discard lands on the second save, not the first', () => {
    // Three distinct values. A one-save fixture cannot tell a durable
    // baseline from a frozen one.
    const { app, form } = setupForm(address, { city: 'Ironton', state: 'oh' })
    apps.push(app)

    form.setValue('city', 'Wellston')
    form.reset({ city: 'Wellston', state: 'OH' }) // save 1
    form.setValue('city', 'Portsmouth')
    form.reset({ city: 'Portsmouth', state: 'OH' }) // save 2

    form.setValue('city', 'Chillicothe') // unsaved edit
    expect(form.meta.dirty).toBe(true)
    form.reset() // discard
    expect(form.values()).toEqual({ city: 'Portsmouth', state: 'OH' })
  })

  it('dirty reports true over values that no longer match the last save', () => {
    // The half of the report with no visible symptom: after the bad
    // rollback, `dirty` read false over stale values, so the unsaved-
    // changes bar never appeared and the next submit built on the stale set.
    const { app, form } = setupForm(address, { city: 'Ironton', state: 'oh' })
    apps.push(app)

    form.reset({ city: 'Wellston', state: 'OH' })
    form.setValue('city', 'Ironton') // back to the CONSTRUCTION value
    // Not pristine: the construction value is not the saved value.
    expect(form.meta.dirty).toBe(true)
  })

  it('reset() and resetField() agree on what "initial" means', () => {
    const { app, form } = setupForm(address, { city: 'Ironton', state: 'oh' })
    apps.push(app)
    form.reset({ city: 'Wellston', state: 'OH' })

    form.setValue('city', 'Portsmouth')
    form.resetField('city')
    const afterResetField = form.values()

    form.setValue('city', 'Portsmouth')
    form.reset()
    expect(form.values()).toEqual(afterResetField)
  })

  // --- sparseness ---

  it('paths next does not name keep the value they had', () => {
    const { app, form } = setupForm(
      z.object({ name: z.string(), email: z.string(), role: z.string() }),
      { name: 'Ada', email: 'ada@example.com', role: 'admin' }
    )
    apps.push(app)
    form.reset({ name: 'Grace' })
    expect(form.values()).toEqual({
      name: 'Grace',
      email: 'ada@example.com',
      role: 'admin',
    })
  })

  it('reset({}) changes nothing', () => {
    const { app, form } = setupForm(z.object({ name: z.string(), email: z.string() }), {
      name: 'Ada',
      email: 'ada@example.com',
    })
    apps.push(app)
    form.setValue('name', 'typed')
    form.reset({})
    expect(form.values()).toEqual({ name: 'Ada', email: 'ada@example.com' })
  })

  it('successive partial resets compose', () => {
    const { app, form } = setupForm(z.object({ a: z.string(), b: z.string(), c: z.string() }), {
      a: 'a1',
      b: 'b1',
      c: 'c1',
    })
    apps.push(app)
    form.reset({ a: 'a2' })
    form.reset({ b: 'b2' })
    form.setValue('c', 'typed')
    form.reset()
    expect(form.values()).toEqual({ a: 'a2', b: 'b2', c: 'c1' })
  })

  it('nested objects merge per leaf', () => {
    const { app, form } = setupForm(
      z.object({ profile: z.object({ name: z.string(), age: z.number() }) }),
      { profile: { name: 'Ada', age: 36 } }
    )
    apps.push(app)
    form.reset({ profile: { name: 'Grace' } })
    expect(form.values()).toEqual({ profile: { name: 'Grace', age: 36 } })
  })

  it('arrays are replaced wholesale, not merged element-wise', () => {
    const { app, form } = setupForm(z.object({ tags: z.array(z.string()) }), {
      tags: ['a', 'b', 'c'],
    })
    apps.push(app)
    form.reset({ tags: ['x'] })
    expect(form.values()).toEqual({ tags: ['x'] })
    form.setValue('tags.0', 'typed')
    form.reset()
    expect(form.values()).toEqual({ tags: ['x'] })
  })

  it('a write never rewrites the defaults it will later reset to', () => {
    // Pre-existing hazard that durable defaults would have amplified:
    // form storage can alias the consumer's own defaults object (the
    // baseline pipeline returns its source by reference when it is
    // already structurally complete) and `setValue` writes leaves in
    // place. So an ordinary edit could rewrite the values `reset()`
    // restores to, and could reach back into the caller's own literal.
    const initial = { tags: ['a', 'b'] }
    const { app, form } = setupForm(z.object({ tags: z.array(z.string()) }), initial)
    apps.push(app)
    form.setValue('tags.0', 'typed')
    form.reset()
    expect(form.values()).toEqual({ tags: ['a', 'b'] })
    expect(initial.tags).toEqual(['a', 'b'])
  })

  it('a discriminated union rebases on the incoming variant', () => {
    const { app, form } = setupForm(
      z.object({
        notify: z.discriminatedUnion('channel', [
          z.object({ channel: z.literal('email'), address: z.string() }),
          z.object({ channel: z.literal('sms'), number: z.string() }),
        ]),
      }),
      { notify: { channel: 'email', address: 'ada@example.com' } }
    )
    apps.push(app)
    // Merging across variants would leave a ghost shape carrying both
    // `address` and `number`. The incoming variant wins outright.
    form.reset({ notify: { channel: 'sms', number: '555' } })
    expect(form.values()).toEqual({ notify: { channel: 'sms', number: '555' } })
    form.reset()
    expect(form.values()).toEqual({ notify: { channel: 'sms', number: '555' } })
  })

  // --- blank membership follows the same rule ---

  it('the blank mark survives a reset that does not name the path', () => {
    const { app, form } = setupForm(z.object({ name: z.string(), nickname: z.string() }), {
      name: 'Ada',
      nickname: unset,
    })
    apps.push(app)
    expect(form.fields.nickname.blank).toBe(true)

    form.reset({ name: 'Grace' })
    expect(form.fields.nickname.blank).toBe(true)
    form.reset()
    expect(form.fields.nickname.blank).toBe(true)
  })

  it('a named path withdraws its blank mark, durably', () => {
    const { app, form } = setupForm(z.object({ name: z.string(), nickname: z.string() }), {
      name: 'Ada',
      nickname: unset,
    })
    apps.push(app)
    form.reset({ nickname: 'Nicky' })
    expect(form.fields.nickname.blank).toBe(false)
    form.reset()
    expect(form.fields.nickname.blank).toBe(false)
    expect(form.values()).toEqual({ name: 'Ada', nickname: 'Nicky' })
  })

  it('unset re-marks a path blank, durably', () => {
    const { app, form } = setupForm(z.object({ name: z.string(), nickname: z.string() }), {
      name: 'Ada',
      nickname: 'Nicky',
    })
    apps.push(app)
    form.reset({ nickname: unset })
    expect(form.fields.nickname.blank).toBe(true)
    form.reset()
    expect(form.fields.nickname.blank).toBe(true)
  })
})

describe('async defaults adopt the same baseline (#576)', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  function setupAsync(factory: () => Promise<{ city: string; state: string }>) {
    let captured!: UseFormReturnType<{ city: string; state: string } & Record<string, unknown>>
    const Probe = defineComponent({
      setup() {
        captured = useForm({
          schema: address,
          key: `rbd-async-${Math.random().toString(36).slice(2)}`,
          defaultValues: factory,
        }) as unknown as UseFormReturnType<
          { city: string; state: string } & Record<string, unknown>
        >
        return () => h('div')
      },
    })
    const app = createApp(Probe)
    attachRegistryToApp(app, createRegistry())
    app.mount(document.createElement('div'))
    return { app, form: captured }
  }

  it('the form settles pristine once the factory resolves', async () => {
    const { app, form } = setupAsync(() => Promise.resolve({ city: 'Ironton', state: 'oh' }))
    apps.push(app)
    await form.activate()
    // The fetched values ARE the defaults. Reading dirty here used to
    // report true before the consumer had touched anything, firing an
    // unsaved-changes guard on an untouched form.
    expect(form.meta.dirty).toBe(false)
  })

  it('reset() lands on the fetched resource, not on schema-slim values', async () => {
    const { app, form } = setupAsync(() => Promise.resolve({ city: 'Ironton', state: 'oh' }))
    apps.push(app)
    await form.activate()
    form.setValue('city', 'typed')
    form.reset()
    expect(form.values()).toEqual({ city: 'Ironton', state: 'oh' })
  })

  it('the documented rehydrate() then reset() chain keeps the refetched values', async () => {
    let n = 0
    const { app, form } = setupAsync(() => Promise.resolve({ city: `fetch-${++n}`, state: 'oh' }))
    apps.push(app)
    await form.activate()
    await form.rehydrate()
    expect(form.values()).toEqual({ city: 'fetch-2', state: 'oh' })
    // `rehydrate` deliberately leaves touched / submit state alone and
    // documents `reset()` as the way to clear it. That chain used to
    // discard exactly what `rehydrate` had just loaded.
    form.reset()
    expect(form.values()).toEqual({ city: 'fetch-2', state: 'oh' })
  })

  it('a later reset(next) still folds over the factory-supplied defaults', async () => {
    const { app, form } = setupAsync(() => Promise.resolve({ city: 'Ironton', state: 'oh' }))
    apps.push(app)
    await form.activate()
    form.reset({ city: 'Wellston' })
    expect(form.values()).toEqual({ city: 'Wellston', state: 'oh' })
    form.reset()
    expect(form.values()).toEqual({ city: 'Wellston', state: 'oh' })
  })
})
