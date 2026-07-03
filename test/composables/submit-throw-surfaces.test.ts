// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import { AttaformErrorCode } from '../../src/runtime/core/error-codes'
import { waitUntil } from '../utils/form-harness'
import type { ValidationError } from '../../src/runtime/types/types-api'

/**
 * A throw or rejection out of a `handleSubmit` `onSubmit` callback is
 * surfaced two ways: the raw `Error` parks on `form.meta.submitError`
 * (an inspection channel), AND a normalized copy is piped into the
 * user-error layer under `atta:submit-error` so it shows on
 * `form.errors` / `meta.ownErrors` / `firstOwnError` — the surfaces a UI
 * already renders. A well-constructed throw (`{ path, message, code? }`,
 * or an array of them) lands path-scoped with its own code; a bare
 * `Error` or a non-Error throw lands form-level (`[]`).
 *
 * `onError` is the validation-verdict handler and never fires on a
 * throw: by the time `onSubmit` ran, validation had already passed.
 * A crashed *validation* `onError` (wrapped as `SubmitErrorHandlerError`)
 * is the one throw that stays `submitError`-only and is NOT injected.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (opts: any) => any

const adapters = [
  { name: 'zod v3', useForm: useFormV3 as AnyUseForm, z: zV3 as unknown as typeof zV4 },
  { name: 'zod v4', useForm: useFormV4 as AnyUseForm, z: zV4 },
] as const

let keySeq = 0

describe.each(adapters)('handleSubmit throw surfacing — $name', ({ useForm, z }) => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  // `email` carries a `min(3)` so an invalid default (`'ab'`) drives the
  // validation-failure path used by the SubmitErrorHandlerError test;
  // every other test mounts with a valid default so `onSubmit` runs.
  const schema = z.object({ email: z.string().min(3), password: z.string() })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function mountForm(defaultValues: { email: string; password: string }): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle: { api?: any } = {}
    const Host = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: `submit-throw-${keySeq++}`,
          strict: false,
          defaultValues,
        })
        return () => h('div')
      },
    })
    const app = createApp(Host).use(createAttaform())
    app.config.warnHandler = () => {}
    app.config.errorHandler = () => {}
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    apps.push(app)
    if (handle.api === undefined) throw new Error('mountForm: api never set')
    return handle.api
  }

  const valid = { email: 'user@example.com', password: 'secret' }

  it('surfaces a thrown Error as a form-level error and keeps submitError', async () => {
    const api = mountForm(valid)
    const boom = new Error('Payment declined')
    const onError = vi.fn()
    const handler = api.handleSubmit(async () => {
      throw boom
    }, onError)
    await handler(new Event('submit'))
    await waitUntil(() => api.meta.submissionAttempts >= 1)

    // Injected into the user-error layer at the form-level [] bucket.
    expect(api.meta.ownErrors).toHaveLength(1)
    const entry: ValidationError = api.meta.ownErrors[0]
    expect(entry.message).toBe('Payment declined')
    expect(entry.path).toEqual([])
    expect(entry.code).toBe(AttaformErrorCode.SubmitError)
    // #489 banner accessor now also catches the thrown submit error.
    expect(api.meta.firstOwnError?.message).toBe('Payment declined')

    // The raw Error is still the submitError, byte-identical (not re-wrapped).
    expect(api.meta.submitError).toBe(boom)

    // A throw is not a success and not a validation verdict.
    expect(api.meta.submitted).toBe(false)
    expect(api.meta.valid).toBe(false)
    expect(onError).not.toHaveBeenCalled()
  })

  it('routes a well-constructed thrown object to its path with its code', async () => {
    const api = mountForm(valid)
    const handler = api.handleSubmit(async () => {
      throw { path: ['email'], message: 'Already taken', code: 'api:dupe' }
    })
    await handler(new Event('submit'))
    await waitUntil(() => api.meta.submissionAttempts >= 1)

    const own: ValidationError[] = api.fields.email.ownErrors
    expect(own).toHaveLength(1)
    expect(own[0]?.message).toBe('Already taken')
    expect(own[0]?.code).toBe('api:dupe')
    expect(own[0]?.path).toEqual(['email'])
    // Path-scoped: the root [] bucket stays clean.
    expect(api.meta.ownErrors).toHaveLength(0)
    expect(api.meta.submitted).toBe(false)
  })

  it('spreads a thrown array of errors across multiple paths', async () => {
    const api = mountForm(valid)
    const handler = api.handleSubmit(async () => {
      throw [
        { path: ['email'], message: 'Bad email' },
        { path: ['password'], message: 'Bad password' },
      ]
    })
    await handler(new Event('submit'))
    await waitUntil(() => api.meta.submissionAttempts >= 1)

    const emailOwn: ValidationError[] = api.fields.email.ownErrors
    const passwordOwn: ValidationError[] = api.fields.password.ownErrors
    expect(emailOwn[0]?.message).toBe('Bad email')
    expect(passwordOwn[0]?.message).toBe('Bad password')
    // Both default to the submit-error code.
    expect(emailOwn[0]?.code).toBe(AttaformErrorCode.SubmitError)
  })

  it('injects a diagnostic entry and warns in dev on a non-Error throw', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const api = mountForm(valid)
    const handler = api.handleSubmit(async () => {
      throw undefined
    })
    await handler(new Event('submit'))
    await waitUntil(() => api.meta.submissionAttempts >= 1)

    expect(api.meta.ownErrors).toHaveLength(1)
    const entry: ValidationError = api.meta.ownErrors[0]
    expect(entry.message).toBe('Submit callback threw a non-Error value (undefined)')
    expect(entry.code).toBe(AttaformErrorCode.SubmitError)
    // submitError is coerced to a real Error carrying the diagnostic.
    expect(api.meta.submitError).toBeInstanceOf(Error)
    // Dev-mode nudge to throw a real Error / ValidationError next time.
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('non-Error value')
  })

  it('clears an injected throw error on the next submit', async () => {
    const api = mountForm(valid)
    let calls = 0
    const handler = api.handleSubmit(async () => {
      calls += 1
      if (calls === 1) throw new Error('transient')
    })

    await handler(new Event('submit'))
    await waitUntil(() => api.meta.submissionAttempts >= 1)
    expect(api.meta.ownErrors).toHaveLength(1)

    await handler(new Event('submit'))
    await waitUntil(() => api.meta.submitted)
    // Entry-clear at submit start wiped the prior injection; a clean
    // second run submits successfully with an empty error layer.
    expect(api.meta.ownErrors).toHaveLength(0)
    expect(api.meta.submitted).toBe(true)
    expect(api.meta.submitError).toBe(null)
  })

  it('keeps a crashed validation onError as submitError-only, never injected', async () => {
    // Invalid default → validation fails → onError runs (onSubmit never
    // does). The onError itself throws, which wraps as
    // SubmitErrorHandlerError and must NOT pipe into the error layer.
    const api = mountForm({ email: 'ab', password: 'secret' })
    const handler = api.handleSubmit(
      async () => {
        throw new Error('should not run')
      },
      () => {
        throw new Error('handler boom')
      }
    )
    await handler(new Event('submit'))
    await waitUntil(() => api.meta.submissionAttempts >= 1)

    // The wrapped handler crash is parked for inspection...
    expect(api.meta.submitError).toBeInstanceOf(Error)
    // ...the validation error is present...
    expect(api.meta.errors.length).toBeGreaterThan(0)
    // ...but nothing was injected under the submit-error code.
    expect(
      api.meta.errors.every((e: ValidationError) => e.code !== AttaformErrorCode.SubmitError)
    ).toBe(true)
  })
})
