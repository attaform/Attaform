// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderToString } from '@vue/server-renderer'
import { createSSRApp, defineComponent, h } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import { renderAttaformState } from '../../src/runtime/core/serialize'
import type { UseFormReturnType } from '../../src/runtime/types/types-api'

/**
 * SSR prefetch queue contract — Phase 2.
 *
 * The lazy-by-default form means an async `defaultValues` factory does
 * NOT fire on the server unless something explicitly enqueues the form
 * for SSR prefetch. The positive triggers (Phase 2):
 *   - `form.activate()` called explicitly in setup; OR
 *   - a wizard auto-marks the current step (covered by wizard tests).
 *
 * Without any positive trigger, the form renders the schema's slim
 * defaults — the factory stays dormant and the server pays for no
 * extra fetches. That is the activation rule that drives render
 * efficiency.
 *
 * Tests use bare-vue SSR (`createSSRApp` + `renderToString`) so we
 * can observe the prefetch flow without Nuxt or `<Suspense>` wrappers.
 */

const schema = z.object({ email: z.string(), name: z.string() })

describe('SSR prefetch queue', () => {
  it('factory stays dormant on the server when no consumer enqueues it', async () => {
    let calls = 0
    const App = defineComponent({
      setup() {
        useForm({
          schema,
          key: 'ssr-dormant',
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
    expect(calls).toBe(0)
    // The serialised payload should carry the schema's slim defaults
    // (empty strings), proving the factory never ran.
    const payload = renderAttaformState(ssrApp)
    const entry = payload.forms[0]
    expect(entry).toBeDefined()
    if (entry === undefined) return
    expect(entry[1].form).toEqual({ email: '', name: '' })
  })

  it('form.activate() in setup enqueues the form and the factory fires once during onServerPrefetch', async () => {
    let calls = 0
    const App = defineComponent({
      setup() {
        const form = useForm({
          schema,
          key: 'ssr-activate',
          defaultValues: () => {
            calls += 1
            return Promise.resolve({ email: 'server@example.com', name: 'Ada' })
          },
        }) as unknown as UseFormReturnType<{ email: string; name: string }>
        void form.activate()
        return () => h('div')
      },
    })
    const ssrApp = createSSRApp(App).use(createAttaform({ ssr: true }))
    await renderToString(ssrApp)
    expect(calls).toBe(1)
    const payload = renderAttaformState(ssrApp)
    const entry = payload.forms[0]
    if (entry === undefined) return
    expect(entry[1].form).toMatchObject({ email: 'server@example.com', name: 'Ada' })
  })

  it('concurrent form.activate() calls from multiple consumers share one factory run', async () => {
    let calls = 0
    const Sibling = defineComponent({
      setup() {
        const form = useForm({
          schema,
          key: 'ssr-shared-activation',
          defaultValues: () => {
            calls += 1
            return Promise.resolve({ email: 'server@example.com', name: 'Ada' })
          },
        }) as unknown as UseFormReturnType<{ email: string; name: string }>
        void form.activate()
        return () => h('div', 'sibling')
      },
    })
    const App = defineComponent({
      setup() {
        const form = useForm({
          schema,
          key: 'ssr-shared-activation',
          defaultValues: () => {
            calls += 1
            return Promise.resolve({ email: 'server@example.com', name: 'Ada' })
          },
        }) as unknown as UseFormReturnType<{ email: string; name: string }>
        void form.activate()
        return () => h('div', [h(Sibling)])
      },
    })
    const ssrApp = createSSRApp(App).use(createAttaform({ ssr: true }))
    await renderToString(ssrApp)
    // Same store, one captured factory → only one invocation regardless
    // of how many setups requested activation.
    expect(calls).toBe(1)
  })

  it('useForm({ __ssrAccessed: true }) enqueues the form so its async factory fires on the server', async () => {
    let calls = 0
    const App = defineComponent({
      setup() {
        useForm({
          schema,
          key: 'ssr-accessed-mark',
          __ssrAccessed: true,
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
    const entry = payload.forms.find(([k]) => k === 'ssr-accessed-mark')
    expect(entry?.[1].form).toMatchObject({ email: 'server@example.com', name: 'Ada' })
  })

  it('useForm({ __ssrAccessed: false }) leaves the form dormant on the server', async () => {
    let calls = 0
    const App = defineComponent({
      setup() {
        useForm({
          schema,
          key: 'ssr-accessed-false',
          __ssrAccessed: false,
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
    expect(calls).toBe(0)
  })

  it('non-enqueued sibling forms render schema defaults while an enqueued form fetches', async () => {
    let activatedCalls = 0
    let dormantCalls = 0
    const App = defineComponent({
      setup() {
        const a = useForm({
          schema,
          key: 'ssr-mixed-active',
          defaultValues: () => {
            activatedCalls += 1
            return Promise.resolve({ email: 'active@example.com', name: 'Active' })
          },
        }) as unknown as UseFormReturnType<{ email: string; name: string }>
        useForm({
          schema,
          key: 'ssr-mixed-dormant',
          defaultValues: () => {
            dormantCalls += 1
            return Promise.resolve({ email: 'dormant@example.com', name: 'Dormant' })
          },
        })
        void a.activate()
        return () => h('div')
      },
    })
    const ssrApp = createSSRApp(App).use(createAttaform({ ssr: true }))
    await renderToString(ssrApp)
    expect(activatedCalls).toBe(1)
    expect(dormantCalls).toBe(0)
    const payload = renderAttaformState(ssrApp)
    const active = payload.forms.find(([k]) => k === 'ssr-mixed-active')
    const dormant = payload.forms.find(([k]) => k === 'ssr-mixed-dormant')
    expect(active?.[1].form).toMatchObject({ email: 'active@example.com', name: 'Active' })
    expect(dormant?.[1].form).toEqual({ email: '', name: '' })
  })
})
