// @vitest-environment jsdom
/**
 * `form.errors` enumeration parity gate for PASS2-5.
 *
 * `ownKeys` used to read strictly from the FORM-DATA keys at the
 * container path, while `get` / call-form / `JSON.stringify` read the
 * ERROR stores. So `Object.keys(form.errors)` and `{...form.errors}`
 * silently dropped two important classes of error:
 *
 *   - **Form-level** errors at the synthetic `['']` path (set via
 *     `setFormErrors` or root cross-field refines).
 *   - **Server-only** errors at a path the schema doesn't know
 *     (`['ghost']`, `['address', 'ghost']`).
 *
 * The fix unions the form-data keys with the error-store-derived
 * first-child segments at the container path. Reading
 * `form.errors('')` / `form.errors('ghost')` already returned the
 * merged errors today — this just makes enumeration agree.
 */
import { describe, expect, it } from 'vitest'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { makeMounter } from '../utils/form-harness'

const schemaV4 = zV4.object({
  email: zV4.string(),
  address: zV4.object({ city: zV4.string() }),
})
const schemaV3 = zV3.object({
  email: zV3.string(),
  address: zV3.object({ city: zV3.string() }),
})

const adapters = [
  {
    name: 'v4',
    mount: makeMounter(useFormV4, schemaV4, {
      defaultValues: { email: '', address: { city: '' } },
    }),
  },
  {
    name: 'v3',
    mount: makeMounter(useFormV3, schemaV3, {
      defaultValues: { email: '', address: { city: '' } },
    }),
  },
] as const

describe.each(adapters)('form.errors enumeration — $name', ({ mount }) => {
  it("Object.keys(form.errors) includes '' after setFormErrors", () => {
    const { api, app } = mount()
    api.setFormErrors([{ message: 'top-level' }])
    const keys = Object.keys(api.errors)
    app.unmount()
    expect(keys).toContain('')
  })

  it("Object.keys(form.errors) includes a server-set 'ghost' key", () => {
    const { api, app } = mount()
    api.setFieldErrors([
      { path: ['ghost'], message: 'unknown key', formKey: api.key, code: 'atta:server' },
    ])
    const keys = Object.keys(api.errors)
    app.unmount()
    expect(keys).toContain('ghost')
  })

  it("Object.keys(form.errors.address) includes a nested server-set 'ghost' key", () => {
    const { api, app } = mount()
    api.setFieldErrors([
      {
        path: ['address', 'ghost'],
        message: 'unknown nested key',
        formKey: api.key,
        code: 'atta:server',
      },
    ])
    const keys = Object.keys(api.errors.address)
    app.unmount()
    expect(keys).toContain('ghost')
  })

  // Sanity: the call-form for the form-level bucket already worked
  // pre-fix; pin it so the enumeration fix doesn't silently regress
  // the access path. Ghost-path access via the call-form is intentionally
  // not pinned here: `aggregateErrorsAt`'s active-path filter still
  // drops user errors at unreachable paths today (a separate finding,
  // not in scope for PASS2-5 which only mandates enumeration parity).
  it("form.errors('') still returns the merged form-level errors", () => {
    const { api, app } = mount()
    api.setFormErrors([{ message: 'top-level' }])
    const formLevel = api.errors('') as unknown[]
    app.unmount()
    expect(formLevel.length).toBeGreaterThan(0)
  })

  it('spread {...form.errors} reflects the unioned keys', () => {
    const { api, app } = mount()
    api.setFormErrors([{ message: 'top-level' }])
    api.setFieldErrors([
      { path: ['ghost'], message: 'unknown key', formKey: api.key, code: 'atta:server' },
    ])
    const spread = { ...(api.errors as Record<string, unknown>) }
    app.unmount()
    expect(Object.prototype.hasOwnProperty.call(spread, '')).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(spread, 'ghost')).toBe(true)
  })
})
