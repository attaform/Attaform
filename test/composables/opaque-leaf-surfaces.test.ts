// @vitest-environment jsdom
/**
 * Surface pins for opaque leaves (#613).
 *
 * `z.any()`, `z.unknown()`, `z.custom()` and the `z.instanceof(X)` that
 * compiles to it declare a value without describing its shape. They
 * admit every kind including the container ones, so classifying them
 * off the slim-primitive set alone read them as containers: dot access
 * resolved a sub-proxy instead of the leaf, and every `FieldState` key
 * on it fell through the descend gate to `undefined`. The call form
 * gates on schema presence instead, so it kept working, and the two
 * documented spellings of the same read disagreed silently. A server
 * error on a `z.instanceof(File)` upload field (the documented Zod v3
 * spelling) was stored, rolled into `form.meta.errors`, and invisible
 * to `form.errors.avatar.length`.
 *
 * These pin both spellings agreeing at an opaque leaf, and pin the
 * other half of the contract too: a `z.map` declares real sub-paths,
 * so it stays a container and must NOT be swept up by the fix.
 */
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'

const DEFAULTS = {
  bag: { nested: 'payload' },
  unk: 1,
  cust: { a: 1 },
  avatar: new Uint8Array([1, 2, 3]),
  scores: new Map([['ann', 1]]),
  note: '',
}

const schemaV4 = zV4.object({
  bag: zV4.any(),
  unk: zV4.unknown(),
  cust: zV4.custom<{ a: number }>(() => true),
  avatar: zV4.instanceof(Uint8Array),
  scores: zV4.map(zV4.string(), zV4.number()),
  note: zV4.string(),
})
const schemaV3 = zV3.object({
  bag: zV3.any(),
  unk: zV3.unknown(),
  cust: zV3.custom<{ a: number }>(() => true),
  avatar: zV3.instanceof(Uint8Array),
  scores: zV3.map(zV3.string(), zV3.number()),
  note: zV3.string(),
})

const adapters = [
  { name: 'v4', mount: makeMounter(useFormV4, schemaV4, { defaultValues: DEFAULTS }) },
  { name: 'v3', mount: makeMounter(useFormV3, schemaV3, { defaultValues: DEFAULTS }) },
] as const

/** The four opaque kinds, by the field carrying each one. */
const OPAQUE = ['bag', 'unk', 'cust', 'avatar'] as const
type OpaqueField = (typeof OPAQUE)[number]

describe.each(adapters)('opaque leaves on the read surfaces ($name)', ({ mount }) => {
  it('dot access resolves the same view the call form does', () => {
    const { api } = mount()
    const dotted: Record<OpaqueField, unknown> = {
      bag: api.fields.bag,
      unk: api.fields.unk,
      cust: api.fields.cust,
      avatar: api.fields.avatar,
    }
    for (const field of OPAQUE) {
      expect(dotted[field], field).not.toBeUndefined()
      expect(dotted[field], field).toBe(api.fields(field))
    }
  })

  it('a FieldState key reads through dot access', () => {
    const { api } = mount()
    expect(api.fields.bag.value).toStrictEqual(DEFAULTS.bag)
    expect(api.fields.unk.value).toBe(DEFAULTS.unk)
    expect(api.fields.cust.value).toStrictEqual(DEFAULTS.cust)
    expect(api.fields.avatar.value).toStrictEqual(DEFAULTS.avatar)

    expect(api.fields.bag.path).toEqual(['bag'])
    expect(api.fields.avatar.path).toEqual(['avatar'])
    expect(api.fields.bag.dirty).toBe(false)
    expect(api.fields.avatar.dirty).toBe(false)
  })

  it('an error at an opaque leaf reads through both spellings', async () => {
    const { api } = mount()
    api.setErrors(OPAQUE.map((field) => ({ path: [field], message: `bad ${field}` })))
    await nextTick()

    expect(api.errors.bag).toHaveLength(1)
    expect(api.errors.unk).toHaveLength(1)
    expect(api.errors.cust).toHaveLength(1)
    expect(api.errors.avatar).toHaveLength(1)
    expect(Array.isArray(api.errors.avatar)).toBe(true)

    expect(api.fields.bag.firstError?.message).toBe('bad bag')
    expect(api.fields.avatar.firstError?.message).toBe('bad avatar')

    for (const field of OPAQUE) {
      expect(api.errors(field), field).toHaveLength(1)
    }
  })

  it('an opaque leaf exposes no phantom sub-paths', () => {
    const { api } = mount()
    // `bag` holds `{ nested: 'payload' }`, but the schema declares
    // nothing under it, so the payload's own keys are not paths.
    expect(api.fields('bag.nested')).toBeUndefined()
    const keys = Object.keys(api.fields.bag)
    expect(keys).toContain('value')
    expect(keys).toContain('errors')
    expect(keys).not.toContain('nested')
  })

  it('serialisation files an opaque leaf at its own path', async () => {
    const { api } = mount()
    api.setErrors([{ path: ['bag'], message: 'bad bag' }])
    await nextTick()

    // Not under the container-self sentinel `bag['']`.
    const errors: unknown = JSON.parse(JSON.stringify(api.errors))
    const bagErrors = (errors as { bag?: unknown }).bag
    expect(Array.isArray(bagErrors)).toBe(true)
    expect(bagErrors).toHaveLength(1)

    // A FieldState snapshot, not a walk into `{ nested: 'payload' }`.
    const fields: unknown = JSON.parse(JSON.stringify(api.fields))
    const bagField = (fields as { bag?: { path?: unknown; nested?: unknown } }).bag
    expect(bagField?.path).toEqual(['bag'])
    expect(bagField?.nested).toBeUndefined()
  })

  it('a map stays a container, not an opaque leaf', () => {
    const { api } = mount()
    // A map declares real sub-paths, so it must NOT be swept up by the
    // opaque-leaf fix: dot access stays the descending container and
    // the rollup view stays behind the call form, the same split every
    // other container has. (Resolving a map's entries as paths on
    // `fields` / `errors` is a separate gap, tracked in #614.)
    expect(api.fields.scores).not.toBe(api.fields('scores'))
    // A leaf view enumerates the FieldState keys; a container does not.
    expect(Object.keys(api.fields.scores)).not.toContain('value')
    expect(api.values.scores instanceof Map).toBe(true)
  })

  it('a plain leaf is unchanged', () => {
    const { api } = mount()
    expect(api.fields.note).toBe(api.fields('note'))
    expect(api.fields.note.value).toBe('')
  })
})
