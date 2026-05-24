// @vitest-environment jsdom
import { renderToString } from '@vue/server-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, createSSRApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { defer } from '../../src/runtime/core/wizard-defer'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Stress-scenario coverage for the v2 wizard. Each describe block
 * targets a specific composition probe from the plan's S5-S31
 * register — function-slot branching, deferred slot deep-links,
 * ghost forms, SSR mixed-slot hydration, special-character step
 * keys, and the no-router fallback path. Each scenario exercises
 * an interaction that the focused per-feature files don't catch
 * on their own.
 */

const accountSchema = z.object({
  type: z.enum(['individual', 'organization']),
})

const personSchema = z.object({
  fullName: z.string().min(1, 'Name required'),
})

const orgSchema = z.object({
  orgName: z.string().min(1, 'Org name required'),
})

const reviewSchema = z.object({ tos: z.literal(true) })

function mountHarness<R>(setup: () => R): { app: App; result: R } {
  const handle: { result?: R } = {}
  const App = defineComponent({
    setup() {
      handle.result = setup()
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.config.warnHandler = () => {}
  app.config.errorHandler = () => {}
  app.mount(document.createElement('div'))
  return { app, result: handle.result as R }
}

describe('S2 — branching via function slot, live-values steer', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('a function slot reading ctx.forms.<key>.values re-resolves when the value mutates', async () => {
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 's2-account',
        defaultValues: { type: 'individual' as const },
      })
      const person = useForm({
        schema: personSchema,
        key: 's2-person',
        defaultValues: { fullName: 'Ada' },
      })
      const org = useForm({
        schema: orgSchema,
        key: 's2-org',
        defaultValues: { orgName: 'Acme' },
      })
      const review = useForm({
        schema: reviewSchema,
        key: 's2-review',
        defaultValues: { tos: true as const },
      })
      const wizard = useWizard({
        steps: [
          account,
          (ctx) =>
            (ctx.forms['s2-account']?.values as { type?: string } | undefined)?.type ===
            'organization'
              ? org
              : person,
          review,
        ],
        restore: false,
        persist: false,
      })
      return { wizard, account, person, org }
    })
    apps.push(app)
    // Default: individual → person.
    expect(result.wizard.steps.map((s) => s.key)).toEqual(['s2-account', 's2-person', 's2-review'])
    // Flip the steering value → slot resolves to org.
    result.account.setValue('type', 'organization')
    await nextTick()
    expect(result.wizard.steps.map((s) => s.key)).toEqual(['s2-account', 's2-org', 's2-review'])
    // Flip back.
    result.account.setValue('type', 'individual')
    await nextTick()
    expect(result.wizard.steps.map((s) => s.key)).toEqual(['s2-account', 's2-person', 's2-review'])
  })

  it('navigates through the picked subgraph and submits with namespaced values', async () => {
    const onSubmit = vi.fn()
    const { app, result } = mountHarness(() => {
      const account = useForm({
        schema: accountSchema,
        key: 's2b-account',
        defaultValues: { type: 'organization' as const },
      })
      const person = useForm({
        schema: personSchema,
        key: 's2b-person',
        defaultValues: { fullName: '' },
      })
      const org = useForm({
        schema: orgSchema,
        key: 's2b-org',
        defaultValues: { orgName: 'Acme' },
      })
      const review = useForm({
        schema: reviewSchema,
        key: 's2b-review',
        defaultValues: { tos: true as const },
      })
      return useWizard({
        steps: [
          account,
          (ctx) =>
            (ctx.forms['s2b-account']?.values as { type?: string } | undefined)?.type ===
            'organization'
              ? org
              : person,
          review,
        ],
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    result.goTo('s2b-review')
    await result.handleSubmit(onSubmit)()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const ctx = onSubmit.mock.calls[0]?.[0] as {
      values: Record<string, unknown>
      isFinal: boolean
    }
    expect(Object.keys(ctx.values).sort()).toEqual(['s2b-account', 's2b-org', 's2b-review'])
    expect(ctx.values['s2b-org']).toEqual({ orgName: 'Acme' })
  })
})

describe('S4 — mixed wizard with review surfaces', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('positional review surfaces slice wizard.steps up to the active index', () => {
    const { app, result } = mountHarness(() => {
      const shipping = useForm({
        schema: z.object({ city: z.string() }),
        key: 's4-shipping',
        defaultValues: { city: 'Lusaka' },
      })
      const contact = useForm({
        schema: z.object({ email: z.string() }),
        key: 's4-contact',
        defaultValues: { email: 'a@b.c' },
      })
      const payment = useForm({
        schema: z.object({ card: z.string() }),
        key: 's4-payment',
        defaultValues: { card: '4242' },
      })
      return useWizard({
        steps: [shipping, contact, 's4-shipping-review', payment, 's4-final-review'],
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    result.goTo('s4-shipping-review')
    const visibleBeforeReview = result.steps.slice(0, result.activeIndex)
    expect(visibleBeforeReview.map((s) => s.key)).toEqual(['s4-shipping', 's4-contact'])
    expect(Object.keys(result.allValues).sort()).toEqual(
      ['s4-contact', 's4-final-review', 's4-payment', 's4-shipping', 's4-shipping-review'].sort()
    )
    const shippingValues = result.allValues['s4-shipping'] as { city: string }
    expect(shippingValues.city).toBe('Lusaka')
    const contactValues = result.allValues['s4-contact'] as { email: string }
    expect(contactValues.email).toBe('a@b.c')
  })
})

describe('S6 — deep-link restore to a deferred slot resolves on navigation-land', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('a deferred slot resolves at construction (lazy-sticky) and the deep-link lands on it', () => {
    let resolverCalls = 0
    const { app, result } = mountHarness(() => {
      const intro = useForm({
        schema: z.object({}),
        key: 's6-intro',
      })
      const fetched = useForm({
        schema: z.object({ x: z.string() }),
        key: 's6-fetched',
        defaultValues: { x: 'hello' },
      })
      const final = useForm({
        schema: z.object({ ack: z.boolean() }),
        key: 's6-final',
        defaultValues: { ack: false },
      })
      return useWizard({
        steps: [
          intro,
          defer(() => {
            resolverCalls += 1
            return fetched
          }),
          final,
        ],
        restore: () => ({ step: 's6-fetched' }),
        persist: false,
      })
    })
    apps.push(app)
    // The deferred slot resolved on the first compile pass so the
    // deep-link to its key succeeded.
    expect(result.currentStep).toBe('s6-fetched')
    expect(resolverCalls).toBe(1)
  })
})

describe('S10 — function slot returns undefined drops the slot', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('a slot returning undefined disappears from the compiled list', async () => {
    const showSecond = ref(false)
    const { app, result } = mountHarness(() => {
      const first = useForm({ schema: z.object({}), key: 's10-first' })
      const conditional = useForm({ schema: z.object({}), key: 's10-conditional' })
      const last = useForm({ schema: z.object({}), key: 's10-last' })
      return useWizard({
        steps: [first, () => (showSecond.value ? conditional : undefined), last],
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    expect(result.steps.map((s) => s.key)).toEqual(['s10-first', 's10-last'])
    showSecond.value = true
    await nextTick()
    expect(result.steps.map((s) => s.key)).toEqual(['s10-first', 's10-conditional', 's10-last'])
  })
})

describe('S11 — function slot returns a ghost form (not statically listed)', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('a ghost form surfaces in wizard.forms once the slot resolves to it', async () => {
    const useGhost = ref(false)
    const { app, result } = mountHarness(() => {
      const entry = useForm({ schema: z.object({}), key: 's11-entry' })
      const ghost = useForm({
        schema: z.object({ note: z.string() }),
        key: 's11-ghost',
        defaultValues: { note: 'hi' },
      })
      const final = useForm({ schema: z.object({}), key: 's11-final' })
      return useWizard({
        steps: [entry, () => (useGhost.value ? ghost : undefined), final],
        restore: false,
        persist: false,
      })
    })
    apps.push(app)
    expect(result.forms['s11-ghost']).toBeUndefined()
    useGhost.value = true
    await nextTick()
    expect(result.forms['s11-ghost']).toBeDefined()
    expect(result.forms['s11-ghost']?.key).toBe('s11-ghost')
    const ghostValues = result.allValues['s11-ghost'] as { note: string }
    expect(ghostValues.note).toBe('hi')
  })
})

describe('S14 — SSR mixed-slot wizard hydrates without mismatch', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('renders an intro / form / thanks sequence cleanly on both server and client', async () => {
    const WizardSfc = defineComponent({
      setup() {
        const contact = useForm({
          schema: z.object({ email: z.string() }),
          key: 's14-contact',
          defaultValues: { email: 'a@b.c' },
        })
        const wizard = useWizard({
          steps: ['s14-intro', contact, 's14-thanks'],
          restore: false,
          persist: false,
        })
        return () => h('div', { class: `step-${wizard.currentStep}` }, `at:${wizard.currentStep}`)
      },
    })

    const ssrApp = createSSRApp(WizardSfc).use(createAttaform({ ssr: true }))
    const html = await renderToString(ssrApp)
    expect(html).toContain('step-s14-intro')
    expect(html).toContain('at:s14-intro')

    const host = document.createElement('div')
    host.innerHTML = html
    document.body.appendChild(host)
    const warnings: string[] = []
    const clientApp = createSSRApp(WizardSfc).use(createAttaform({ ssr: false }))
    clientApp.config.warnHandler = (msg) => {
      warnings.push(msg)
    }
    clientApp.mount(host)
    apps.push(clientApp)

    const hydrationWarnings = warnings.filter((m) => /hydration|mismatch/i.test(m))
    expect(hydrationWarnings).toEqual([])
  })
})

describe('S22 — no injected resolver + no router-style restore still works', () => {
  const apps: App[] = []
  beforeEach(() => {
    window.history.replaceState(null, '', 'http://localhost:3000/wizard')
  })
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    window.history.replaceState(null, '', 'http://localhost:3000/wizard')
  })

  it('a wizard mounted with no resolver and restore/persist disabled works against in-memory state', async () => {
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: z.object({}), key: 's22-a' })
      const b = useForm({ schema: z.object({}), key: 's22-b' })
      return useWizard({ steps: [a, b], restore: false, persist: false })
    })
    apps.push(app)
    expect(result.currentStep).toBe('s22-a')
    await result.next()
    expect(result.currentStep).toBe('s22-b')
    // URL is untouched — restore/persist were disabled.
    expect(new URL(window.location.href).searchParams.get('step')).toBeNull()
  })
})

describe('S26 — step keys with special characters round-trip through ?step=', () => {
  const apps: App[] = []
  beforeEach(() => {
    window.history.replaceState(null, '', 'http://localhost:3000/wizard')
  })
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    window.history.replaceState(null, '', 'http://localhost:3000/wizard')
  })

  it('encodes a key with slashes + spaces on persist and decodes on restore', async () => {
    const specialKey = 'step with spaces/and-slash'
    window.history.replaceState(
      null,
      '',
      `http://localhost:3000/wizard?step=${encodeURIComponent(specialKey)}`
    )
    const { app, result } = mountHarness(() => {
      const a = useForm({ schema: z.object({}), key: 's26-a' })
      const b = useForm({ schema: z.object({}), key: specialKey })
      return useWizard({ steps: [a, b] })
    })
    apps.push(app)
    expect(result.currentStep).toBe(specialKey)
    result.goTo('s26-a')
    await nextTick()
    expect(new URL(window.location.href).searchParams.get('step')).toBe('s26-a')
    result.goTo(specialKey)
    await nextTick()
    expect(new URL(window.location.href).searchParams.get('step')).toBe(specialKey)
  })
})
