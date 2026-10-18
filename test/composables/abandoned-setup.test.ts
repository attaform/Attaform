// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, Suspense, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { injectForm } from '../../src/runtime/composables/use-form-context'
import { injectWizard } from '../../src/runtime/composables/inject-wizard'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'
import { getRegistryFromApp } from '../../src/runtime/core/registry'
import { flushMicrotasks } from '../utils/form-harness'
import AwaitingPage from '../fixtures/abandoned-setup/AwaitingPage.vue'

/**
 * A `setup()` that resumes after an `await` once Vue has dropped its
 * component, here a `<Suspense>` branch replaced before it resolved,
 * resumes inside a scope that has already stopped. Vue parks every
 * `onScopeDispose` there, and those never run, so an Attaform composable
 * called there kept its registry entry, its consumer count and the
 * wizard's popstate listener for the life of the app (#712). Each
 * composable now runs such a call in a scope of its own, stopped once it
 * returns. The control resolves the same page and keeps its entries
 * while it is mounted.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (opts: any) => any
const adapters = [
  { name: 'v4', useForm: useFormV4 as AnyUseForm, z: zV4 },
  { name: 'v3', useForm: useFormV3 as AnyUseForm, z: zV3 as unknown as typeof zV4 },
] as const

describe.each(adapters)(
  'a setup resumed after Vue dropped its component (#712): $name',
  ({ useForm, z }) => {
    let app: App | null = null

    afterEach(() => {
      vi.restoreAllMocks()
      app?.unmount()
      app = null
      window.history.replaceState({}, '', '/')
    })

    /**
     * Mounts `Host` (whose setup runs `host`) around a `<Suspense>` page
     * whose setup awaits, then runs `page`. `abandon` replaces the page
     * before it resolves; otherwise it resolves and mounts.
     */
    async function mountPage(options: {
      host?: () => void
      page: () => void
      abandon: boolean
    }): Promise<{ app: App; dropHost(): Promise<void> }> {
      let release = (): void => {}
      const data = new Promise<void>((resolve) => {
        release = resolve
      })
      const onPage = ref(true)
      const Host = defineComponent({
        setup() {
          options.host?.()
          return () =>
            h(Suspense, null, {
              default: () =>
                onPage.value ? h(AwaitingPage, { data, build: options.page }) : h('main'),
            })
        },
      })
      const onHost = ref(true)
      const mounted = createApp({ setup: () => () => (onHost.value ? h(Host) : h('div')) })
      mounted.use(createAttaform())
      mounted.config.warnHandler = () => {}
      mounted.mount(document.body.appendChild(document.createElement('div')))
      app = mounted
      await nextTick()
      if (options.abandon) {
        onPage.value = false
        await nextTick()
      }
      release()
      await flushMicrotasks()
      await nextTick()
      await flushMicrotasks()
      return {
        app: mounted,
        async dropHost() {
          onHost.value = false
          await nextTick()
          await flushMicrotasks()
        },
      }
    }

    function buildForms(): ReturnType<AnyUseForm>[] {
      return [
        useForm({ key: 'first', schema: z.object({ name: z.string().optional() }) }),
        useForm({ key: 'second', schema: z.object({ note: z.string().optional() }) }),
      ]
    }

    it('control: a page that resolves keeps its forms and wizard while mounted', async () => {
      const page = await mountPage({
        page: () => useWizard({ key: 'flow', steps: buildForms() }),
        abandon: false,
      })
      const registry = getRegistryFromApp(page.app)
      expect([...registry.forms.keys()].sort()).toEqual(['first', 'second'])
      expect([...registry.wizards.keys()]).toEqual(['flow'])
    })

    it('useForm keeps no registry entry', async () => {
      const page = await mountPage({ page: buildForms, abandon: true })
      expect([...getRegistryFromApp(page.app).forms.keys()]).toEqual([])
    })

    it('useWizard keeps no registry entry and no popstate listener', async () => {
      const added = vi.spyOn(window, 'addEventListener')
      const removed = vi.spyOn(window, 'removeEventListener')
      const page = await mountPage({
        page: () => useWizard({ key: 'flow', steps: buildForms() }),
        abandon: true,
      })
      const registry = getRegistryFromApp(page.app)
      expect([...registry.wizards.keys()]).toEqual([])
      expect([...registry.forms.keys()]).toEqual([])
      const listens = (spy: typeof added): number =>
        spy.mock.calls.filter(([type]) => type === 'popstate').length
      expect(listens(added)).toBe(listens(removed))
    })

    it('injectForm does not keep a form alive past its last mounted consumer', async () => {
      const page = await mountPage({
        host: () => useForm({ key: 'shared', schema: z.object({ name: z.string().optional() }) }),
        page: () => injectForm('shared'),
        abandon: true,
      })
      await page.dropHost()
      expect(getRegistryFromApp(page.app).forms.has('shared')).toBe(false)
    })

    it('injectWizard does not keep a wizard alive past its last mounted consumer', async () => {
      const page = await mountPage({
        host: () => useWizard({ key: 'flow', steps: buildForms() }),
        page: () => injectWizard('flow'),
        abandon: true,
      })
      await page.dropHost()
      expect(getRegistryFromApp(page.app).wizards.has('flow')).toBe(false)
    })
  }
)
