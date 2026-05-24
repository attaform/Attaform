// @vitest-environment jsdom
import { renderToString } from '@vue/server-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, createSSRApp, defineComponent, h, nextTick, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'
import {
  kAttaformWizardActiveStepResolver,
  type WizardActiveStepResolver,
} from '../../src/runtime/core/registry'

/**
 * Deep-link hydration safety. Without a coordinated source of truth
 * for the active step, a wizard that deep-links to a non-entry step
 * would render the first step on the server (no `window.location`)
 * and the URL-named step on the client, cascading every node inside
 * the wizard into a hydration mismatch.
 *
 * v2 closes the gap two ways:
 *
 *  - The `attaform/nuxt` runtime plugin provides a
 *    `kAttaformWizardActiveStepResolver` that reads the active step
 *    from `useRoute()`. The wizard's default `restore` consumes the
 *    inject at construction, so server and client compute the same
 *    initial step and the deep-link renders correctly with zero flicker.
 *
 *  - A consumer wiring their own `restore` lambda owns SSR coordination
 *    explicitly: returning the same step on both sides keeps hydration
 *    quiet; returning a client-only value accepts the mismatch.
 *
 * Garbage step keys (URL pointing at a step that has since been
 * removed) dev-warn and fall back to the first compiled step in
 * either path, matching the locked plan decision.
 */

const schemaA = z.object({ a: z.string() })
const schemaB = z.object({ b: z.string() })
const schemaC = z.object({ c: z.string() })

const ORIGINAL_URL = 'http://localhost:3000/wizard'

function mountWithResolver<R>(
  setup: () => R,
  resolver: WizardActiveStepResolver | null
): { app: App; result: R } {
  const handle: { result?: R } = {}
  const App = defineComponent({
    setup() {
      handle.result = setup()
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  if (resolver !== null) {
    app.provide(kAttaformWizardActiveStepResolver, resolver)
  }
  app.config.warnHandler = () => {}
  app.config.errorHandler = () => {}
  app.mount(document.createElement('div'))
  return { app, result: handle.result as R }
}

describe('useWizard — injected active-step resolver (Nuxt path)', () => {
  const apps: App[] = []
  beforeEach(() => {
    window.history.replaceState(null, '', ORIGINAL_URL)
  })
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('seeds initial currentStep from the resolver before the URL is consulted', () => {
    const { app, result } = mountWithResolver(
      () => {
        const a = useForm({ schema: schemaA, key: 'inj-1-a' })
        const b = useForm({ schema: schemaB, key: 'inj-1-b' })
        const c = useForm({ schema: schemaC, key: 'inj-1-c' })
        return useWizard({ steps: [a, b, c] })
      },
      (param) => (param === 'step' ? 'inj-1-b' : undefined)
    )
    apps.push(app)
    expect(result.currentStep).toBe('inj-1-b')
  })

  it('an unknown key from the resolver dev-warns and falls through to the first step', () => {
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    const { app, result } = mountWithResolver(
      () => {
        const a = useForm({ schema: schemaA, key: 'inj-2-a' })
        const b = useForm({ schema: schemaB, key: 'inj-2-b' })
        return useWizard({ steps: [a, b] })
      },
      () => 'inj-2-zzz'
    )
    apps.push(app)
    warnSpy.mockRestore()
    expect(result.currentStep).toBe('inj-2-a')
    expect(warnings.some((w) => w.includes('inj-2-zzz'))).toBe(true)
  })

  it('undefined from the resolver falls through to the URL, then to the first step', () => {
    const { app, result } = mountWithResolver(
      () => {
        const a = useForm({ schema: schemaA, key: 'inj-3-a' })
        const b = useForm({ schema: schemaB, key: 'inj-3-b' })
        return useWizard({ steps: [a, b] })
      },
      () => undefined
    )
    apps.push(app)
    expect(result.currentStep).toBe('inj-3-a')
  })

  it('an explicit restore lambda overrides the injected resolver', () => {
    const { app, result } = mountWithResolver(
      () => {
        const a = useForm({ schema: schemaA, key: 'inj-4-a' })
        const b = useForm({ schema: schemaB, key: 'inj-4-b' })
        const c = useForm({ schema: schemaC, key: 'inj-4-c' })
        return useWizard({
          steps: [a, b, c],
          restore: () => ({ step: 'inj-4-c' }),
        })
      },
      () => 'inj-4-b'
    )
    apps.push(app)
    expect(result.currentStep).toBe('inj-4-c')
  })
})

describe('useWizard — explicit restore lambda', () => {
  const apps: App[] = []
  beforeEach(() => {
    window.history.replaceState(null, '', ORIGINAL_URL)
  })
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    window.history.replaceState(null, '', ORIGINAL_URL)
  })

  it('reads `?step=<key>` from the URL via the default restore when no lambda is supplied', () => {
    window.history.replaceState(null, '', `${ORIGINAL_URL}?step=exp-1-b`)
    const { app, result } = mountWithResolver(() => {
      const a = useForm({ schema: schemaA, key: 'exp-1-a' })
      const b = useForm({ schema: schemaB, key: 'exp-1-b' })
      const c = useForm({ schema: schemaC, key: 'exp-1-c' })
      return useWizard({ steps: [a, b, c] })
    }, null)
    apps.push(app)
    expect(result.currentStep).toBe('exp-1-b')
  })

  it('seeds visited with only the restored step (no phantom entry visit)', () => {
    window.history.replaceState(null, '', `${ORIGINAL_URL}?step=exp-2-b`)
    const { app, result } = mountWithResolver(() => {
      const a = useForm({ schema: schemaA, key: 'exp-2-a' })
      const b = useForm({ schema: schemaB, key: 'exp-2-b' })
      const c = useForm({ schema: schemaC, key: 'exp-2-c' })
      return useWizard({ steps: [a, b, c] })
    }, null)
    apps.push(app)
    expect(result.visited).toEqual(['exp-2-b'])
  })

  it('preserves the deep-link URL through setup without re-writing it', () => {
    window.history.replaceState(null, '', `${ORIGINAL_URL}?step=exp-3-b`)
    const { app } = mountWithResolver(() => {
      const a = useForm({ schema: schemaA, key: 'exp-3-a' })
      const b = useForm({ schema: schemaB, key: 'exp-3-b' })
      const c = useForm({ schema: schemaC, key: 'exp-3-c' })
      return useWizard({ steps: [a, b, c] })
    }, null)
    apps.push(app)
    expect(new URL(window.location.href).searchParams.get('step')).toBe('exp-3-b')
  })

  it('falls back to the first step when the URL names an unknown key', () => {
    window.history.replaceState(null, '', `${ORIGINAL_URL}?step=exp-4-nope`)
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
    const { app, result } = mountWithResolver(() => {
      const a = useForm({ schema: schemaA, key: 'exp-4-a' })
      const b = useForm({ schema: schemaB, key: 'exp-4-b' })
      return useWizard({ steps: [a, b] })
    }, null)
    apps.push(app)
    warnSpy.mockRestore()
    expect(result.currentStep).toBe('exp-4-a')
    expect(result.visited).toEqual(['exp-4-a'])
    expect(warnings.some((w) => w.includes('exp-4-nope'))).toBe(true)
  })
})

describe('useWizard — SSR-to-client hydration through the resolver', () => {
  const apps: App[] = []
  beforeEach(() => {
    window.history.replaceState(null, '', ORIGINAL_URL)
  })
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    window.history.replaceState(null, '', ORIGINAL_URL)
  })

  it('hydrates an SSR-rendered deep-link with no mismatch warnings when the resolver is provided', async () => {
    const targetStep = 'hyd-b'
    const resolver: WizardActiveStepResolver = (param) =>
      param === 'step' ? targetStep : undefined

    const WizardSfc = defineComponent({
      setup() {
        const a = useForm({ schema: schemaA, key: 'hyd-a' })
        const b = useForm({ schema: schemaB, key: 'hyd-b' })
        const wizard = useWizard({ steps: [a, b] })
        return () =>
          h(
            'div',
            { class: wizard.currentStep === 'hyd-a' ? 'on-a' : 'on-b' },
            `step:${wizard.currentStep}`
          )
      },
    })

    // Server-side render with the resolver wired — picks 'hyd-b'.
    const ssrApp = createSSRApp(WizardSfc).use(createAttaform({ ssr: true }))
    ssrApp.provide(kAttaformWizardActiveStepResolver, resolver)
    const ssrHtml = await renderToString(ssrApp)
    expect(ssrHtml).toContain('on-b')
    expect(ssrHtml).toContain('step:hyd-b')

    // Stage the SSR HTML; point the URL at the same deep-link key.
    const host = document.createElement('div')
    host.innerHTML = ssrHtml
    document.body.appendChild(host)
    window.history.replaceState(null, '', `${ORIGINAL_URL}?step=${targetStep}`)

    const warnings: string[] = []
    const clientApp = createSSRApp(WizardSfc).use(createAttaform({ ssr: false }))
    clientApp.provide(kAttaformWizardActiveStepResolver, resolver)
    clientApp.config.warnHandler = (msg) => {
      warnings.push(msg)
    }
    clientApp.mount(host)
    apps.push(clientApp)

    const hydrationWarnings = warnings.filter((msg) => /hydration|mismatch/i.test(msg))
    expect(hydrationWarnings).toEqual([])

    await nextTick()
    expect(host.querySelector('.on-b')).not.toBeNull()
    expect(host.textContent).toContain('step:hyd-b')
  })
})
