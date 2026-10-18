// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, KeepAlive, nextTick, ref, Suspense, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'
import { flushMicrotasks } from '../utils/form-harness'
import AwaitingPage from '../fixtures/abandoned-setup/AwaitingPage.vue'

/**
 * The default `?step=` sync reads and writes the address only while the
 * wizard is on screen, and follows a Back or Forward only onto the path
 * it is on (#712). A page kept by `<KeepAlive>` outlives its time on
 * screen: while it is hidden the address belongs to whichever page is
 * shown, so a hidden wizard neither follows that page's `?step=` nor
 * writes its own onto it. The browser fires `popstate` before the router
 * takes the page off screen, so a Back off the page is not followed even
 * while the page is still mounted.
 *
 * Coming back on screen settles what was left alone: a Back or Forward
 * made meanwhile to another of the wizard's steps is followed, a step
 * change made in memory is written, and a return through a link to the
 * bare page puts the kept step on it in place. A setup's first write
 * waits for mount, so a setup that resumes after its route moved on
 * writes nothing.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (opts: any) => any
const adapters = [
  { name: 'v4', useForm: useFormV4 as AnyUseForm, z: zV4 },
  { name: 'v3', useForm: useFormV3 as AnyUseForm, z: zV3 as unknown as typeof zV4 },
] as const

const PAGE = '/apply/fill_1'

function address(): string {
  return window.location.pathname + window.location.search
}

/** Lands the address on `path` and fires the browser's popstate, as a Back or Forward does. */
async function historyTo(path: string): Promise<void> {
  window.history.replaceState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
  await nextTick()
}

describe.each(adapters)('useWizard URL sync under <KeepAlive> (#712): $name', ({ useForm, z }) => {
  let app: App | null = null

  function buildWizard(): ReturnType<typeof useWizard> {
    const first = useForm({ key: 'first', schema: z.object({ name: z.string().optional() }) })
    const second = useForm({ key: 'second', schema: z.object({ note: z.string().optional() }) })
    const third = useForm({ key: 'third', schema: z.object({ done: z.boolean().optional() }) })
    return useWizard({ key: 'kept-wizard', steps: [first, second, third] })
  }

  async function mountKept(): Promise<{
    wizard: ReturnType<typeof useWizard>
    show(next: boolean): Promise<void>
  }> {
    let wizard: ReturnType<typeof useWizard> | null = null
    const Wizard = defineComponent({
      setup() {
        wizard = buildWizard()
        return () => h('form')
      },
    })
    const Other = defineComponent({ setup: () => () => h('main') })
    const onWizard = ref(true)
    app = createApp({
      setup: () => () => h(KeepAlive, null, [onWizard.value ? h(Wizard) : h(Other)]),
    })
    app.use(createAttaform())
    app.mount(document.body.appendChild(document.createElement('div')))
    await nextTick()
    if (wizard === null) throw new Error('the wizard was not built')
    return {
      wizard,
      async show(next) {
        onWizard.value = next
        await nextTick()
        await nextTick()
      },
    }
  }

  /** A page whose setup awaits `data` before it builds the wizard, under `<Suspense>`. */
  function mountSuspended(): { release(): void; leave(): Promise<void> } {
    let release = (): void => {}
    const data = new Promise<void>((resolve) => {
      release = resolve
    })
    const Other = defineComponent({ setup: () => () => h('main') })
    const onPage = ref(true)
    app = createApp({
      setup: () => () =>
        h(Suspense, null, {
          default: () => (onPage.value ? h(AwaitingPage, { data, build: buildWizard }) : h(Other)),
        }),
    })
    app.use(createAttaform())
    app.config.warnHandler = () => {}
    app.mount(document.body.appendChild(document.createElement('div')))
    return {
      release,
      async leave() {
        onPage.value = false
        await nextTick()
      },
    }
  }

  beforeEach(() => window.history.replaceState({}, '', PAGE))
  afterEach(() => {
    vi.restoreAllMocks()
    app?.unmount()
    app = null
    window.history.replaceState({}, '', '/')
  })

  it('syncs while shown, and follows a Back or Forward on its own path', async () => {
    const { wizard } = await mountKept()
    expect(address()).toBe(`${PAGE}?step=first`)
    wizard.goTo('second')
    await nextTick()
    expect(address()).toBe(`${PAGE}?step=second`)
    await historyTo(`${PAGE}?step=first`)
    expect(wizard.currentStep).toBe('first')
  })

  it('does not follow a Back off its page, though the page is still mounted', async () => {
    const kept = await mountKept()
    // The browser fires popstate before the router hides the page.
    await historyTo('/applications/app_2?step=second')
    await kept.show(false)
    expect(kept.wizard.currentStep).toBe('first')
  })

  it('does not follow a Back or Forward while hidden', async () => {
    const kept = await mountKept()
    await kept.show(false)
    await historyTo(`${PAGE}?step=second`)
    await historyTo('/applications/app_2?step=third')
    expect(kept.wizard.currentStep).toBe('first')
  })

  it('writes nothing onto the address on screen while hidden', async () => {
    const kept = await mountKept()
    await kept.show(false)
    window.history.replaceState({}, '', '/me')
    kept.wizard.goTo('second')
    await nextTick()
    kept.wizard.reset()
    await nextTick()
    expect(address()).toBe('/me')
  })

  it('writes a step change made while hidden once it is back, as a new entry', async () => {
    const kept = await mountKept()
    await kept.show(false)
    window.history.replaceState({}, '', '/me')
    kept.wizard.goTo('second')
    await nextTick()
    // Back to the page's own entry.
    window.history.replaceState({}, '', `${PAGE}?step=first`)
    const push = vi.spyOn(window.history, 'pushState')
    await kept.show(true)
    expect(kept.wizard.currentStep).toBe('second')
    expect(address()).toBe(`${PAGE}?step=second`)
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('follows a Back or Forward made while hidden to another of its steps', async () => {
    const kept = await mountKept()
    kept.wizard.goTo('second')
    await nextTick()
    await kept.show(false)
    // Meanwhile the step moved in memory, and the reader's Back moved the
    // page's entry to `?step=first`. The reader's navigation wins.
    kept.wizard.goTo('third')
    await nextTick()
    window.history.replaceState({}, '', `${PAGE}?step=first`)
    const push = vi.spyOn(window.history, 'pushState')
    const replace = vi.spyOn(window.history, 'replaceState')
    await kept.show(true)
    expect(kept.wizard.currentStep).toBe('first')
    expect(address()).toBe(`${PAGE}?step=first`)
    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it('keeps its step on a return through a link to the bare page, written in place', async () => {
    const kept = await mountKept()
    kept.wizard.goTo('second')
    await nextTick()
    await kept.show(false)
    window.history.replaceState({}, '', PAGE)
    const push = vi.spyOn(window.history, 'pushState')
    await kept.show(true)
    expect(kept.wizard.currentStep).toBe('second')
    expect(address()).toBe(`${PAGE}?step=second`)
    expect(push).not.toHaveBeenCalled()
  })

  it('stamps nothing on the next page when its setup finishes after the route moved on', async () => {
    const page = mountSuspended()
    await nextTick()
    // The reader moves on while the page is still resolving.
    window.history.pushState({}, '', '/me')
    await page.leave()
    page.release()
    await flushMicrotasks()
    await nextTick()
    expect(address()).toBe('/me')
  })

  it('stamps the first step once a page that resolves under <Suspense> mounts', async () => {
    const page = mountSuspended()
    await nextTick()
    expect(address()).toBe(PAGE)
    page.release()
    await flushMicrotasks()
    await nextTick()
    expect(address()).toBe(`${PAGE}?step=first`)
  })
})
