// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createFormStore } from '../../src/runtime/core/create-form-store'
import { createAttaform } from '../../src/runtime/core/plugin'
import { getRegistryFromApp } from '../../src/runtime/core/registry'
import { hydrateAttaformState, renderAttaformState } from '../../src/runtime/core/serialize'
import { errorsEqual } from '../../src/runtime/core/history'
import { canonicalizePath, type PathKey } from '../../src/runtime/core/paths'
import { fakeSchema } from '../utils/fake-schema'
import type { Json, ValidationError } from '../../src/runtime/types/types-api'

/**
 * `ValidationError.data` is an opaque JSON passthrough: the consumer
 * attaches a structured server payload (a captcha challenge, a lockout
 * `unlocks_at` timestamp, an MFA step-up descriptor) and Attaform
 * carries it untouched across every surface — the manual setters, the
 * aggregate reads, the SSR serialise / hydrate round-trip, and the
 * undo / redo equality check.
 */

// A nested payload that touches every arm of the `Json` shape (string,
// number, boolean, null, array, object) so the round-trips below prove
// structural preservation, not just shallow copying.
const challenge: Json = {
  kind: 'captcha',
  siteKey: 'abc123',
  attemptsRemaining: 2,
  locked: false,
  unlocksAt: null,
  hints: ['retry', 'slow-down'],
  meta: { provider: 'turnstile', tiers: [1, 2, 3] },
}

type Signup = { email: string; password: string }

describe('ValidationError.data — serialise / hydrate round-trip', () => {
  it('preserves data on user and schema errors across the SSR round-trip', () => {
    const serverApp = createApp({ render: () => null })
    serverApp.use(createAttaform({ ssr: true }))
    const registry = getRegistryFromApp(serverApp)
    const state = createFormStore<Signup>({
      formKey: 'data-rt',
      schema: fakeSchema<Signup>({ email: 'a@a', password: '' }),
    })
    registry.forms.set('data-rt', state)

    state.setAllUserErrors([
      {
        message: 'verify',
        path: ['email'],
        formKey: 'data-rt',
        code: 'api:captcha',
        data: challenge,
      },
    ])
    state.setSchemaErrorsForPath(
      ['password'],
      [
        {
          message: 'weak',
          path: ['password'],
          formKey: 'data-rt',
          code: 'atta:test',
          data: { score: 1 },
        },
      ]
    )

    // Round-trip through JSON the way the SSR payload reaches the client.
    const payload = renderAttaformState(serverApp)
    const reparsed = JSON.parse(JSON.stringify(payload)) as typeof payload

    const clientApp = createApp({ render: () => null })
    clientApp.use(createAttaform())
    hydrateAttaformState(clientApp, reparsed)
    const pending = getRegistryFromApp(clientApp).pendingHydration.get('data-rt')
    expect(pending).toBeDefined()
    if (pending === undefined) return

    const client = createFormStore<Signup>({
      formKey: 'data-rt',
      schema: fakeSchema<Signup>({ email: '', password: '' }),
      hydration: pending,
    })

    expect(client.getErrorsForPath(['email'])[0]?.data).toEqual(challenge)
    expect(client.getErrorsForPath(['password'])[0]?.data).toEqual({ score: 1 })
  })

  it('round-trips a null data slot distinctly from an absent one', () => {
    const serverApp = createApp({ render: () => null })
    serverApp.use(createAttaform({ ssr: true }))
    const registry = getRegistryFromApp(serverApp)
    const state = createFormStore<Signup>({
      formKey: 'data-null',
      schema: fakeSchema<Signup>({ email: 'a@a', password: '' }),
    })
    registry.forms.set('data-null', state)

    state.setAllUserErrors([
      { message: 'with', path: ['email'], formKey: 'data-null', code: 'c', data: null },
      { message: 'without', path: ['password'], formKey: 'data-null', code: 'c' },
    ])

    const payload = JSON.parse(JSON.stringify(renderAttaformState(serverApp)))
    const clientApp = createApp({ render: () => null })
    clientApp.use(createAttaform())
    hydrateAttaformState(clientApp, payload)
    const pending = getRegistryFromApp(clientApp).pendingHydration.get('data-null')
    if (pending === undefined) throw new Error('hydration missing')

    const client = createFormStore<Signup>({
      formKey: 'data-null',
      schema: fakeSchema<Signup>({ email: '', password: '' }),
      hydration: pending,
    })

    expect(client.getErrorsForPath(['email'])[0]?.data).toBeNull()
    expect(client.getErrorsForPath(['password'])[0]).not.toHaveProperty('data')
  })
})

describe('ValidationError.data — history equality', () => {
  const emailKey = canonicalizePath(['email']).key
  const mk = (data?: Json | null): ValidationError[] => {
    const e: ValidationError = { message: 'x', path: ['email'], formKey: 'k', code: 'c' }
    if (data !== undefined) e.data = data
    return [e]
  }
  const at = (errs: ValidationError[]): ReadonlyArray<readonly [PathKey, ValidationError[]]> => [
    [emailKey, errs],
  ]

  it('treats errors that differ only in data as not equal', () => {
    expect(errorsEqual(at(mk({ a: 1 })), at(mk({ a: 2 })))).toBe(false)
  })

  it('treats errors with deep-equal data as equal', () => {
    const a = at(mk({ a: [1, 2], b: { c: 3 } }))
    const b = at(mk({ a: [1, 2], b: { c: 3 } }))
    expect(errorsEqual(a, b)).toBe(true)
  })

  it('treats two no-data errors as equal', () => {
    expect(errorsEqual(at(mk()), at(mk()))).toBe(true)
  })

  it('treats present-data and absent-data as not equal', () => {
    expect(errorsEqual(at(mk({ a: 1 })), at(mk()))).toBe(false)
  })

  it('distinguishes null data from a populated payload', () => {
    expect(errorsEqual(at(mk(null)), at(mk(null)))).toBe(true)
    expect(errorsEqual(at(mk(null)), at(mk({ a: 1 })))).toBe(false)
  })
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (opts: any) => any

const adapters = [
  { name: 'zod v3', useForm: useFormV3 as AnyUseForm, z: zV3 as unknown as typeof zV4 },
  { name: 'zod v4', useForm: useFormV4 as AnyUseForm, z: zV4 },
] as const

let keySeq = 0

describe.each(adapters)('ValidationError.data through the form API — $name', ({ useForm, z }) => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    document.body.innerHTML = ''
  })

  const schema = z.object({
    email: z.string(),
    password: z.string(),
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function mountForm(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle: { api?: any } = {}
    const Host = defineComponent({
      setup() {
        handle.api = useForm({ schema, key: `error-data-${keySeq++}`, strict: false })
        return () => h('div')
      },
    })
    const app = createApp(Host).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    apps.push(app)
    if (handle.api === undefined) throw new Error('mountForm: api never set')
    return handle.api
  }

  it('carries data on a field error through the drill and aggregate reads', () => {
    const api = mountForm()
    api.setErrors([
      {
        path: ['email'],
        message: 'verify',
        formKey: api.key,
        code: 'api:captcha',
        data: challenge,
      },
    ])

    expect(api.errors.email?.[0]?.data).toEqual(challenge)
    const fromMeta = api.meta.errors.find((e: ValidationError) => e.path[0] === 'email')
    expect(fromMeta?.data).toEqual(challenge)
  })

  it('carries data on a form-level error set via setErrors', () => {
    const api = mountForm()
    api.setErrors([{ message: 'too many attempts', data: { unlocksAt: '2026-01-01T00:00:00Z' } }])

    const formLevel = api.meta.errors.find((e: ValidationError) => e.path.length === 0)
    expect(formLevel?.message).toBe('too many attempts')
    expect(formLevel?.data).toEqual({ unlocksAt: '2026-01-01T00:00:00Z' })
  })

  it('omits data when none is supplied', () => {
    const api = mountForm()
    api.setErrors([{ path: ['email'], message: 'taken', formKey: api.key, code: 'api:dupe' }])

    expect(api.errors.email?.[0]).not.toHaveProperty('data')
  })
})
