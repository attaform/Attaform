// @vitest-environment jsdom
/**
 * P8 characterization pins for the three read surfaces (`form.values`,
 * `form.errors`, `form.fields`) and the two meta forests. Every
 * assertion here is CURRENT observable behavior, captured before the
 * surface-layer consolidation, and must hold verbatim after it:
 *
 * - a clean declared leaf reads `[]` on the errors surface (an array,
 *   never `undefined`), while an unknown key reads `undefined`
 * - enumeration on the errors surface is the union of live form keys
 *   and error-store keys; `JSON.stringify(form.errors)` stays sparse
 * - fields leaf views are identity-stable across reads and writes and
 *   enumerate the full FieldState key set
 * - array-shaped field containers satisfy `Array.isArray`, expose
 *   `length`, and support read-only Array.prototype methods
 * - `toJSON` survives on all three surfaces
 * - `form.meta` and the predicate's meta argument enumerate their full
 *   key sets (the getter forests must stay enumerable)
 */
import { afterEach, describe, expect, it } from 'vitest'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import type { App } from 'vue'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'

const DEFAULTS = {
  email: 'a@b.com',
  address: { city: 'NYC', zip: '1' },
  items: [{ sku: 'A' }, { sku: 'B' }],
}

const schemaV4 = zV4.object({
  email: zV4.string().min(3, 'email short'),
  address: zV4.object({ city: zV4.string().min(1), zip: zV4.string() }),
  items: zV4.array(zV4.object({ sku: zV4.string() })),
})
const schemaV3 = zV3.object({
  email: zV3.string().min(3, 'email short'),
  address: zV3.object({ city: zV3.string().min(1), zip: zV3.string() }),
  items: zV3.array(zV3.object({ sku: zV3.string() })),
})

const adapters = [
  { name: 'v4', mount: makeMounter(useFormV4, schemaV4, { defaultValues: DEFAULTS }) },
  { name: 'v3', mount: makeMounter(useFormV3, schemaV3, { defaultValues: DEFAULTS }) },
] as const

/** The FieldState key set a leaf view / call-form terminal enumerates. */
const FIELD_STATE_KEYS = [
  'aria',
  'blank',
  'blurred',
  'blurredAfterInteraction',
  'busy',
  'connected',
  'description',
  'dirty',
  'disabled',
  'displayState',
  'element',
  'elements',
  'errors',
  'firstError',
  'firstOwnError',
  'focused',
  'id',
  'interacted',
  'key',
  'label',
  'meta',
  'original',
  'ownErrors',
  'path',
  'placeholder',
  'pristine',
  'showErrors',
  'showIdle',
  'showPending',
  'showSuccess',
  'touched',
  'transformError',
  'transforming',
  'updatedAt',
  'valid',
  'validating',
  'value',
]

/** `form.meta`'s enumerable key set: FieldState keys plus lifecycle. */
const META_KEYS = [
  ...FIELD_STATE_KEYS,
  'departAttempts',
  'errorCount',
  'instanceId',
  'submissionAttempts',
  'submitError',
  'submitted',
  'submitting',
].sort()

/**
 * The predicate-facing meta argument (`FormMetaBase`): FieldState keys
 * minus the derived display keys, plus lifecycle and errorCount.
 */
const DERIVED_KEYS = new Set([
  'displayState',
  'showErrors',
  'showIdle',
  'showPending',
  'showSuccess',
  'firstError',
  'firstOwnError',
])
const META_BASE_KEYS = [
  ...FIELD_STATE_KEYS.filter((k) => !DERIVED_KEYS.has(k)),
  'departAttempts',
  'errorCount',
  'instanceId',
  'submissionAttempts',
  'submitError',
  'submitted',
  'submitting',
].sort()

describe.each(adapters)('surface contract pins — $name', ({ mount }) => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('errors: a clean declared leaf reads [], an unknown key reads undefined', () => {
    const { api, app } = mount()
    apps.push(app)
    expect(Array.isArray(api.errors.email)).toBe(true)
    expect(api.errors.email).toHaveLength(0)
    expect(api.errors.bogus).toBeUndefined()
    // `in` stays conservatively true at containers.
    expect('email' in api.errors).toBe(true)
    expect('bogus' in api.errors).toBe(true)
  })

  it('errors: enumeration is live keys ∪ error-store keys; JSON stays sparse', () => {
    const { api, app } = mount()
    apps.push(app)
    expect(Object.keys(api.errors)).toEqual(['email', 'address', 'items'])
    api.setErrors([
      { path: ['email'], message: 'server says no', code: 'api:x' },
      { path: ['ghost'], message: 'unknown key error', code: 'api:x' },
    ])
    // Server-only key joins enumeration; live keys stay.
    expect(Object.keys(api.errors)).toEqual(['email', 'address', 'items', 'ghost'])
    // The materialised JSON tree is sparse: error-bearing paths only.
    expect(JSON.parse(JSON.stringify(api.errors))).toEqual({
      email: [{ message: 'server says no', path: ['email'], code: 'api:x' }],
      ghost: [{ message: 'unknown key error', path: ['ghost'], code: 'api:x' }],
    })
    // Leaf read surfaces the user error. The unknown key descends to a
    // container node whose own `''` slot carries the entry; the
    // call-form aggregate drops it (active-path filter).
    expect(api.errors.email).toHaveLength(1)
    expect(JSON.parse(JSON.stringify(api.errors.ghost))).toEqual({
      '': [{ message: 'unknown key error', path: ['ghost'], code: 'api:x' }],
    })
    expect(api.errors('ghost')).toEqual([])
  })

  it('errors: container descent, container-self sentinel, and call forms agree', () => {
    const { api, app } = mount()
    apps.push(app)
    api.setErrors('address', [{ message: 'container mark', code: 'api:c' }])
    api.setErrors('address.city', [{ message: 'city bad', code: 'api:l' }])
    // Dot descent to the nested leaf.
    expect(api.errors.address.city).toHaveLength(1)
    expect(api.errors.address.city[0]?.message).toBe('city bad')
    // Container-self sentinel: the container's own bucket at its `''` slot.
    expect(api.errors.address['']).toHaveLength(1)
    expect(api.errors.address[''][0]?.message).toBe('container mark')
    // Call-form aggregates: container path collects self + descendants.
    expect(api.errors('address')).toHaveLength(2)
    // No-arg and explicit-root calls return the whole-form aggregate.
    expect(api.errors()).toHaveLength(2)
    expect(api.errors([])).toHaveLength(2)
    // The materialised container tree carries self under '' and the leaf.
    expect(JSON.parse(JSON.stringify(api.errors.address))).toEqual({
      '': [{ message: 'container mark', path: ['address'], code: 'api:c' }],
      city: [{ message: 'city bad', path: ['address', 'city'], code: 'api:l' }],
    })
  })

  it('errors: array container satisfies Array.isArray and enumerates indices', () => {
    const { api, app } = mount()
    apps.push(app)
    expect(Array.isArray(api.errors.items)).toBe(true)
    expect(api.errors.items.length).toBe(2)
    expect(Object.keys(api.errors.items)).toEqual(['0', '1'])
    api.setErrors('items.1.sku', [{ message: 'sku bad', code: 'api:x' }])
    expect(api.errors.items[1].sku).toHaveLength(1)
    expect(api.errors.items[0].sku).toHaveLength(0)
  })

  it('fields: leaf views are identity-stable across reads and writes', () => {
    const { api, app } = mount()
    apps.push(app)
    const first = api.fields.email
    expect(api.fields.email).toBe(first)
    api.setValue('email', 'changed@x.com')
    expect(api.fields.email).toBe(first)
    expect(api.fields.email.value).toBe('changed@x.com')
    expect(api.fields.items[0]).toBe(api.fields.items[0])
  })

  it('fields: leaf views and call-form terminals enumerate the FieldState keys', () => {
    const { api, app } = mount()
    apps.push(app)
    expect(Object.keys(api.fields.email).sort()).toEqual([...FIELD_STATE_KEYS].sort())
    expect(Object.keys(api.fields('email')).sort()).toEqual([...FIELD_STATE_KEYS].sort())
    // Snapshot serialisation carries the same keys, minus the ones whose
    // value is undefined here (JSON drops those).
    const snapshot = JSON.parse(JSON.stringify(api.fields.email))
    const fieldStateKeySet = new Set(FIELD_STATE_KEYS)
    expect(Object.keys(snapshot).every((k) => fieldStateKeySet.has(k))).toBe(true)
    expect(Object.keys(snapshot).length).toBeGreaterThanOrEqual(30)
    expect(snapshot.value).toBe('a@b.com')
    expect(snapshot.path).toEqual(['email'])
    expect(snapshot.errors).toEqual([])
  })

  it('fields: containers enumerate live keys; arrays behave as arrays', () => {
    const { api, app } = mount()
    apps.push(app)
    expect(Object.keys(api.fields)).toEqual(['email', 'address', 'items'])
    expect(Array.isArray(api.fields.items)).toBe(true)
    expect(api.fields.items.length).toBe(2)
    const skus = api.fields.items.map((row: { sku: { value: unknown } }) => row.sku.value)
    expect(skus).toEqual(['A', 'B'])
    expect(api.fields.bogus).toBeUndefined()
  })

  it('fields: call forms resolve rollups at containers and undefined off-schema', () => {
    const { api, app } = mount()
    apps.push(app)
    expect(api.fields('email').value).toBe('a@b.com')
    expect(api.fields('address').dirty).toBe(false)
    api.setValue('address.city', 'LA')
    expect(api.fields('address').dirty).toBe(true)
    expect(api.fields('bogus')).toBeUndefined()
  })

  it('values: reads, call forms, enumeration, and JSON round-trip', () => {
    const { api, app } = mount()
    apps.push(app)
    expect(api.values.email).toBe('a@b.com')
    expect(api.values.address.city).toBe('NYC')
    expect(api.values('address.city')).toBe('NYC')
    expect(api.values(['items', 0, 'sku'])).toBe('A')
    expect(api.values().email).toBe('a@b.com')
    expect(Object.keys(api.values)).toEqual(['email', 'address', 'items'])
    expect(JSON.parse(JSON.stringify(api.values))).toEqual(DEFAULTS)
    expect('email' in api.values).toBe(true)
  })

  it('read surfaces reject writes without throwing (warn-and-noop)', () => {
    const { api, app } = mount()
    apps.push(app)
    expect(() => {
      api.values.email = 'nope'
      api.errors.email = []
      api.fields.email.value = 'nope'
      api.fields.email = null
      delete api.errors.email
    }).not.toThrow()
    expect(api.values.email).toBe('a@b.com')
  })

  it('meta: enumerates the full key set and stringifies', () => {
    const { api, app } = mount()
    apps.push(app)
    expect(Object.keys(api.meta).sort()).toEqual(META_KEYS)
    expect(() => JSON.stringify(api.meta)).not.toThrow()
    api.setValue('email', 'x@y.zz')
    expect(api.meta.dirty).toBe(true)
    expect(api.meta.errorCount).toBe(api.meta.errors.length)
  })

  it('meta: the predicate meta argument enumerates the FormMetaBase key set', () => {
    let seenKeys: string[] | null = null
    let seenDirty: boolean | null = null
    const { api, app } = mount()
    apps.push(app)
    void api
    // A dedicated mount with a custom predicate that captures its ctx.
    const custom = makeMounter(useFormV4, schemaV4, {
      defaultValues: DEFAULTS,
      getDisplayState: (
        prev: unknown,
        ctx: { formMeta: Record<string, unknown> & { dirty: boolean } }
      ) => {
        if (seenKeys === null) {
          seenKeys = Object.keys(ctx.formMeta).sort()
          seenDirty = ctx.formMeta.dirty
        }
        return prev
      },
    })()
    apps.push(custom.app)
    // Reading any field state runs the predicate.
    void custom.api.fields.email.displayState
    expect(seenKeys).toEqual(META_BASE_KEYS)
    expect(seenDirty).toBe(false)
  })
})
