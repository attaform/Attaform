// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderToString } from '@vue/server-renderer'
import { createApp, createSSRApp, defineComponent, h } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import { hydrateAttaformState, renderAttaformState } from '../../src/runtime/core/serialize'
import { getRegistryFromApp } from '../../src/runtime/core/registry'
import { AttaformErrorCode } from '../../src/runtime/core/error-codes'
import type { UseFormReturnType } from '../../src/runtime/types/types-api'

/**
 * SSR + hydration path for async-defaults forms.
 *
 * On the server, function-form `defaultValues` factories fire via
 * `onServerPrefetch`. The framework's SSR awaiter waits for them to
 * resolve before the payload is serialised, so the resolved values
 * bake into the hydration transfer state. On the client, the matching
 * `useForm({ key })` call consumes `pendingHydration` at construction
 * time AND skips re-firing the factory — same data, no double-fetch.
 *
 * Tests run under @vitest-environment node so `@vue/server-renderer`'s
 * `renderToString` can run.
 */

const schema = z.object({ email: z.string(), name: z.string() })

describe('async-defaults SSR + hydration', () => {
  it('resolves the factory server-side before payload serialization', async () => {
    let calls = 0
    const App = defineComponent({
      setup() {
        useForm({
          schema,
          key: 'ssr-async-defaults',
          defaultValues: () => {
            calls += 1
            return Promise.resolve({ email: 'server@example.com', name: 'Ada' })
          },
        })
        return () => h('div')
      },
    })
    const ssrApp = createSSRApp(App).use(createAttaform({ ssr: true }))
    await renderToString(ssrApp)
    expect(calls).toBe(1)

    const payload = renderAttaformState(ssrApp)
    expect(payload.forms).toHaveLength(1)
    const entry = payload.forms[0]
    expect(entry).toBeDefined()
    if (entry === undefined) return
    const [key, data] = entry
    expect(key).toBe('ssr-async-defaults')
    // Resolved values rode the payload — proves `onServerPrefetch`
    // awaited the factory before serialization.
    expect(data.form).toMatchObject({ email: 'server@example.com', name: 'Ada' })
  })

  it('client consumes pendingHydration and skips re-firing the factory', async () => {
    // Server side: same as above.
    let serverCalls = 0
    const ServerApp = defineComponent({
      setup() {
        useForm({
          schema,
          key: 'ssr-async-no-refire',
          defaultValues: () => {
            serverCalls += 1
            return Promise.resolve({ email: 'server@example.com', name: 'Ada' })
          },
        })
        return () => h('div')
      },
    })
    const ssrApp = createSSRApp(ServerApp).use(createAttaform({ ssr: true }))
    await renderToString(ssrApp)
    const payload = renderAttaformState(ssrApp)
    expect(serverCalls).toBe(1)

    // Client side: fresh app, stage hydration, then mount a form with
    // the same key and async factory. The factory must NOT fire.
    let clientCalls = 0
    const clientHandle: { api?: UseFormReturnType<{ email: string; name: string }> } = {}
    const ClientApp = defineComponent({
      setup() {
        clientHandle.api = useForm({
          schema,
          key: 'ssr-async-no-refire',
          defaultValues: () => {
            clientCalls += 1
            return Promise.resolve({ email: 'client-would-fetch@example.com', name: 'Hopper' })
          },
        }) as unknown as UseFormReturnType<{ email: string; name: string }>
        return () => h('div')
      },
    })
    const clientApp = createApp(ClientApp).use(createAttaform())
    hydrateAttaformState(clientApp, payload)
    const registry = getRegistryFromApp(clientApp)
    expect(registry.pendingHydration.has('ssr-async-no-refire')).toBe(true)
    clientApp.config.warnHandler = () => {}
    clientApp.mount(document.createElement('div'))

    const api = clientHandle.api
    expect(api).toBeDefined()
    if (api === undefined) return
    expect(clientCalls).toBe(0)
    expect(api.isHydrating.value).toBe(false)
    expect(api.values.email).toBe('server@example.com')
    expect(api.values.name).toBe('Ada')
  })
})

/**
 * Server-side factory rejection contract.
 *
 * `runFactoryAndApply` swallows the rejection into `hydrateError`, so
 * `onServerPrefetch` never propagates it back to `renderToString`. SSR
 * completes successfully; the serialised payload carries the schema's
 * slim defaults (the factory never landed values on the form). The
 * server-side `hydrateError` is captured but does NOT ride the
 * payload — that's a known gap. Without it, the client trusts the
 * payload, observes "clean slim defaults," and the consumer has to
 * call `form.rehydrate()` to retry the load.
 *
 * These tests pin that contract end-to-end. A future change that
 * routes server-side errors into the payload (so the client surfaces
 * a retry banner automatically) would update the assertion in the
 * last test.
 */
describe('async-defaults SSR rejection path', () => {
  it('rejected factory does not crash renderToString; surfaces error via hydrateError + schemaErrors', async () => {
    const boom = new Error('upstream-down')
    const handle: { api?: UseFormReturnType<{ email: string; name: string }> } = {}
    const App = defineComponent({
      setup() {
        handle.api = useForm({
          schema,
          key: 'ssr-async-reject',
          defaultValues: () => Promise.reject(boom),
        }) as unknown as UseFormReturnType<{ email: string; name: string }>
        return () => h('div')
      },
    })
    const ssrApp = createSSRApp(App).use(createAttaform({ ssr: true }))

    // SSR completes without throwing. The rejection is caught inside
    // runFactoryAndApply, so onServerPrefetch returns a resolved
    // Promise and the awaiter proceeds.
    await renderToString(ssrApp)

    const api = handle.api
    expect(api).toBeDefined()
    if (api === undefined) return

    // Server-side state after the rejection settled: error captured,
    // isHydrating released, form falls back to schema slim defaults.
    expect(api.hydrateError.value).toBe(boom)
    expect(api.isHydrating.value).toBe(false)
    expect(api.values.email).toBe('')
    expect(api.values.name).toBe('')

    // The raw error also surfaces through the standard ValidationError
    // pipeline as a form-level HydrationFailed entry. This is what
    // makes the failure cross the SSR wire to the client (`hydrateError`
    // itself stays local; `schemaErrors` rides the payload).
    const hydrationErr = api.meta.errors.find((e) => e.code === AttaformErrorCode.HydrationFailed)
    expect(hydrationErr).toBeDefined()
    expect(hydrationErr?.message).toBe('upstream-down')
    expect(hydrationErr?.path).toEqual([''])

    // Payload serialises with the form-level error included.
    const payload = renderAttaformState(ssrApp)
    expect(payload.forms).toHaveLength(1)
    const entry = payload.forms[0]
    if (entry === undefined) return
    expect(entry[1].form).toEqual({ email: '', name: '' })
    expect(entry[1].schemaErrors.length).toBeGreaterThan(0)
  })

  it('client hydration after a server-side rejection: factory does NOT re-fire (current behavior)', async () => {
    // Server: factory rejects, payload serialises slim defaults.
    const ServerApp = defineComponent({
      setup() {
        useForm({
          schema,
          key: 'ssr-reject-client-noop',
          defaultValues: () => Promise.reject(new Error('server-down')),
        })
        return () => h('div')
      },
    })
    const ssrApp = createSSRApp(ServerApp).use(createAttaform({ ssr: true }))
    await renderToString(ssrApp)
    const payload = renderAttaformState(ssrApp)

    // Client: same key, fresh factory that WOULD recover if it ran.
    let clientCalls = 0
    const clientHandle: { api?: UseFormReturnType<{ email: string; name: string }> } = {}
    const ClientApp = defineComponent({
      setup() {
        clientHandle.api = useForm({
          schema,
          key: 'ssr-reject-client-noop',
          defaultValues: () => {
            clientCalls += 1
            return Promise.resolve({ email: 'client-recovered@example.com', name: 'Hopper' })
          },
        }) as unknown as UseFormReturnType<{ email: string; name: string }>
        return () => h('div')
      },
    })
    const clientApp = createApp(ClientApp).use(createAttaform())
    hydrateAttaformState(clientApp, payload)
    clientApp.config.warnHandler = () => {}
    clientApp.mount(document.createElement('div'))

    const api = clientHandle.api
    if (api === undefined) return

    // Current contract: client trusts the payload (which the server
    // hydration registry has flagged as "already resolved") and skips
    // the factory. hydrateError stays null on the client because the
    // raw error doesn't ride the payload. The server-side failure
    // crosses the wire via the HydrationFailed entry in schemaErrors,
    // surfacing through form.meta.errors — consumers render an error
    // banner / retry button off this entry.
    expect(clientCalls).toBe(0)
    expect(api.isHydrating.value).toBe(false)
    expect(api.hydrateError.value).toBeNull()
    expect(api.values.email).toBe('')
    expect(api.values.name).toBe('')
    const hydrationErr = api.meta.errors.find((e) => e.code === AttaformErrorCode.HydrationFailed)
    expect(hydrationErr).toBeDefined()
    expect(hydrationErr?.message).toBe('server-down')
  })

  it('client recovery: form.rehydrate() re-fires the factory and applies the new payload', async () => {
    // Same server setup as the prior test.
    const ServerApp = defineComponent({
      setup() {
        useForm({
          schema,
          key: 'ssr-reject-client-retry',
          defaultValues: () => Promise.reject(new Error('server-down')),
        })
        return () => h('div')
      },
    })
    const ssrApp = createSSRApp(ServerApp).use(createAttaform({ ssr: true }))
    await renderToString(ssrApp)
    const payload = renderAttaformState(ssrApp)

    let clientCalls = 0
    const clientHandle: { api?: UseFormReturnType<{ email: string; name: string }> } = {}
    const ClientApp = defineComponent({
      setup() {
        clientHandle.api = useForm({
          schema,
          key: 'ssr-reject-client-retry',
          defaultValues: () => {
            clientCalls += 1
            return Promise.resolve({ email: 'recovered@example.com', name: 'Hopper' })
          },
        }) as unknown as UseFormReturnType<{ email: string; name: string }>
        return () => h('div')
      },
    })
    const clientApp = createApp(ClientApp).use(createAttaform())
    hydrateAttaformState(clientApp, payload)
    clientApp.config.warnHandler = () => {}
    clientApp.mount(document.createElement('div'))

    const api = clientHandle.api
    if (api === undefined) return

    // Pre-recovery state: the HydrationFailed entry is on the surface
    // from the SSR rejection (rides the wire via schemaErrors).
    const preErr = api.meta.errors.find((e) => e.code === AttaformErrorCode.HydrationFailed)
    expect(preErr).toBeDefined()

    // Consumer-side recovery: call rehydrate() to re-fire the captured
    // factory client-side. The form picks up the resolved values AND
    // the HydrationFailed entry clears (runFactoryAndApply wipes any
    // prior HydrationFailed at entry, only re-adds on rejection).
    await api.rehydrate()
    expect(clientCalls).toBe(1)
    expect(api.hydrateError.value).toBeNull()
    expect(api.isHydrating.value).toBe(false)
    expect(api.values.email).toBe('recovered@example.com')
    expect(api.values.name).toBe('Hopper')
    const postErr = api.meta.errors.find((e) => e.code === AttaformErrorCode.HydrationFailed)
    expect(postErr).toBeUndefined()
  })
})
