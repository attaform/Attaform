// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import type { UseFormConfigV4 } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { UseFormReturnType, ValidationError } from '../../src/runtime/types/types-api'
import { waitUntil } from '../utils/form-harness'

/**
 * `form.rehydrate()` re-fires the captured `defaultValues` factory and
 * re-applies the resolved payload. Useful when the upstream source
 * changed (the user picked a different draft from a list, the
 * background sync indicates fresh server data, etc.).
 *
 * Contract:
 *  - Returns a promise that resolves AFTER `hydrating` flips back to
 *    `false`.
 *  - Re-fires the captured factory each call (so consumers don't have
 *    to maintain their own loader).
 *  - Throws synchronously if the form was constructed with a
 *    plain-value `defaultValues` (no factory to invoke).
 *  - Leaves dirty/touched/submit state alone — chain `form.reset()`
 *    for a clean baseline.
 */

type Defaults = { email: string; name: string }
type ApiFor<Schema extends z.ZodObject> = UseFormReturnType<z.output<Schema>>

function mountForm<Schema extends z.ZodObject>(
  schema: Schema,
  defaultValues: NonNullable<UseFormConfigV4<Schema>['defaultValues']>
): { app: App; api: ApiFor<Schema> } {
  const handle: { api?: ApiFor<Schema> } = {}
  const App = defineComponent({
    setup() {
      handle.api = useForm({
        schema,
        key: `rehydrate-${Math.random().toString(36).slice(2)}`,
        defaultValues,
      }) as unknown as ApiFor<Schema>
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.config.warnHandler = () => {}
  app.config.errorHandler = () => {}
  app.mount(document.createElement('div'))
  return { app, api: handle.api as ApiFor<Schema> }
}

describe('form.rehydrate', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  const schema = z.object({ email: z.string(), name: z.string() })

  it('re-fires the captured factory and applies the new payload', async () => {
    let calls = 0
    const factory = (): Promise<Defaults> => {
      calls += 1
      return Promise.resolve(
        calls === 1
          ? { email: 'first@example.com', name: 'Ada' }
          : { email: 'second@example.com', name: 'Hopper' }
      )
    }
    const { app, api } = mountForm(schema, factory)
    apps.push(app)
    await waitUntil(() => (api.hydrating === false ? true : null))
    expect(calls).toBe(1)
    expect(api.values.email).toBe('first@example.com')

    await api.rehydrate()
    expect(calls).toBe(2)
    expect(api.values.email).toBe('second@example.com')
    expect(api.values.name).toBe('Hopper')
  })

  it('resolves only after hydrating flips back to false', async () => {
    let resolveFactory!: (value: Defaults) => void
    let calls = 0
    const factory = (): Promise<Defaults> => {
      calls += 1
      if (calls === 1) return Promise.resolve({ email: 'first@example.com', name: 'Ada' })
      return new Promise<Defaults>((r) => {
        resolveFactory = r
      })
    }
    const { app, api } = mountForm(schema, factory)
    apps.push(app)
    await waitUntil(() => (api.hydrating === false ? true : null))

    const promise = api.rehydrate()
    expect(api.hydrating).toBe(true)
    resolveFactory({ email: 'second@example.com', name: 'Hopper' })
    await promise
    expect(api.hydrating).toBe(false)
    expect(api.values.email).toBe('second@example.com')
  })

  it('throws synchronously when no factory was captured', () => {
    const { app, api } = mountForm(schema, { email: 'a@b.c', name: 'Ada' })
    apps.push(app)
    expect(() => api.rehydrate()).toThrow()
  })

  it('reports a rejected factory through hydrateError', async () => {
    let calls = 0
    const factory = (): Promise<Defaults> => {
      calls += 1
      if (calls === 1) return Promise.resolve({ email: 'first@example.com', name: 'Ada' })
      return Promise.reject(new Error('rehydrate failed'))
    }
    const { app, api } = mountForm(schema, factory)
    apps.push(app)
    await waitUntil(() => (api.hydrating === false ? true : null))
    expect(api.hydrateError).toBeNull()

    await api.rehydrate()
    expect(api.hydrateError).not.toBeNull()
    expect(api.hydrateError?.code).toBe('atta:hydration-failed')
    expect(api.hydrateError?.message).toBe('rehydrate failed')
    expect(api.hydrating).toBe(false)
  })

  it('preserves the prior hydrateError while the retry is in flight (SWR)', async () => {
    // Stale-while-revalidate: the previous attempt's error stays
    // visible through `form.hydrateError` and `form.meta.ownErrors` until
    // the new attempt settles. Mirrors the field-validation contract
    // (`field.validating === true` keeps the error in the store; the
    // UX gate decides whether to surface it). Without SWR, pressing
    // Rehydrate would flicker the error UI to empty for the duration
    // of the retry — confusing.
    let resolveSecond!: (value: Defaults) => void
    let calls = 0
    const factory = (): Promise<Defaults> => {
      calls += 1
      if (calls === 1) return Promise.reject(new Error('first-attempt failed'))
      return new Promise<Defaults>((resolve) => {
        resolveSecond = resolve
      })
    }
    const { app, api } = mountForm(schema, factory)
    apps.push(app)
    await waitUntil(() => (api.hydrating === false ? true : null))
    expect(api.hydrateError?.message).toBe('first-attempt failed')

    // Kick off the retry but don't await — the factory hangs on
    // `resolveSecond` so we can inspect the in-flight state.
    const inFlight = api.rehydrate()
    expect(api.hydrating).toBe(true)
    // SWR: the prior error survives the in-flight window.
    expect(api.hydrateError?.message).toBe('first-attempt failed')
    const formLevel = (
      api.errors as unknown as (p: readonly (string | number)[]) => readonly ValidationError[]
    )([])
    expect(formLevel[0]?.message).toBe('first-attempt failed')

    resolveSecond({ email: 'recovered@example.com', name: 'Recovered' })
    await inFlight

    // New verdict landed; the stale error is cleared.
    expect(api.hydrateError).toBeNull()
    const formLevelAfter = (
      api.errors as unknown as (p: readonly (string | number)[]) => readonly ValidationError[]
    )([])
    expect(formLevelAfter).toEqual([])
    expect(api.values.email).toBe('recovered@example.com')
  })
})
