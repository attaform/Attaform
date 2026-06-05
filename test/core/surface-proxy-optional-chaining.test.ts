// @vitest-environment jsdom
/**
 * Callable surface proxies survive downleveled optional chaining.
 *
 * `form.fields(path)?.x` / `form.errors(path)?.x` is the idiomatic
 * call-form. A bundler that downlevels optional chaining — sucrase
 * (what `@vue/repl` strips TS with), or any target below ES2020 —
 * compiles it into a helper that READS `.call` off the surface and
 * invokes the result to call the surface. Pre-fix the `get` trap
 * descended on `call`, handing back a non-callable sub-proxy, so the
 * helper threw `value.call is not a function` (the `@vue/repl` preview
 * crash). The fix answers `call` / `apply` / `bind` with a callable
 * shim that ALSO stays transparent to a field literally named
 * call / apply / bind — so a telephone-company form keeps its `call`
 * field. Both guarantees, both adapters.
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

const adapters = [
  { name: 'v4', mount: makeMounter(useFormV4, schemaV4, { defaultValues: shape }) },
  { name: 'v3', mount: makeMounter(useFormV3, schemaV3, { defaultValues: shape }) },
] as const

// Faithful copy of sucrase's `_optionalChain` helper — the exact runtime
// shape `@vue/repl` emits when it downlevels `surface(path)?.x`. Its
// `call` step reads `value.call` off the surface, which is what threw
// pre-fix.
function optionalChain(ops: unknown[]): unknown {
  let lastAccessLHS: unknown = undefined
  let value: unknown = ops[0]
  let i = 1
  while (i < ops.length) {
    const op = ops[i] as string
    const fn = ops[i + 1] as (arg: unknown) => unknown
    i += 2
    if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) {
      return undefined
    } else if (op === 'access' || op === 'optionalAccess') {
      lastAccessLHS = value
      value = fn(value)
    } else if (op === 'call' || op === 'optionalCall') {
      const lhs = lastAccessLHS
      const target = value as (this: unknown, ...args: unknown[]) => unknown
      value = fn((...args: unknown[]) => target.call(lhs, ...args))
      lastAccessLHS = undefined
    }
  }
  return value
}

const access = (key: string) => (o: unknown) => (o as Record<string, unknown>)[key]
const callPath = (path: string) => (f: unknown) => (f as (p: string) => unknown)(path)

describe.each(adapters)('callable surface × downleveled optional chaining — $name', ({ mount }) => {
  it('form.fields(path)?.x survives the sucrase _optionalChain helper', () => {
    const { api, app } = mount()
    // `form.fields('email')?.value`
    const value = optionalChain([
      api,
      'access',
      access('fields'),
      'call',
      callPath('email'),
      'optionalAccess',
      access('value'),
    ])
    expect(value).toBe('ada@site.example')
    expect(value).toBe(api.fields.email.value)
    app.unmount()
  })

  it('form.errors(path) call-form survives the helper too', () => {
    const { api, app } = mount()
    const direct = api.errors('email')
    const viaChain = optionalChain([api, 'access', access('errors'), 'call', callPath('email')])
    // Same terminal both ways — the downleveled `.call` no longer throws.
    expect(viaChain).toStrictEqual(direct)
    app.unmount()
  })

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

  it('the `call` field and the downleveled invoke path coexist in one module', () => {
    const { api, app } = mount()
    // Reading the `call` field...
    expect(api.fields.call.value).toBe('+1-555-0100')
    // ...does not stop the downleveled call-form from resolving a sibling.
    const value = optionalChain([
      api,
      'access',
      access('fields'),
      'call',
      callPath('apply'),
      'optionalAccess',
      access('value'),
    ])
    expect(value).toBe('submitted')
    app.unmount()
  })
})
