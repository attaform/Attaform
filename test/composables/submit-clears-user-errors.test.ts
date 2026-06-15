// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import type { UseFormReturn } from '../../src/zod'
import type { ValidationError } from '../../src/runtime/types/types-api'
import { createAttaform } from '../../src/runtime/core/plugin'
import { waitUntil } from '../utils/form-harness'

/**
 * A fresh `handleSubmit` attempt clears user-set errors
 * (`setFormErrors` / `setFieldErrors`) at ENTRY — before validation,
 * before the consumer's callback — so every attempt starts from a clean
 * user-error slate. This mirrors `submitError`, which already nulls at
 * entry; together they make a submit a "reset the error surface, then
 * repopulate it" event.
 *
 * Entry (not exit) is the only correct point: the consumer's `onSubmit`
 * is where the NEW errors are set (a failed `await api.save()` →
 * `setFormErrors`), so clearing after it would wipe what was just set;
 * and clearing only on success leaves stale errors when the next attempt
 * fails differently or fails client validation.
 *
 * The clear is unconditional (no opt-out) and total (form-level AND
 * field-level). Errors set DURING the callback survive — they land after
 * the entry-clear — and persist until the next attempt.
 */

const schema = z.object({
  email: z.string().email('bad email'),
  password: z.string().min(8, 'min 8 chars'),
})

type Api = UseFormReturn<typeof schema>

function mount(defaultValues: { email: string; password: string }): { app: App; api: Api } {
  const handle: { api?: Api } = {}
  const App = defineComponent({
    setup() {
      handle.api = useForm({
        schema,
        key: `clear-user-errors-${Math.random().toString(36).slice(2)}`,
        defaultValues,
      })
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.config.warnHandler = () => {}
  app.config.errorHandler = () => {}
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  return { app, api: handle.api as Api }
}

const valid = { email: 'user@example.com', password: 'password1' }

const formLevel = (errors: readonly ValidationError[]): readonly ValidationError[] =>
  errors.filter((e) => e.path.length === 0)
const atPath = (errors: readonly ValidationError[], field: string): readonly ValidationError[] =>
  errors.filter((e) => e.path[0] === field)

describe('handleSubmit clears user-set errors at entry', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('a successful retry clears the prior attempt’s server error', async () => {
    const { app, api } = mount(valid)
    apps.push(app)

    // Attempt 1 fails at the server → sets a form-level error.
    await api.handleSubmit(() => {
      api.setFormErrors([{ message: 'Server error' }])
    })(new Event('submit'))
    expect(formLevel(api.meta.errors)).toHaveLength(1)

    // Attempt 2 succeeds and sets nothing — the stale error must be gone.
    await api.handleSubmit(() => {})(new Event('submit'))
    await waitUntil(() => formLevel(api.meta.errors).length === 0)
    expect(formLevel(api.meta.errors)).toHaveLength(0)
  })

  it('a differently-failing retry drops the errors the new attempt did not re-report', async () => {
    const { app, api } = mount(valid)
    apps.push(app)

    // Attempt 1: server rejects both fields.
    await api.handleSubmit(() => {
      api.setFieldErrors([
        { path: ['email'], message: 'email taken', formKey: api.key, code: 'api:validation' },
        { path: ['password'], message: 'password pwned', formKey: api.key, code: 'api:validation' },
      ])
    })(new Event('submit'))
    expect(atPath(api.meta.errors, 'email')).toHaveLength(1)
    expect(atPath(api.meta.errors, 'password')).toHaveLength(1)

    // Attempt 2: server rejects only email — the stale password error
    // must not linger.
    await api.handleSubmit(() => {
      api.setFieldErrors([
        { path: ['email'], message: 'email taken', formKey: api.key, code: 'api:validation' },
      ])
    })(new Event('submit'))
    await waitUntil(() => atPath(api.meta.errors, 'password').length === 0)
    expect(atPath(api.meta.errors, 'email')).toHaveLength(1)
    expect(atPath(api.meta.errors, 'password')).toHaveLength(0)
  })

  it('a client-validation failure still clears the prior server error', async () => {
    const { app, api } = mount(valid)
    apps.push(app)

    await api.handleSubmit(() => {
      api.setFormErrors([{ message: 'Server error' }])
    })(new Event('submit'))
    expect(formLevel(api.meta.errors)).toHaveLength(1)

    // Now make the form invalid; the next attempt never reaches onSubmit.
    api.setValue('email', 'not-an-email')
    await api.handleSubmit(() => {})(new Event('submit'))
    await waitUntil(() => formLevel(api.meta.errors).length === 0)
    // The server error is gone; only the fresh schema error remains.
    expect(formLevel(api.meta.errors)).toHaveLength(0)
    expect(atPath(api.meta.errors, 'email').some((e) => e.message === 'bad email')).toBe(true)
  })

  it('errors set DURING the callback survive that submit (entry-clear ran before)', async () => {
    const { app, api } = mount(valid)
    apps.push(app)
    await api.handleSubmit(() => {
      api.setFormErrors([{ message: 'fresh error' }])
    })(new Event('submit'))
    const entries = formLevel(api.meta.errors)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.message).toBe('fresh error')
  })

  it('clears user errors set OUTSIDE a submit (unconditional, no opt-out)', async () => {
    const { app, api } = mount(valid)
    apps.push(app)
    api.setFormErrors([{ message: 'set imperatively' }])
    expect(formLevel(api.meta.errors)).toHaveLength(1)

    await api.handleSubmit(() => {})(new Event('submit'))
    await waitUntil(() => formLevel(api.meta.errors).length === 0)
    expect(formLevel(api.meta.errors)).toHaveLength(0)
  })

  it('does not clear user errors on an imperative parse() / validateAsync (submit-only)', async () => {
    const { app, api } = mount(valid)
    apps.push(app)
    api.setFormErrors([{ message: 'keep me' }])
    await api.parse()
    await api.validateAsync()
    expect(formLevel(api.meta.errors)).toHaveLength(1)
  })
})
