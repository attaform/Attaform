// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, KeepAlive, nextTick, type App, type VNode } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { createAttaform } from '../../src/runtime/core/plugin'
import { loadVueRouter, type TestRouter, type VueRouterModule } from '../utils/vue-router'

/**
 * Under vue-router, the default `?step=` sync writes through the router's
 * own history (#712). vue-router keeps a record on every entry (its own
 * address, its position, the entries either side, its scroll) and writes
 * that address back onto the entry it leaves when it next navigates. The
 * wizard used to write each entry itself with an empty state, so:
 *
 *   - a link away rewrote the step's entry to the last address the router
 *     knew, and Back landed on another step;
 *   - after a Back onto a step's entry the router adopted the empty state,
 *     and the next link away wrote `<origin>undefined`, which a browser
 *     refuses as cross-origin and vue-router then loads as a page.
 *
 * Runs against vue-router as Nuxt installs it, on both adapters.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (opts: any) => any
const adapters = [
  { name: 'v4', useForm: useFormV4 as AnyUseForm, z: zV4 },
  { name: 'v3', useForm: useFormV3 as AnyUseForm, z: zV3 as unknown as typeof zV4 },
] as const

let vueRouter: VueRouterModule
beforeAll(async () => {
  vueRouter = await loadVueRouter()
})

function address(): string {
  return window.location.pathname + window.location.search
}

async function addressBecomes(expected: string): Promise<void> {
  await vi.waitFor(() => expect(address()).toBe(expected))
  await nextTick()
  await nextTick()
}

describe.each(adapters)('useWizard URL sync under vue-router (#712): $name', ({ useForm, z }) => {
  let app: App | null = null
  let router: TestRouter | null = null
  let wizard: ReturnType<typeof useWizard> | null = null

  afterEach(() => {
    app?.unmount()
    router?.options.history.destroy()
    app = null
    router = null
    wizard = null
    window.history.replaceState(null, '', '/')
  })

  async function mount(options: { keepAlive: boolean }): Promise<TestRouter> {
    const Apply = defineComponent({
      setup() {
        const first = useForm({ key: 'first', schema: z.object({ name: z.string().optional() }) })
        const second = useForm({ key: 'second', schema: z.object({ note: z.string().optional() }) })
        const third = useForm({ key: 'third', schema: z.object({ done: z.boolean().optional() }) })
        wizard = useWizard({ key: 'flow', steps: [first, second, third] })
        return () => h('form')
      },
    })
    const Other = defineComponent({ setup: () => () => h('main') })
    window.history.replaceState(null, '', '/')
    const created = vueRouter.createRouter({
      history: vueRouter.createWebHistory(),
      routes: [
        { path: '/', component: Other },
        { path: '/apply', component: Apply },
        { path: '/other', component: Other },
      ],
    })
    router = created
    const { RouterView } = vueRouter
    app = createApp({
      setup: () => () =>
        options.keepAlive
          ? h(RouterView, null, {
              default: ({ Component }: { Component: VNode | undefined }) =>
                h(KeepAlive, null, [Component]),
            })
          : h(RouterView),
    })
    app.use(created).use(createAttaform())
    app.mount(document.body.appendChild(document.createElement('div')))
    await created.isReady()
    await created.push('/apply')
    await nextTick()
    return created
  }

  function step(): string | undefined {
    return wizard?.currentStep
  }

  it("records each step's entry the way the router records its own", async () => {
    await mount({ keepAlive: false })
    expect(address()).toBe('/apply?step=first')
    wizard?.goTo('second')
    await nextTick()
    expect(address()).toBe('/apply?step=second')
    expect(window.history.state).toMatchObject({
      current: '/apply?step=second',
      back: '/apply?step=first',
      position: expect.any(Number),
    })
  })

  it("keeps a step's entry through a link away and Back", async () => {
    const mounted = await mount({ keepAlive: false })
    wizard?.goTo('second')
    await nextTick()
    await mounted.push('/other')
    window.history.back()
    await addressBecomes('/apply?step=second')
    expect(step()).toBe('second')
  })

  it('keeps a link away on the site after a Back onto a step', async () => {
    const mounted = await mount({ keepAlive: false })
    wizard?.goTo('second')
    await nextTick()
    wizard?.goTo('third')
    await nextTick()
    window.history.back()
    await addressBecomes('/apply?step=second')
    expect(step()).toBe('second')
    await mounted.push('/other')
    expect(address()).toBe('/other')
    window.history.back()
    await addressBecomes('/apply?step=second')
    expect(step()).toBe('second')
  })

  it('stays on its step through a Back off its kept page', async () => {
    const mounted = await mount({ keepAlive: true })
    await mounted.push('/other?step=second')
    await mounted.push('/apply')
    await nextTick()
    expect(step()).toBe('first')
    window.history.back()
    await addressBecomes('/other?step=second')
    expect(step()).toBe('first')
  })
})
