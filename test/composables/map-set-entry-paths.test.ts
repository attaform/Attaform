// @vitest-environment jsdom
/**
 * Surface pins for `z.map` entries and `z.set` members (#614).
 *
 * A map entry is a real path: `scores.ann` reads and writes on every
 * surface, which is what the records docs teach and what makes a map
 * worth choosing over a record. A set member is not, and cannot be —
 * a member IS its own key, so no address survives writing to one.
 *
 * Both halves were broken in the same way and in opposite directions.
 * The schema walker had no `map` case at all, so every map-entry write
 * was refused and every map-entry read came back empty. It DID consume
 * a segment at a set, to answer what a member looks like for the
 * coercion layer, and that made `tags.0` look like a declared path to
 * everyone: it surfaced on `form.fields` holding nothing, and it
 * cleared the write gate, where the numeric rebuild replaced the whole
 * `Set` with an `Array` holding the one written member.
 *
 * The two majors also disagreed about where a container's own errors
 * live. v4 files a bad map entry at `['scores', 'ann']` and a bad set
 * member at `['tags']`; v3 files them at `['scores', 0, 'value']` and
 * `['tags', 1]`. Every error pin below asserts the same value on both,
 * which is the property that was missing: a v3 map form stored its
 * schema errors at a path nothing resolves, so they vanished from
 * `form.errors`, from the field's `firstError`, and from the
 * `form.meta.errors` summary, while the submit they blocked reported
 * no reason.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { h, nextTick, withDirectives } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { vRegister } from '../../src/runtime/core/directive'
import type { ValidationError } from '../../src/runtime/types/types-api'
import { awaitSettle, makeMounter } from '../utils/form-harness'

const defaults = (): {
  scores: Map<string, number>
  tags: Set<string>
  rooms: Map<string, { area: number; name: string }>
  slots: Map<number, string>
} => ({
  scores: new Map([['ann', 50]]),
  tags: new Set(['red', 'blue']),
  rooms: new Map([['kitchen', { area: 12, name: 'Kitchen' }]]),
  slots: new Map([[1, 'morning']]),
})

const schemaV4 = zV4.object({
  scores: zV4.map(zV4.string(), zV4.number().min(10)),
  tags: zV4.set(zV4.string().min(2)),
  rooms: zV4.map(zV4.string(), zV4.object({ area: zV4.number(), name: zV4.string() })),
  slots: zV4.map(zV4.number(), zV4.string()),
})
const schemaV3 = zV3.object({
  scores: zV3.map(zV3.string(), zV3.number().min(10)),
  tags: zV3.set(zV3.string().min(2)),
  rooms: zV3.map(zV3.string(), zV3.object({ area: zV3.number(), name: zV3.string() })),
  slots: zV3.map(zV3.number(), zV3.string()),
})

// A fresh mounter per call: `defaults()` hands the form a live `Map`,
// and `materializeFormValue` carries a map into storage BY REFERENCE,
// so one shared defaults object would let each test read the previous
// test's edits.
const adapters = [
  { name: 'v4', mount: () => makeMounter(useFormV4, schemaV4, { defaultValues: defaults() })() },
  { name: 'v3', mount: () => makeMounter(useFormV3, schemaV3, { defaultValues: defaults() })() },
] as const

describe.each(adapters)('a map entry is a path ($name)', ({ mount }) => {
  it('resolves the same view through both spellings', () => {
    const { api } = mount()
    expect(api.fields('scores.ann')).not.toBeUndefined()
    expect(api.fields.scores.ann).toBe(api.fields('scores.ann'))
    expect(api.fields.scores.ann.value).toBe(50)
    expect(api.fields.scores.ann.path).toEqual(['scores', 'ann'])
  })

  it('enumerates the live entries as keys', async () => {
    const { api } = mount()
    expect(Object.keys(api.fields.scores)).toEqual(['ann'])
    api.setValue('scores.bob', 20)
    await nextTick()
    expect(Object.keys(api.fields.scores).sort()).toEqual(['ann', 'bob'])
  })

  it('writes through the map without replacing it', async () => {
    const { api } = mount()
    api.setValue('scores.ann', 99)
    await nextTick()
    expect(api.values.scores).toBeInstanceOf(Map)
    expect(api.values.scores.get('ann')).toBe(99)
    expect(api.fields.scores.ann.value).toBe(99)
    expect(api.fields.scores.ann.dirty).toBe(true)
  })

  it('creates an entry the map did not hold, keeping the others', async () => {
    const { api } = mount()
    api.setValue('scores.bob', 20)
    await nextTick()
    expect([...api.values.scores]).toEqual([
      ['ann', 50],
      ['bob', 20],
    ])
  })

  it('files an integer-looking key under the declared key type', async () => {
    const { api } = mount()
    // `scores.42` canonicalises to the NUMBER 42 as a path segment, but
    // the map is declared `z.map(z.string(), ...)`, so the entry has to
    // land under the string. A numeric key would fail the map's own
    // parse while reading back fine through the path.
    api.setValue('scores.42', 60)
    // `slots` is the mirror case: declared `z.map(z.number(), ...)`, so
    // the same segment stays a number there.
    api.setValue('slots.2', 'afternoon')
    await nextTick()
    expect([...api.values.scores.keys()]).toEqual(['ann', '42'])
    expect([...api.values.slots.keys()]).toEqual([1, 2])
    expect(api.fields('scores.42')?.value).toBe(60)
    expect(api.fields('slots.2')?.value).toBe('afternoon')
  })

  it('completes a partial entry from the schema, like a record entry', async () => {
    const { api } = mount()
    api.setValue('rooms.kitchen.area', 30)
    await nextTick()
    expect(api.values.rooms.get('kitchen')).toEqual({ area: 30, name: 'Kitchen' })
    expect(api.fields('rooms.kitchen.name')?.value).toBe('Kitchen')
  })

  it('routes a schema error at an entry to every read surface', async () => {
    const { api } = mount()
    api.setValue('scores.ann', 1)
    await nextTick()
    await api.handleSubmit(() => undefined)()
    await nextTick()

    expect(api.meta.errors.map((e: ValidationError) => e.path)).toEqual([['scores', 'ann']])
    expect(api.errors('scores.ann')).toHaveLength(1)
    expect(api.errors.scores.ann).toHaveLength(1)
    expect(api.fields('scores.ann')?.firstError?.code).toBe('zod:too_small')
    expect(api.fields.scores.ann.showErrors).toBe(true)
  })

  it('routes a user error at an entry to every read surface', async () => {
    const { api } = mount()
    api.setErrors([{ path: ['scores', 'ann'], message: 'Taken' }])
    await nextTick()
    expect(api.errors('scores.ann').map((e: ValidationError) => e.message)).toEqual(['Taken'])
    expect(api.errors.scores.ann).toHaveLength(1)
    expect(api.meta.errors.map((e: ValidationError) => e.message)).toEqual(['Taken'])
    expect(api.fields.scores.ann.firstError?.message).toBe('Taken')
  })

  it('clears an entry to the schema empty value', async () => {
    const { api } = mount()
    api.clear('scores.ann')
    await nextTick()
    expect(api.values.scores).toBeInstanceOf(Map)
    expect(api.values.scores.get('ann')).toBe(0)
  })
})

describe.each(adapters)('a set member is not a path ($name)', ({ mount }) => {
  it('resolves no member, by index or otherwise', () => {
    const { api } = mount()
    expect(api.fields('tags.0')).toBeUndefined()
    expect(api.fields('tags.1')).toBeUndefined()
    expect(api.fields('tags.red')).toBeUndefined()
    expect(Object.keys(api.fields.tags)).toEqual([])
  })

  it('refuses a member write instead of rebuilding the set as an array', async () => {
    const { api } = mount()
    api.setValue('tags.0', 'green')
    await nextTick()
    // The regression this pins: the write used to clear the gate and
    // the numeric rebuild produced `['green']`, an Array, with both
    // original members gone.
    expect(api.values.tags).toBeInstanceOf(Set)
    expect([...api.values.tags]).toEqual(['red', 'blue'])
  })

  it('takes a whole-set write, which is the supported spelling', async () => {
    const { api } = mount()
    api.setValue('tags', new Set([...api.values.tags, 'green']))
    await nextTick()
    expect(api.values.tags).toBeInstanceOf(Set)
    expect([...api.values.tags]).toEqual(['red', 'blue', 'green'])
  })

  it('files a bad member on the set itself', async () => {
    const { api } = mount()
    api.setValue('tags', new Set(['x']))
    await nextTick()
    await api.handleSubmit(() => undefined)()
    await nextTick()
    expect(api.meta.errors.map((e: ValidationError) => e.path)).toEqual([['tags']])
    expect(api.errors('tags')).toHaveLength(1)
    expect(api.fields('tags')?.firstError?.code).toBe('zod:too_small')
  })
})

/**
 * `register` at a map entry, through the directive rather than the
 * store. This is the spelling the records docs teach
 * (``v-register="form.register(`scoresByUser.${userId}`)"``), and the
 * one that used to hand back a truthy binding whose every write landed
 * nowhere: the input mounted, looked wired, and silently discarded
 * what the user typed.
 */
describe.each([
  { name: 'v4', useForm: useFormV4, schema: schemaV4 },
  { name: 'v3', useForm: useFormV3, schema: schemaV3 },
] as const)('register at a map entry ($name)', ({ useForm, schema }) => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders the entry and lands what the user types', async () => {
    const { api, root } = makeMounter(useForm, schema, { defaultValues: defaults() }, (form) =>
      h('div', [
        withDirectives(h('input', { type: 'number', class: 'ann' }), [
          [vRegister, form.register('scores.ann')],
        ]),
      ])
    )()
    await awaitSettle()

    const input = root.querySelector<HTMLInputElement>('input.ann')
    expect(input).not.toBeNull()
    expect(input?.value).toBe('50')

    if (input !== null) {
      input.value = '75'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await awaitSettle()

    expect(api.values.scores).toBeInstanceOf(Map)
    expect(api.values.scores.get('ann')).toBe(75)
    expect(api.fields('scores.ann')?.dirty).toBe(true)
  })
})
