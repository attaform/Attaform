// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderToString } from '@vue/server-renderer'
import { createSSRApp, defineComponent, h } from 'vue'
import { z } from 'zod'
import { useForm, useWizard } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import { renderAttaformState } from '../../src/runtime/core/serialize'
import {
  kAttaformWizardActiveStepResolver,
  type WizardActiveStepResolver,
} from '../../src/runtime/core/registry'

/**
 * Wizard SSR prefetch — the v2 contract.
 *
 * On the server, the wizard enqueues the initial step's form for
 * prefetch (so its async `defaultValues` resolves inside
 * `onServerPrefetch`) and explicitly skips every other compiled step.
 * `skipPrefetch` wins over `enqueuePrefetch` inside
 * `shouldPrefetch`, so a stray `form.activate()` on a non-initial
 * step cannot bypass the wizard's intent.
 *
 * Eager-activate-all is a CLIENT contract; SSR keeps the
 * initial-only floor. A 40-step wizard saves 39 fetches per server
 * render.
 */

const accountSchema = z.object({ ssn: z.string(), email: z.string() })
const profileSchema = z.object({ idNumber: z.string(), name: z.string() })
const reviewSchema = z.object({ household: z.string(), ack: z.string() })

describe('wizard SSR prefetch', () => {
  it('only the initial step factory fires on the server', async () => {
    let accountCalls = 0
    let profileCalls = 0
    let reviewCalls = 0
    const App = defineComponent({
      setup() {
        const account = useForm({
          schema: accountSchema,
          key: 'wizard-ssr-account',
          defaultValues: () => {
            accountCalls += 1
            return Promise.resolve({ ssn: '000-00-0000', email: 'a@example.com' })
          },
        })
        const profile = useForm({
          schema: profileSchema,
          key: 'wizard-ssr-profile',
          defaultValues: () => {
            profileCalls += 1
            return Promise.resolve({ idNumber: 'P-123', name: 'Ada' })
          },
        })
        const review = useForm({
          schema: reviewSchema,
          key: 'wizard-ssr-review',
          defaultValues: () => {
            reviewCalls += 1
            return Promise.resolve({ household: '4', ack: 'yes' })
          },
        })
        useWizard({ steps: [account, profile, review] })
        return () => h('div')
      },
    })
    const ssrApp = createSSRApp(App).use(createAttaform({ ssr: true }))
    await renderToString(ssrApp)
    expect(accountCalls).toBe(1)
    expect(profileCalls).toBe(0)
    expect(reviewCalls).toBe(0)

    // Only the initial step's resolved values ride the payload; the
    // non-initial steps surface their schema defaults (empty strings).
    const payload = renderAttaformState(ssrApp)
    const accountEntry = payload.forms.find(([k]) => k === 'wizard-ssr-account')
    const profileEntry = payload.forms.find(([k]) => k === 'wizard-ssr-profile')
    const reviewEntry = payload.forms.find(([k]) => k === 'wizard-ssr-review')
    expect(accountEntry?.[1].form).toMatchObject({ ssn: '000-00-0000', email: 'a@example.com' })
    expect(profileEntry?.[1].form).toEqual({ idNumber: '', name: '' })
    expect(reviewEntry?.[1].form).toEqual({ household: '', ack: '' })
  })

  it('wizard skipPrefetch overrides an explicit form.activate() on a non-initial step', async () => {
    let leakedCalls = 0
    const App = defineComponent({
      setup() {
        const a = useForm({
          schema: accountSchema,
          key: 'wizard-skip-a',
          defaultValues: () => Promise.resolve({ ssn: '', email: '' }),
        })
        const b = useForm({
          schema: profileSchema,
          key: 'wizard-skip-b',
          defaultValues: () => {
            leakedCalls += 1
            return Promise.resolve({ idNumber: 'LEAKED', name: 'LEAKED' })
          },
        })
        useWizard({ steps: [a, b] })
        // Stray activate() on the non-initial step. Must be a no-op
        // on the server thanks to the wizard's skipPrefetch.
        void (b as unknown as { activate?: () => Promise<void> }).activate?.()
        return () => h('div')
      },
    })
    const ssrApp = createSSRApp(App).use(createAttaform({ ssr: true }))
    await renderToString(ssrApp)
    expect(leakedCalls).toBe(0)
  })

  it('restore lambda — the chosen step is the one whose factory fires', async () => {
    let aCalls = 0
    let bCalls = 0
    const App = defineComponent({
      setup() {
        const a = useForm({
          schema: accountSchema,
          key: 'wizard-restore-a',
          defaultValues: () => {
            aCalls += 1
            return Promise.resolve({ ssn: 'A', email: 'A' })
          },
        })
        const b = useForm({
          schema: profileSchema,
          key: 'wizard-restore-b',
          defaultValues: () => {
            bCalls += 1
            return Promise.resolve({ idNumber: 'B', name: 'B' })
          },
        })
        useWizard({
          steps: [a, b],
          restore: () => ({ step: 'wizard-restore-b' }),
        })
        return () => h('div')
      },
    })
    const ssrApp = createSSRApp(App).use(createAttaform({ ssr: true }))
    await renderToString(ssrApp)
    expect(aCalls).toBe(0)
    expect(bCalls).toBe(1)
  })

  it('injected resolver — the resolver-chosen step prefetches on the server', async () => {
    let aCalls = 0
    let bCalls = 0
    const resolver: WizardActiveStepResolver = (param) =>
      param === 'step' ? 'wizard-inj-b' : undefined
    const App = defineComponent({
      setup() {
        const a = useForm({
          schema: accountSchema,
          key: 'wizard-inj-a',
          defaultValues: () => {
            aCalls += 1
            return Promise.resolve({ ssn: 'A', email: 'A' })
          },
        })
        const b = useForm({
          schema: profileSchema,
          key: 'wizard-inj-b',
          defaultValues: () => {
            bCalls += 1
            return Promise.resolve({ idNumber: 'B', name: 'B' })
          },
        })
        useWizard({ steps: [a, b] })
        return () => h('div')
      },
    })
    const ssrApp = createSSRApp(App).use(createAttaform({ ssr: true }))
    ssrApp.provide(kAttaformWizardActiveStepResolver, resolver)
    await renderToString(ssrApp)
    expect(aCalls).toBe(0)
    expect(bCalls).toBe(1)
  })
})
