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
import { historyPlugin } from '../../src/history'
import { fakeSchema } from '../utils/fake-schema'
import type { Json, ValidationError } from '../../src/runtime/types/types-api'

/**
 * `ValidationError.data` is an opaque JSON passthrough: the consumer
 * attaches a structured server payload (a captcha challenge, a lockout
 * `unlocks_at` timestamp, an MFA step-up descriptor) and Attaform
 * carries it untouched across every surface — the manual setters, the
 * aggregate reads, the SSR serialise / hydrate round-trip, and the
 * undo / redo restore.
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
      { message: 'with', path: ['email'], code: 'c', data: null },
      { message: 'without', path: ['password'], code: 'c' },
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
  function mountForm(extra: Record<string, unknown> = {}): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle: { api?: any } = {}
    const Host = defineComponent({
      setup() {
        handle.api = useForm({ schema, key: `error-data-${keySeq++}`, strict: false, ...extra })
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

  it('carries data intact across an undo / redo round-trip', () => {
    const api = mountForm({ history: historyPlugin() })
    api.setErrors([
      {
        path: ['email'],
        message: 'verify',
        formKey: api.key,
        code: 'api:captcha',
        data: challenge,
      },
    ])
    // setErrors alone records no position; the errors live at the next
    // mutation ride into that mutation's snapshot.
    api.setValue('email', 'a@example.com')
    api.setValue('email', 'b@example.com')

    expect(api.history.undo()).toBe(true)
    expect(api.errors.email?.[0]?.data).toEqual(challenge)

    // Back to the pre-error baseline: the error (and its payload) lift.
    expect(api.history.undo()).toBe(true)
    expect(api.errors.email?.[0]).toBeUndefined()

    // Replaying forward restores the full payload structurally.
    expect(api.history.redo()).toBe(true)
    expect(api.errors.email?.[0]?.data).toEqual(challenge)
  })
})
