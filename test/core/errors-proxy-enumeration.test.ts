// @vitest-environment jsdom
/**
 * `form.errors` enumeration parity gate for PASS2-5.
 *
 * `ownKeys` used to read strictly from the FORM-DATA keys at the
 * container path, while `get` / call-form / `JSON.stringify` read the
 * ERROR stores. So `Object.keys(form.errors)` and `{...form.errors}`
 * silently dropped **server-only** errors at a path the schema doesn't
 * know (`['ghost']`, `['address', 'ghost']`).
 *
 * The fix unions the form-data keys with the error-store-derived
 * first-child segments at the container path. Reading
 * `form.errors('ghost')` already returned the merged errors today —
 * this just makes enumeration agree.
 *
 * Global errors at the root `[]` (`setFormErrors`, root `.refine()`)
 * are NOT a child key, so they never enumerate here and never appear
 * in the serialised tree; every surface agrees, and they're read via
 * `form.errors([])` / `form.meta.errors`.
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
  it("Object.keys(form.errors) excludes '' for a global error (it lives at [])", () => {
    const { api, app } = mount()
    api.setFormErrors([{ message: 'top-level' }])
    const keys = Object.keys(api.errors)
    app.unmount()
    // Global errors are the root's own bucket, not a child key.
    expect(keys).not.toContain('')
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

  // Sanity: the call-form for the global bucket. Ghost-path access via
  // the call-form is intentionally not pinned here: `aggregateErrorsAt`'s
  // active-path filter drops user errors at unreachable paths (a
  // separate finding, not in scope for enumeration parity).
  it('form.errors([]) returns the merged global errors', () => {
    const { api, app } = mount()
    api.setFormErrors([{ message: 'top-level' }])
    const global = api.errors([]) as unknown[]
    app.unmount()
    expect(global.length).toBeGreaterThan(0)
  })

  it('spread {...form.errors} reflects server keys but not the global bucket', () => {
    const { api, app } = mount()
    api.setFormErrors([{ message: 'top-level' }])
    api.setFieldErrors([
      { path: ['ghost'], message: 'unknown key', formKey: api.key, code: 'atta:server' },
    ])
    const spread = { ...(api.errors as Record<string, unknown>) }
    app.unmount()
    // Global at [] is not a child key; the server 'ghost' key is.
    expect(Object.prototype.hasOwnProperty.call(spread, '')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(spread, 'ghost')).toBe(true)
  })
})
