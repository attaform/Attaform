// @vitest-environment jsdom
/**
 * Callable surfaces × fields named after Function.prototype members.
 *
 * The surfaces carry no `call` / `apply` / `bind` special-casing: a
 * schema field with one of those names is an ordinary declared field
 * (reachable by dot and call form through the truthful descend gate),
 * and on a schema WITHOUT such a field the same reads are `undefined`
 * like any other absent key. Native optional chaining over the call
 * form (`form.fields(path)?.value`, ES2020+) is the supported form;
 * transpilers that downlevel `?.` into a `.call`-reading helper are
 * not supported against these surfaces.
 */
import { describe, expect, it } from 'vitest'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'

// A form for a telephone company: fields literally named `call`, plus
// `apply` and `bind`, alongside a plain field.
const shape = {
  email: 'ada@site.example',
  call: '+1-555-0100',
  apply: 'submitted',
  bind: 'legal',
}
const schemaV4 = zV4.object({
  email: zV4.string(),
  call: zV4.string(),
  apply: zV4.string(),
  bind: zV4.string(),
})
const schemaV3 = zV3.object({
  email: zV3.string(),
  call: zV3.string(),
  apply: zV3.string(),
  bind: zV3.string(),
})

const plainV4 = zV4.object({ email: zV4.string() })
const plainV3 = zV3.object({ email: zV3.string() })

const adapters = [
  {
    name: 'v4',
    mount: makeMounter(useFormV4, schemaV4, { defaultValues: shape }),
    mountPlain: makeMounter(useFormV4, plainV4, { defaultValues: { email: 'a@b.c' } }),
  },
  {
    name: 'v3',
    mount: makeMounter(useFormV3, schemaV3, { defaultValues: shape }),
    mountPlain: makeMounter(useFormV3, plainV3, { defaultValues: { email: 'a@b.c' } }),
  },
] as const

describe.each(adapters)(
  'callable surface × Function.prototype-named fields — $name',
  ({ mount, mountPlain }) => {
    it('a field literally named `call` stays reachable (dot + call form)', () => {
      const { api, app } = mount()
      expect(api.fields.call.value).toBe('+1-555-0100')
      expect(api.fields('call').value).toBe('+1-555-0100')
      expect(api.fields.call.touched).toBe(false)
      app.unmount()
    })

    it('fields named `apply` / `bind` stay reachable', () => {
      const { api, app } = mount()
      expect(api.fields.apply.value).toBe('submitted')
      expect(api.fields.bind.value).toBe('legal')
      app.unmount()
    })

    it('values and errors surfaces reach the exotic names too', () => {
      const { api, app } = mount()
      expect(api.values.call).toBe('+1-555-0100')
      expect(api.values('apply')).toBe('submitted')
      expect(Array.isArray(api.errors.call)).toBe(true)
      app.unmount()
    })

    it('without such fields, `.call` / `.apply` / `.bind` read undefined', () => {
      const { api, app } = mountPlain()
      expect(api.fields.call).toBeUndefined()
      expect(api.fields.apply).toBeUndefined()
      expect(api.fields.bind).toBeUndefined()
      expect(api.errors.call).toBeUndefined()
      app.unmount()
    })

    it('native optional chaining over the call form resolves and short-circuits', () => {
      const { api, app } = mountPlain()
      expect(api.fields('email')?.value).toBe('a@b.c')
      expect(api.fields('bogus')?.value).toBeUndefined()
      expect(api.errors('email')?.length).toBe(0)
      app.unmount()
    })
  }
)
