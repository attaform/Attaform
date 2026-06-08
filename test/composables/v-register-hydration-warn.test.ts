// @vitest-environment jsdom
//
// Regression for the false `v-register` "no-op on <div>" warning that
// fires during SSR async hydration even when the consumer follows the
// prescribed delegation pattern (a custom field-wrapper whose <div> root
// calls useRegister() and re-binds v-register onto an inner native
// <input>). Surfaced from the Cubic Housing app: every SSR'd form page
// emitted one warning per field, and the message prescribes the exact
// fix that was already applied, so it actively misdirects.
//
// Root cause is a marker-timing race. useRegister() sets
// REGISTER_OWNER_MARKER on the wrapper's root element in its onMounted;
// the vRegister directive defers its unsupported-root warn-check and
// skips when the marker is present. On a fresh client mount the
// directive's deferral resolves after the post-flush onMounted (marker
// set first → silent). Under async hydration the directive hook runs
// inside a deferred Promise.then (registerDep / Suspense) with no active
// scheduler flush, so a bare-microtask deferral fires BEFORE the
// component's post-flush onMounted sets the marker → false warning.
//
// The async-setup ancestor under <Suspense> is what forces the
// async-hydration path (registerDep + hydrateSuspense), reproducing
// Nuxt's lazy page/layout hydration. A plain sync mount will NOT
// reproduce it — the existing fresh-mount coverage in
// v-register-component-runtime.test.ts (pattern 2) stays green either
// way.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Suspense,
  createSSRApp,
  defineComponent,
  h,
  nextTick,
  withDirectives,
  type App,
  type Component,
} from 'vue'
import { renderToString } from '@vue/server-renderer'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { useRegister } from '../../src'
import { vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'

const schema = z.object({ email: z.string() })

// Correctly-implemented field wrapper: <div> root, useRegister(), and
// the captured register re-bound onto an inner native <input>. Exactly
// what the warning prescribes — so it must NOT warn.
const Field = defineComponent({
  name: 'Field',
  inheritAttrs: false,
  setup() {
    const rv = useRegister()
    return () =>
      h('div', { class: 'field' }, [
        withDirectives(h('input', { type: 'text' }), [[vRegister, rv]]),
      ])
  },
})

// A genuinely unsupported wrapper: a <div> root with NO useRegister and
// no custom assigner. This is the case the warn EXISTS for — the fix
// must keep warning here, including under hydration, or it would have
// blanket-suppressed a real diagnostic instead of fixing the race.
const BareDiv = defineComponent({
  name: 'BareDiv',
  inheritAttrs: false,
  setup() {
    return () => h('div', { class: 'bare' }, 'no useRegister here')
  },
})

// Parent owns the form and applies v-register to the wrapper COMPONENT
// (the directive lands on the wrapper's root <div>). Passing the same
// RegisterValue as the `registerValue` attr mirrors what
// componentBridgeTransform injects in real templates, so the child's
// useRegister() binds for real (no collateral no-parent-RV warn).
function makeParent(Wrapper: Component, key: string, bridge: boolean): Component {
  return defineComponent({
    name: 'Parent',
    setup() {
      const form = useForm({ schema, key, defaultValues: { email: '' } })
      return () => {
        const rv = form.register('email')
        const props = bridge ? { registerValue: rv } : {}
        return withDirectives(h(Wrapper, props), [[vRegister, rv]])
      }
    },
  })
}

// The async-setup ancestor under <Suspense> forces the async-hydration
// path (registerDep + hydrateSuspense), reproducing Nuxt's lazy
// page/layout hydration.
function asyncHydrationApp(Inner: Component): Component {
  const AsyncBoundary = defineComponent({
    name: 'AsyncBoundary',
    async setup() {
      await Promise.resolve()
      return () => h(Inner)
    },
  })
  return defineComponent({
    name: 'App',
    setup() {
      return () => h(Suspense, null, { default: () => h(AsyncBoundary) })
    },
  })
}

// Async hydration completes over several microtasks (registerDep's
// Promise.then + Suspense resolution) and the directive's deferred
// warn-check is itself a post-flush nextTick, so drain both the micro-
// and macro-task queues to make the warn assertion conclusive either
// way (absence for the correct pattern, presence for genuine misuse).
async function settle(): Promise<void> {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 10))
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function hydrate(AppComponent: Component): Promise<App> {
  const html = await renderToString(createSSRApp(AppComponent).use(createAttaform()))
  const container = document.createElement('div')
  container.innerHTML = html
  document.body.appendChild(container)
  const app = createSSRApp(AppComponent).use(createAttaform())
  app.mount(container)
  await settle()
  return app
}

describe('v-register no-op warn — SSR async hydration (marker-timing race)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let warnings: string[]
  let app: App | undefined

  beforeEach(() => {
    warnings = []
    warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    })
  })

  afterEach(() => {
    app?.unmount()
    app = undefined
    warnSpy.mockRestore()
    document.body.innerHTML = ''
  })

  it('does NOT emit the no-op warning during async hydration of the prescribed useRegister wrapper', async () => {
    app = await hydrate(asyncHydrationApp(makeParent(Field, 'hydration-warn-correct', true)))

    const noop = warnings.filter((w) => w.includes('is a no-op'))
    expect(noop).toEqual([])
  })

  it('STILL warns for a genuinely unsupported <div> root under the same async-hydration path', async () => {
    app = await hydrate(asyncHydrationApp(makeParent(BareDiv, 'hydration-warn-misuse', false)))

    const noop = warnings.filter((w) => w.includes('is a no-op'))
    expect(noop.length).toBe(1)
    expect(noop[0]).toContain('v-register on <div> is a no-op')
  })
})
