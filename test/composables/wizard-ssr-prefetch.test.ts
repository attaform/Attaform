// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderToString } from '@vue/server-renderer'
import { createSSRApp, defineComponent, h } from 'vue'
import { z } from 'zod'
import { useForm, useWizard } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import { renderAttaformState } from '../../src/runtime/core/serialize'
import type { UseFormReturnType } from '../../src/runtime/types/types-api'

/**
 * Wizard SSR prefetch — Phase 2 contract.
 *
 * The wizard composes existing `useForm` instances into a multistep
 * flow. On the server, the wizard synchronously enqueues the current
 * step (so its factory fires inside `onServerPrefetch`) and explicitly
 * skips every other participating step (so a stray `form.activate()`
 * or a future transform-injected `__ssrAccessed` mark on a non-current
 * step cannot bypass the wizard's intent — `skipPrefetch` wins over
 * `enqueuePrefetch` inside `shouldPrefetch`).
 *
 * Render-efficiency invariant under test: a three-step wizard with
 * an expensive async factory on each step must fetch only the current
 * step on the server, regardless of where the consumer points
 * `activate()` calls. A 40-step wizard saves 39 fetches per request.
 */

const accountSchema = z.object({ ssn: z.string(), email: z.string() })
const profileSchema = z.object({ idNumber: z.string(), name: z.string() })
const reviewSchema = z.object({ household: z.string(), ack: z.string() })

describe('wizard SSR prefetch', () => {
  it('only the current step factory fires on the server', async () => {
    let accountCalls = 0
    let profileCalls = 0
    let reviewCalls = 0
    const App = defineComponent({
      setup() {
        const review = useForm({
          schema: reviewSchema,
          key: 'wizard-ssr-review',
          defaultValues: () => {
            reviewCalls += 1
            return Promise.resolve({ household: '4', ack: 'yes' })
          },
        })
        const profile = useForm({
          schema: profileSchema,
          key: 'wizard-ssr-profile',
          defaultValues: () => {
            profileCalls += 1
            return Promise.resolve({ idNumber: 'P-123', name: 'Ada' })
          },
          next: review,
        })
        const account = useForm({
          schema: accountSchema,
          key: 'wizard-ssr-account',
          defaultValues: () => {
            accountCalls += 1
            return Promise.resolve({ ssn: '000-00-0000', email: 'a@example.com' })
          },
          next: profile,
        })
        useWizard(account)
        return () => h('div')
      },
    })
    const ssrApp = createSSRApp(App).use(createAttaform({ ssr: true }))
    await renderToString(ssrApp)
    expect(accountCalls).toBe(1)
    expect(profileCalls).toBe(0)
    expect(reviewCalls).toBe(0)
    // Only the current step's resolved values ride the payload.
    const payload = renderAttaformState(ssrApp)
    const accountEntry = payload.forms.find(([k]) => k === 'wizard-ssr-account')
    const profileEntry = payload.forms.find(([k]) => k === 'wizard-ssr-profile')
    const reviewEntry = payload.forms.find(([k]) => k === 'wizard-ssr-review')
    expect(accountEntry?.[1].form).toMatchObject({ ssn: '000-00-0000', email: 'a@example.com' })
    expect(profileEntry?.[1].form).toEqual({ idNumber: '', name: '' })
    expect(reviewEntry?.[1].form).toEqual({ household: '', ack: '' })
  })

  it('wizard skipPrefetch overrides an explicit form.activate() on a non-current step', async () => {
    // The wizard's "user is not on this step" signal must defeat any
    // other positive trigger — even a consumer who explicitly calls
    // `activate()` on a non-current step does not cause its factory
    // to fire on the server. This is the render-efficiency floor:
    // the wizard's skip-list overrides every positive mark.
    let leakedCalls = 0
    const App = defineComponent({
      setup() {
        const b = useForm({
          schema: profileSchema,
          key: 'wizard-skip-b',
          defaultValues: () => {
            leakedCalls += 1
            return Promise.resolve({ idNumber: 'LEAKED', name: 'LEAKED' })
          },
        }) as unknown as UseFormReturnType<{ idNumber: string; name: string }>
        const a = useForm({
          schema: accountSchema,
          key: 'wizard-skip-a',
          defaultValues: () => Promise.resolve({ ssn: '', email: '' }),
          next: b,
        })
        useWizard(a)
        // Stray activate() on the non-current step. Should be a no-op
        // on the server thanks to the wizard's skipPrefetch.
        void b.activate()
        return () => h('div')
      },
    })
    const ssrApp = createSSRApp(App).use(createAttaform({ ssr: true }))
    await renderToString(ssrApp)
    expect(leakedCalls).toBe(0)
  })

  it('getServerActiveStep — the chosen step is the one that fires', async () => {
    let aCalls = 0
    let bCalls = 0
    const App = defineComponent({
      setup() {
        const b = useForm({
          schema: profileSchema,
          key: 'wizard-getter-b',
          defaultValues: () => {
            bCalls += 1
            return Promise.resolve({ idNumber: 'B', name: 'B' })
          },
        })
        const a = useForm({
          schema: accountSchema,
          key: 'wizard-getter-a',
          defaultValues: () => {
            aCalls += 1
            return Promise.resolve({ ssn: 'A', email: 'A' })
          },
          next: b,
        })
        useWizard(a, {
          getServerActiveStep: () => 'wizard-getter-b',
        })
        return () => h('div')
      },
    })
    const ssrApp = createSSRApp(App).use(createAttaform({ ssr: true }))
    await renderToString(ssrApp)
    expect(aCalls).toBe(0)
    expect(bCalls).toBe(1)
  })
})
