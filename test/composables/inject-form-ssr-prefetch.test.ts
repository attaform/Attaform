// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderToString } from '@vue/server-renderer'
import { createSSRApp, defineComponent, h } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { injectForm } from '../../src/runtime/composables/use-form-context'
import { createAttaform } from '../../src/runtime/core/plugin'
import { renderAttaformState } from '../../src/runtime/core/serialize'
/**
 * Cross-component SSR coordination via `injectForm`.
 *
 * Phase 2 widens the `injectForm` signature to accept either a
 * `FormKey` string (the existing shortcut) or an options object
 * `{ key?: FormKey; __ssrAccessed?: boolean }`. The Phase 3 Vite
 * transform injects `__ssrAccessed: true` into descendant
 * `injectForm` calls whose surrounding template reads the form's
 * reactive state, but the runtime hook must exist before the
 * transform can drive it.
 *
 * Runtime contract: when `injectForm({ key, __ssrAccessed: true })`
 * is called on the server, the descendant component:
 *  1. enqueues `key` on the registry's SSR prefetch queue;
 *  2. registers an `onServerPrefetch` hook on itself that calls
 *     `state.activate()` to drain the queue.
 *
 * Net behaviour: a parent that constructs `useForm({ key })` without
 * reading it itself stays dormant on the server (no factory). A
 * descendant that calls `injectForm({ key, __ssrAccessed: true })`
 * is what causes the factory to fire — and it fires once across all
 * descendants thanks to the shared activation promise.
 */

type UserShape = { email: string; name: string }
const schema = z.object({ email: z.string(), name: z.string() })

describe('injectForm SSR prefetch coordination', () => {
  it('descendant with __ssrAccessed fires the parent-constructed factory once', async () => {
    let calls = 0
    const Child = defineComponent({
      setup() {
        const form = injectForm<UserShape>({
          key: 'inject-ssr',
          __ssrAccessed: true,
        })
        return () => h('div', form?.values.email ?? '')
      },
    })
    const App = defineComponent({
      setup() {
        useForm({
          schema,
          key: 'inject-ssr',
          defaultValues: () => {
            calls += 1
            return Promise.resolve({ email: 'server@example.com', name: 'Ada' })
          },
        })
        return () => h(Child)
      },
    })
    const ssrApp = createSSRApp(App).use(createAttaform({ ssr: true }))
    await renderToString(ssrApp)
    expect(calls).toBe(1)
    const payload = renderAttaformState(ssrApp)
    const entry = payload.forms.find(([k]) => k === 'inject-ssr')
    expect(entry?.[1].form).toMatchObject({ email: 'server@example.com', name: 'Ada' })
  })

  it('descendant without __ssrAccessed does not enqueue — parent stays dormant', async () => {
    let calls = 0
    const Child = defineComponent({
      setup() {
        const form = injectForm<UserShape>({ key: 'inject-no-mark' })
        return () => h('div', form?.key ?? '')
      },
    })
    const App = defineComponent({
      setup() {
        useForm({
          schema,
          key: 'inject-no-mark',
          defaultValues: () => {
            calls += 1
            return Promise.resolve({ email: 'server@example.com', name: 'Ada' })
          },
        })
        return () => h(Child)
      },
    })
    const ssrApp = createSSRApp(App).use(createAttaform({ ssr: true }))
    await renderToString(ssrApp)
    expect(calls).toBe(0)
    const payload = renderAttaformState(ssrApp)
    const entry = payload.forms.find(([k]) => k === 'inject-no-mark')
    expect(entry?.[1].form).toEqual({ email: '', name: '' })
  })

  it('string-form injectForm("key") preserved — no SSR mark, no enqueue', async () => {
    let calls = 0
    const Child = defineComponent({
      setup() {
        const form = injectForm<UserShape>('inject-string-form')
        return () => h('div', form?.key ?? '')
      },
    })
    const App = defineComponent({
      setup() {
        useForm({
          schema,
          key: 'inject-string-form',
          defaultValues: () => {
            calls += 1
            return Promise.resolve({ email: 'server@example.com', name: 'Ada' })
          },
        })
        return () => h(Child)
      },
    })
    const ssrApp = createSSRApp(App).use(createAttaform({ ssr: true }))
    await renderToString(ssrApp)
    expect(calls).toBe(0)
  })

  it('multiple injectForm consumers with __ssrAccessed share one factory run', async () => {
    let calls = 0
    const ChildA = defineComponent({
      setup() {
        const form = injectForm<UserShape>({ key: 'inject-shared', __ssrAccessed: true })
        return () => h('div', form?.values.email ?? '')
      },
    })
    const ChildB = defineComponent({
      setup() {
        const form = injectForm<UserShape>({ key: 'inject-shared', __ssrAccessed: true })
        return () => h('div', form?.values.name ?? '')
      },
    })
    const App = defineComponent({
      setup() {
        useForm({
          schema,
          key: 'inject-shared',
          defaultValues: () => {
            calls += 1
            return Promise.resolve({ email: 'server@example.com', name: 'Ada' })
          },
        })
        return () => h('div', [h(ChildA), h(ChildB)])
      },
    })
    const ssrApp = createSSRApp(App).use(createAttaform({ ssr: true }))
    await renderToString(ssrApp)
    expect(calls).toBe(1)
  })
})

describe('injectForm signature — type-level union', () => {
  it('accepts FormKey string shortcut as before', () => {
    expect(typeof injectForm).toBe('function')
    // The string-form preserves shape — no runtime assertion possible
    // outside a setup scope without mounting, but type-only callers
    // remain valid: `injectForm<F>('key')`. This case is exercised by
    // the runtime tests above.
  })

  it('accepts options object form', () => {
    expect(typeof injectForm).toBe('function')
    // Same — runtime exercised above.
  })
})

const _typeProbe = (): void => {
  // Compile-only assertions. Both shapes resolve.
  void (() => injectForm<UserShape>())
  void (() => injectForm<UserShape>('key'))
  void (() => injectForm<UserShape>({ key: 'key' }))
  void (() => injectForm<UserShape>({ key: 'key', __ssrAccessed: true }))
  void (() => injectForm<UserShape>({ __ssrAccessed: true }))
}
void _typeProbe
