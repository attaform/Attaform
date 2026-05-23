// @vitest-environment jsdom
import { renderToString } from '@vue/server-renderer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
 * Deep-link hydration safety. Without these guards, a wizard that
 * deep-links to a non-entry step would render `entryForm.key` on the
 * server (no `window.location`) while reading the URL on the client,
 * cascading every node inside the wizard into a hydration mismatch.
 *
 * Two paths close the gap:
 *
 *  - The `attaform/nuxt` runtime plugin provides a
 *    `kAttaformWizardActiveStepResolver` that reads `useRoute()`.
 *    Server and client compute the same initial step, hydration walks
 *    a matching tree, and the deep-link renders correctly with zero
 *    flicker (Path A — auto-bridge).
 *
 *  - For framework-agnostic SSR setups with no resolver, the wizard
 *    initial-renders the entry form on both sides and reconciles to
 *    the URL key in a post-mount `onMounted` hook. Hydration matches,
 *    but the user sees a one-frame entry flash before the restore
 *    takes effect (Path D — post-hydration restore).
 *
 * The standing tests below probe both paths plus the pre-restore
 * preservation of the deep-link URL and the SSR-to-client hydration
 * walk against a real Vue server-renderer pass.
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

describe('useWizard — injected active-step resolver (Path A)', () => {
  const apps: App[] = []
  beforeEach(() => {
    window.history.replaceState(null, '', ORIGINAL_URL)
  })
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('seeds initial current from the resolver when no explicit getter is wired', () => {
    const { app, result } = mountWithResolver(
      () => {
        const c = useForm({ schema: schemaC, key: 'inj-1-c' })
        const b = useForm({ schema: schemaB, key: 'inj-1-b', next: c })
        const a = useForm({ schema: schemaA, key: 'inj-1-a', next: b })
        return useWizard(a)
      },
      (param) => (param === 'step' ? 'inj-1-b' : undefined)
    )
    apps.push(app)
    expect(result.current).toBe('inj-1-b')
  })

  it('passes the configured history.param to the resolver', () => {
    const resolverCalls: string[] = []
    const { app, result } = mountWithResolver(
      () => {
        const b = useForm({ schema: schemaB, key: 'inj-2-b' })
        const a = useForm({ schema: schemaA, key: 'inj-2-a', next: b })
        return useWizard(a, { history: { param: 'wiz' } })
      },
      (param) => {
        resolverCalls.push(param)
        return param === 'wiz' ? 'inj-2-b' : undefined
      }
    )
    apps.push(app)
    expect(resolverCalls).toEqual(['wiz'])
    expect(result.current).toBe('inj-2-b')
  })

  it('explicit getServerActiveStep wins over the injected resolver', () => {
    const { app, result } = mountWithResolver(
      () => {
        const c = useForm({ schema: schemaC, key: 'inj-3-c' })
        const b = useForm({ schema: schemaB, key: 'inj-3-b', next: c })
        const a = useForm({ schema: schemaA, key: 'inj-3-a', next: b })
        return useWizard(a, { getServerActiveStep: () => 'inj-3-c' })
      },
      () => 'inj-3-b'
    )
    apps.push(app)
    expect(result.current).toBe('inj-3-c')
  })

  it('falls back to entry when both explicit getter and resolver return undefined', () => {
    const { app, result } = mountWithResolver(
      () => {
        const b = useForm({ schema: schemaB, key: 'inj-4-b' })
        const a = useForm({ schema: schemaA, key: 'inj-4-a', next: b })
        return useWizard(a, { getServerActiveStep: () => undefined })
      },
      () => undefined
    )
    apps.push(app)
    expect(result.current).toBe('inj-4-a')
  })

  it('an unknown key from the resolver falls through to entry', () => {
    const { app, result } = mountWithResolver(
      () => {
        const b = useForm({ schema: schemaB, key: 'inj-5-b' })
        const a = useForm({ schema: schemaA, key: 'inj-5-a', next: b })
        return useWizard(a)
      },
      () => 'inj-5-unknown'
    )
    apps.push(app)
    expect(result.current).toBe('inj-5-a')
  })
})

describe('useWizard — post-hydration URL restore (Path D)', () => {
  const apps: App[] = []
  beforeEach(() => {
    window.history.replaceState(null, '', ORIGINAL_URL)
  })
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    window.history.replaceState(null, '', ORIGINAL_URL)
  })

  it('reconciles current to the URL key in onMounted when no resolver is wired', () => {
    window.history.replaceState(null, '', `${ORIGINAL_URL}?step=pmr-1-b`)
    const { app, result } = mountWithResolver(() => {
      const c = useForm({ schema: schemaC, key: 'pmr-1-c' })
      const b = useForm({ schema: schemaB, key: 'pmr-1-b', next: c })
      const a = useForm({ schema: schemaA, key: 'pmr-1-a', next: b })
      return useWizard(a)
    }, null)
    apps.push(app)
    // Synchronous mount in jsdom fires onMounted before mount returns;
    // by the time we read `current`, the restore has settled.
    expect(result.current).toBe('pmr-1-b')
  })

  it('clamps visited to the restored step (no phantom entry visit)', () => {
    window.history.replaceState(null, '', `${ORIGINAL_URL}?step=pmr-2-b`)
    const { app, result } = mountWithResolver(() => {
      const c = useForm({ schema: schemaC, key: 'pmr-2-c' })
      const b = useForm({ schema: schemaB, key: 'pmr-2-b', next: c })
      const a = useForm({ schema: schemaA, key: 'pmr-2-a', next: b })
      return useWizard(a)
    }, null)
    apps.push(app)
    expect(result.flow.visited).toEqual(['pmr-2-b'])
  })

  it('preserves the deep-link URL during setup (does NOT overwrite with entry)', () => {
    window.history.replaceState(null, '', `${ORIGINAL_URL}?step=pmr-3-b`)
    const { app } = mountWithResolver(() => {
      const c = useForm({ schema: schemaC, key: 'pmr-3-c' })
      const b = useForm({ schema: schemaB, key: 'pmr-3-b', next: c })
      const a = useForm({ schema: schemaA, key: 'pmr-3-a', next: b })
      return useWizard(a)
    }, null)
    apps.push(app)
    // The deep-link URL is preserved through setup; the entry-key
    // write-back that fires for non-deep-link mounts is skipped here.
    expect(new URL(window.location.href).searchParams.get('step')).toBe('pmr-3-b')
  })

  it('does not redirect when URL key matches the explicit getter', () => {
    window.history.replaceState(null, '', `${ORIGINAL_URL}?step=pmr-4-c`)
    const { app, result } = mountWithResolver(() => {
      const c = useForm({ schema: schemaC, key: 'pmr-4-c' })
      const b = useForm({ schema: schemaB, key: 'pmr-4-b', next: c })
      const a = useForm({ schema: schemaA, key: 'pmr-4-a', next: b })
      return useWizard(a, { getServerActiveStep: () => 'pmr-4-c' })
    }, null)
    apps.push(app)
    expect(result.current).toBe('pmr-4-c')
    expect(result.flow.visited).toEqual(['pmr-4-c'])
  })

  it('falls through to entry when URL key is unknown', () => {
    window.history.replaceState(null, '', `${ORIGINAL_URL}?step=pmr-5-nope`)
    const { app, result } = mountWithResolver(() => {
      const b = useForm({ schema: schemaB, key: 'pmr-5-b' })
      const a = useForm({ schema: schemaA, key: 'pmr-5-a', next: b })
      return useWizard(a)
    }, null)
    apps.push(app)
    expect(result.current).toBe('pmr-5-a')
    expect(result.flow.visited).toEqual(['pmr-5-a'])
  })
})

describe('useWizard — SSR-to-client hydration safety', () => {
  const apps: App[] = []
  beforeEach(() => {
    window.history.replaceState(null, '', ORIGINAL_URL)
  })
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    window.history.replaceState(null, '', ORIGINAL_URL)
  })

  it('hydrates an SSR-rendered entry against a deep-link URL with no mismatch warnings', async () => {
    const WizardSfc = defineComponent({
      setup() {
        const b = useForm({ schema: schemaB, key: 'hyd-b' })
        const a = useForm({ schema: schemaA, key: 'hyd-a', next: b })
        const wizard = useWizard(a)
        return () =>
          h(
            'div',
            { class: wizard.current === 'hyd-a' ? 'on-a' : 'on-b' },
            `step:${wizard.current}`
          )
      },
    })

    // Server-side render. No `window`; the wizard falls back to entry.
    const ssrApp = createSSRApp(WizardSfc).use(createAttaform({ ssr: true }))
    const ssrHtml = await renderToString(ssrApp)
    expect(ssrHtml).toContain('on-a')
    expect(ssrHtml).toContain('step:hyd-a')

    // Stage the SSR HTML in a host element, then point the URL at a
    // non-entry step so the client wizard's restore path fires.
    const host = document.createElement('div')
    host.innerHTML = ssrHtml
    document.body.appendChild(host)
    window.history.replaceState(null, '', `${ORIGINAL_URL}?step=hyd-b`)

    // Capture every Vue warning surfaced during hydration. Hydration
    // mismatches are emitted via `app.config.warnHandler` (or fall back
    // to `console.warn` when no handler is set) — installing a handler
    // lets us assert against the captured stream rather than scraping
    // jsdom's console.
    const warnings: string[] = []
    const clientApp = createSSRApp(WizardSfc).use(createAttaform({ ssr: false }))
    clientApp.config.warnHandler = (msg) => {
      warnings.push(msg)
    }
    clientApp.mount(host)
    apps.push(clientApp)

    const hydrationWarnings = warnings.filter((msg) => /hydration|mismatch/i.test(msg))
    expect(hydrationWarnings).toEqual([])

    // The restore's reactive write fires in `onMounted` but Vue
    // batches the re-render into a microtask, so flush before
    // inspecting the DOM.
    await nextTick()
    expect(host.querySelector('.on-b')).not.toBeNull()
    expect(host.textContent).toContain('step:hyd-b')
  })
})
