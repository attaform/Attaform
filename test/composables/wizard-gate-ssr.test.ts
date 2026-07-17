// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderToString } from '@vue/server-renderer'
import { createSSRApp, defineComponent, h } from 'vue'
import { z } from 'zod'
import { useForm, useWizard, gate } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import {
  kAttaformWizardActiveStepResolver,
  type WizardActiveStepResolver,
} from '../../src/runtime/core/registry'

/**
 * `gate()` enforcement on the server.
 *
 * The landing funnel (`commitActiveKey` → `resolveLandingKey`) is the
 * same code the client uses, so a server-side deep link past an uncleared
 * gate must redirect to the gate before the first byte ships, so the
 * freeze can't be a client-only afterthought. A gate seeded cleared via a
 * sync/plain `defaultStatuses`, by contrast, latches cleared synchronously
 * at construction, so its SSR render lands on the deep-linked downstream
 * step. (The async factory form seeds only after hydration, so first-byte
 * SSR seeding requires the sync/plain form.)
 */

const consentSchema = z.object({ accepted: z.literal(true) })
const shippingSchema = z.object({ addr: z.string() })
const paymentSchema = z.object({ card: z.string() })

function deepLink(step: string): WizardActiveStepResolver {
  return (param) => (param === 'step' ? step : undefined)
}

describe('gate() SSR enforcement', () => {
  it('redirects a server deep link past an uncleared gate to the gate', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle: any = {}
    const App = defineComponent({
      setup() {
        const consent = useForm({
          schema: consentSchema,
          key: 'ssr-consent',
          defaultValues: { accepted: false },
        })
        const shipping = useForm({
          schema: shippingSchema,
          key: 'ssr-shipping',
          defaultValues: { addr: 'a' },
        })
        const payment = useForm({
          schema: paymentSchema,
          key: 'ssr-payment',
          defaultValues: { card: 'c' },
        })
        handle.wizard = useWizard({ steps: [gate(consent), shipping, payment] })
        return () => h('div', handle.wizard.currentStep)
      },
    })
    const ssrApp = createSSRApp(App).use(createAttaform({ ssr: true }))
    ssrApp.provide(kAttaformWizardActiveStepResolver, deepLink('ssr-payment'))
    const html = await renderToString(ssrApp)

    // The deep link aimed at payment; the uncleared gate holds it at consent.
    expect(handle.wizard.currentStep).toBe('ssr-consent')
    expect(handle.wizard.statuses['ssr-payment'].locked).toBe(true)
    expect(html).toContain('ssr-consent')

    // The gate role serializes on the server, so a consumer can persist it:
    // the consent reads 'uncleared', the plain payment step reads null.
    expect(handle.wizard.statuses['ssr-consent'].gate).toBe('uncleared')
    expect(handle.wizard.statuses['ssr-payment'].gate).toBe(null)
  })

  it('lets a defaultStatuses-seeded gate honor a server deep link into a downstream step', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle: any = {}
    const App = defineComponent({
      setup() {
        // The member form's values are deliberately INVALID for the schema
        // (`accepted: false` vs `z.literal(true)`): the seed clears the gate
        // independent of value validity, which is the whole point of the
        // decoupled seed channel.
        const consent = useForm({
          schema: consentSchema,
          key: 'ssr2-consent',
          defaultValues: { accepted: false },
        })
        const shipping = useForm({
          schema: shippingSchema,
          key: 'ssr2-shipping',
          defaultValues: { addr: 'a' },
        })
        const payment = useForm({
          schema: paymentSchema,
          key: 'ssr2-payment',
          defaultValues: { card: 'c' },
        })
        handle.wizard = useWizard({
          steps: [gate(consent), shipping, payment],
          defaultStatuses: { 'ssr2-consent': { gate: 'cleared' } },
        })
        return () => h('div', handle.wizard.currentStep)
      },
    })
    const ssrApp = createSSRApp(App).use(createAttaform({ ssr: true }))
    ssrApp.provide(kAttaformWizardActiveStepResolver, deepLink('ssr2-payment'))
    await renderToString(ssrApp)

    // Server-truth seed → gate latched cleared at construction → the deep
    // link into a downstream step is honored on the first byte.
    expect(handle.wizard.currentStep).toBe('ssr2-payment')
    expect(handle.wizard.statuses['ssr2-payment'].locked).toBe(false)
    // The seeded gate reads 'cleared' in the very first server render.
    expect(handle.wizard.statuses['ssr2-consent'].gate).toBe('cleared')
  })
})
