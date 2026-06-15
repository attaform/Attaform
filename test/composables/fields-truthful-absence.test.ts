// @vitest-environment jsdom
/**
 * Truthful absence on `form.fields` / `form.errors` (model P).
 *
 * Dot / bracket access is pure navigation to a true leaf; a key the
 * container neither declares (fixed object) nor currently holds reads
 * `undefined`, never a permanently-truthy phantom node. The cases:
 *
 *   - out-of-bounds array index, and a non-index key on an array
 *   - a missing record key
 *   - an inactive discriminated-union variant's key (and the flip after
 *     a variant switch)
 *
 * Counterweights that must STAY reachable:
 *
 *   - a declared-but-absent `optional` field of a fixed object (its
 *     state is a real FieldState; `register` keeps working)
 *   - a container's own rolled-up state via the call-form
 *     `form.fields('path')`
 *   - `v-for` over an array field (Array target intact)
 *   - a server error parked at a non-schema key (`form.errors.ghost`)
 *
 * Dual-adapter: every case runs against zod v3 and v4.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'

const defaultValues = {
  links: ['alpha', 'beta'],
  rec: { known: 'x' },
  user: { name: 'Ada' },
  cargo: { kind: 'general', weight: 10 },
}

const schemaV4 = zV4.object({
  links: zV4.array(zV4.string()),
  rec: zV4.record(zV4.string(), zV4.string()),
  user: zV4.object({ name: zV4.string(), nickname: zV4.string().optional() }),
  cargo: zV4.discriminatedUnion('kind', [
    zV4.object({ kind: zV4.literal('general'), weight: zV4.number() }),
    zV4.object({ kind: zV4.literal('hazmat'), permitNumber: zV4.string() }),
  ]),
})

const schemaV3 = zV3.object({
  links: zV3.array(zV3.string()),
  rec: zV3.record(zV3.string(), zV3.string()),
  user: zV3.object({ name: zV3.string(), nickname: zV3.string().optional() }),
  cargo: zV3.discriminatedUnion('kind', [
    zV3.object({ kind: zV3.literal('general'), weight: zV3.number() }),
    zV3.object({ kind: zV3.literal('hazmat'), permitNumber: zV3.string() }),
  ]),
})

const adapters = [
  { name: 'v4', mount: makeMounter(useFormV4, schemaV4, { defaultValues }) },
  { name: 'v3', mount: makeMounter(useFormV3, schemaV3, { defaultValues }) },
] as const

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
  document.body.innerHTML = ''
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mountForm(mount: () => { api: any; app: App }) {
  const { api, app } = mount()
  apps.push(app)
  return api
}

describe.each(adapters)('truthful absence — $name', ({ mount }) => {
  it('array: in-bounds index navigates, out-of-bounds and non-index keys are undefined', () => {
    const form = mountForm(mount)
    expect(form.fields.links[0].value).toBe('alpha')
    expect(form.fields.links[1].value).toBe('beta')
    // Out of bounds and a non-index key: undefined, not a phantom node.
    expect(form.fields.links[5]).toBeUndefined()
    expect(form.fields.links.busy).toBeUndefined()
  })

  it('record: a present key navigates, a missing key is undefined (no phantom)', () => {
    const form = mountForm(mount)
    expect(form.fields.rec.known.value).toBe('x')
    expect(form.fields.rec.missing).toBeUndefined()
    // A falsy-check on the missing key must agree with the runtime.
    expect(Boolean(form.fields.rec.missing)).toBe(false)
  })

  it('discriminated union: only the active variant key navigates', () => {
    const form = mountForm(mount)
    expect(form.fields.cargo.kind.value).toBe('general')
    expect(form.fields.cargo.weight.value).toBe(10)
    // permitNumber belongs to the inactive `hazmat` variant.
    expect(form.fields.cargo.permitNumber).toBeUndefined()
  })

  it('discriminated union: keys flip after a variant switch', () => {
    const form = mountForm(mount)
    form.setValue('cargo', { kind: 'hazmat', permitNumber: 'AB-12' })
    expect(form.fields.cargo.permitNumber.value).toBe('AB-12')
    // weight now belongs to the inactive `general` variant.
    expect(form.fields.cargo.weight).toBeUndefined()
  })

  it('fixed object: a declared-but-absent optional field stays a real FieldState', () => {
    const form = mountForm(mount)
    expect(form.fields.user.name.value).toBe('Ada')
    // nickname is declared (optional) but absent from the data: a real
    // FieldState whose value is undefined — NOT an undefined node.
    expect(form.fields.user.nickname).toBeDefined()
    expect(form.fields.user.nickname.value).toBeUndefined()
    // Real FieldState shape (not a bare undefined node).
    expect(typeof form.fields.user.nickname.valid).toBe('boolean')
    // And it stays registrable.
    expect(() => form.register('user.nickname')).not.toThrow()
  })

  it("container's own rolled-up state reads through the call-form", () => {
    const form = mountForm(mount)
    const links = form.fields('links')
    expect(links.value).toEqual(['alpha', 'beta'])
    expect(links.busy).toBe(false)
    expect(links.transformError).toBeNull()
  })

  it('call-form: a schema-invalid path is undefined; a schema-valid path is a FieldState', () => {
    const form = mountForm(mount)
    // The schema declares these, so each resolves a FieldState: a leaf, a
    // container aggregate, and an inactive-variant key (the schema admits
    // it even though the `general` variant is live).
    expect(form.fields('user.name')).toBeDefined()
    expect(form.fields('cargo')).toBeDefined()
    expect(form.fields('cargo.permitNumber')).toBeDefined()
    // A path the schema doesn't declare is a typo, not a field: undefined,
    // not a phantom stub.
    expect(form.fields('nope')).toBeUndefined()
    expect(form.fields('user.bogus')).toBeUndefined()
  })

  it('array field stays a real Array target (v-for / Array.isArray intact)', () => {
    const form = mountForm(mount)
    expect(Array.isArray(form.fields.links)).toBe(true)
    expect(form.fields.links.length).toBe(2)
    const values = [...form.fields.links].map((f: { value: string }) => f.value)
    expect(values).toEqual(['alpha', 'beta'])
  })

  it('errors: a server error at a non-schema key surfaces; an unknown key is undefined', () => {
    const form = mountForm(mount)
    form.setErrors([
      { path: ['ghost'], message: 'server says no', formKey: form.key, code: 'api:validation' },
    ])
    // The error stores "hold" `ghost`, so the gate keeps it reachable
    // (not swallowed); the message lands on the container-self sentinel.
    expect(form.errors.ghost).toBeDefined()
    expect(form.errors.ghost['']).toEqual([expect.objectContaining({ message: 'server says no' })])
    // A key with neither data nor error is undefined, not a permissive proxy.
    expect(form.errors.bogus).toBeUndefined()
  })

  it('errors: an out-of-bounds array index with no error is undefined', () => {
    const form = mountForm(mount)
    expect(form.errors.links[5]).toBeUndefined()
  })
})
