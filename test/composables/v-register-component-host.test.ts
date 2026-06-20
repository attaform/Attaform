// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createApp,
  defineComponent,
  h,
  onMounted,
  ref,
  withDirectives,
  type App,
  type Ref,
} from 'vue'
import type { DirectiveBinding } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import type { UseFormReturn } from '../../src/zod'
import { vRegister } from '../../src/runtime/core/directive'
import { SSR_COMPONENT_HOST_MODIFIER } from '../../src/runtime/core/register-protocol'
import { createAttaform } from '../../src/runtime/core/plugin'
import { useRegister } from '../../src/runtime/composables/use-register'
import { createFormStore } from '../../src/runtime/core/create-form-store'
import { buildRegister } from '../../src/runtime/core/register-api'
import { canonicalizePath } from '../../src/runtime/core/paths'
import type { GetDisplayState, RegisterValue } from '../../src/runtime/types/types-api'
import { fakeSchema } from '../utils/fake-schema'
import { awaitSettle, waitUntil } from '../utils/form-harness'

/**
 * Phase 2 of the third-party-component story (plan
 * `~/.claude/plans/zany-finding-melody.md`): the directive's runtime half.
 *
 * The compile-time `componentBridgeTransform` stamps
 * `SSR_COMPONENT_HOST_MODIFIER` on a `v-register` that lands on a component
 * host and injects the value channel. The directive supplies the rich
 * FieldState: at `mounted` it discovers the real inner control and registers
 * it (connected + focus/blur + the aria / scroll-to-error target), telling a
 * `useRegister` wrapper (Case A — inner control self-registered) apart from a
 * third-party component (Case B — nothing registered yet).
 *
 * Two test surfaces:
 *   - store-level, driving the directive hooks against a real FormStore for
 *     precise element-Set / FieldRecord assertions;
 *   - integration, mounting a real component tree with the modifier injected
 *     through `withDirectives`' 4-tuple, proving the compile-time signal
 *     actually reaches `binding.modifiers` and the branch fires end to end.
 */

type F = { email: string; name: string }

function elementCount(state: ReturnType<typeof createFormStore<F>>, path: string[]): number {
  return state.elements.get(canonicalizePath(path).key)?.elements.size ?? 0
}

// ---------------------------------------------------------------------------
// Store-level: drive the directive hooks directly against a real FormStore.
// ---------------------------------------------------------------------------

describe('v-register component host: element discovery (store-level)', () => {
  // The directive's `mounted` schedules a deferred dev-warn via `nextTick`;
  // for a Case-A host (no owner marker) it would log. Silence console.warn so
  // the synchronous store assertions below aren't polluted by that microtask.
  let warnSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    warnSpy.mockRestore()
    document.body.innerHTML = ''
  })

  function makeForm() {
    const state = createFormStore<F>({
      formKey: 'host',
      schema: fakeSchema<F>({ email: '', name: '' }),
      ssr: false,
    })
    return { state, register: buildRegister(state, 'host:inst') }
  }

  type FakeVNode = { props: Record<string, unknown> }
  const hostHooks = vRegister as unknown as {
    mounted: (el: Element, b: DirectiveBinding, v: FakeVNode, p: null) => void
    beforeUnmount: (el: Element, b: DirectiveBinding) => void
  }
  function hostBinding(rv: RegisterValue): DirectiveBinding {
    return {
      value: rv,
      oldValue: null,
      modifiers: { [SSR_COMPONENT_HOST_MODIFIER]: true },
      arg: undefined,
      dir: {},
      instance: null,
    } as unknown as DirectiveBinding
  }
  const vnode: FakeVNode = { props: {} }

  function hostWith(children: HTMLElement[]): HTMLElement {
    const host = document.createElement('div')
    for (const child of children) host.appendChild(child)
    document.body.appendChild(host)
    return host
  }
  function input(attrs: Record<string, string> = {}): HTMLInputElement {
    const el = document.createElement('input')
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    return el
  }

  it('latches the single inner control — connected true, exactly one element registered', () => {
    const { state, register } = makeForm()
    const rv = register(['email'])
    const inner = input({ type: 'text' })
    const host = hostWith([inner])

    hostHooks.mounted(host, hostBinding(rv), vnode, null)

    expect(elementCount(state, ['email'])).toBe(1)
    expect(state.getFieldRecord(['email'])?.connected).toBe(true)
  })

  it('excludes a type=hidden mirror — latches the visible control', () => {
    const { state, register } = makeForm()
    const rv = register(['email'])
    const mirror = input({ type: 'hidden' })
    const visible = input({ type: 'text' })
    const host = hostWith([mirror, visible])

    hostHooks.mounted(host, hostBinding(rv), vnode, null)

    // Two inputs in the DOM, but the hidden mirror is excluded by the
    // selector, so exactly one control resolves and the latch takes it.
    expect(elementCount(state, ['email'])).toBe(1)
    expect(state.getFieldRecord(['email'])?.connected).toBe(true)
  })

  it('excludes an aria-hidden (tabindex=-1) mirror — latches the visible control', () => {
    const { state, register } = makeForm()
    const rv = register(['email'])
    // The reka-ui PinInput / BubbleInput pattern: a sr-only mirror input carries
    // the value for a native submit. It is NOT type=hidden, so the selector
    // matches it; the latch filter drops it for being out of the tab order and
    // hidden from the a11y tree.
    const visible = input({ type: 'text' })
    const mirror = input({ type: 'text', tabindex: '-1', 'aria-hidden': 'true' })
    const host = hostWith([visible, mirror])

    hostHooks.mounted(host, hostBinding(rv), vnode, null)

    expect(elementCount(state, ['email'])).toBe(1)
    expect(state.getFieldRecord(['email'])?.connected).toBe(true)
  })

  it('excludes a tabindex=-1 mirror that lacks aria-hidden — latches the visible control', () => {
    const { state, register } = makeForm()
    const rv = register(['email'])
    // The reka-ui Combobox BubbleInput uses data-hidden, not aria-hidden, so
    // tabindex=-1 is the load-bearing signal that the mirror is not the control
    // the user focuses.
    const visible = input({ type: 'text' })
    const mirror = input({ type: 'text', tabindex: '-1', 'data-hidden': '' })
    const host = hostWith([visible, mirror])

    hostHooks.mounted(host, hostBinding(rv), vnode, null)

    expect(elementCount(state, ['email'])).toBe(1)
    expect(state.getFieldRecord(['email'])?.connected).toBe(true)
  })

  it('a lone tabindex=-1 control declines the latch (documented mirror-heuristic edge)', () => {
    const { state, register } = makeForm()
    const rv = register(['email'])
    // The heuristic treats tabindex=-1 as "not user-facing", so a single
    // programmatically-focused control declines the latch and falls back to the
    // no-latch connected mark. Value still binds via the v-model channel.
    const host = hostWith([input({ type: 'text', tabindex: '-1' })])

    hostHooks.mounted(host, hostBinding(rv), vnode, null)

    expect(elementCount(state, ['email'])).toBe(0)
    expect(state.getFieldRecord(['email'])?.connected).toBe(true)
  })

  it('declines the latch for a composite (>1 control) but still marks connected', () => {
    const { state, register } = makeForm()
    const rv = register(['email'])
    const host = hostWith([input(), input(), input()])

    hostHooks.mounted(host, hostBinding(rv), vnode, null)

    // No single control to latch -> no element registered, but value still
    // binds via the v-model channel, so the field reads connected.
    expect(elementCount(state, ['email'])).toBe(0)
    expect(state.getFieldRecord(['email'])?.connected).toBe(true)

    hostHooks.beforeUnmount(host, hostBinding(rv))
    expect(state.getFieldRecord(['email'])?.connected).toBe(false)
  })

  it('no-latch host: widget-root focusin / focusout drive focused, ignoring intra-widget hops', () => {
    const { state, register } = makeForm()
    const rv = register(['email'])
    const a = input()
    const b = input()
    const host = hostWith([a, b])

    hostHooks.mounted(host, hostBinding(rv), vnode, null)
    // No single control to latch, so focus rides bubbling focusin / focusout on
    // the host root rather than an element-level focus listener.
    expect(elementCount(state, ['email'])).toBe(0)

    // Entering a segment from outside (relatedTarget null) focuses the field.
    a.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(state.getFieldRecord(['email'])?.focused).toBe(true)

    // A hop between segments (relatedTarget still inside the host) is not a
    // blur: the field stays focused across the focusout / focusin pair.
    a.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: b }))
    b.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: a }))
    expect(state.getFieldRecord(['email'])?.focused).toBe(true)

    // Leaving the widget entirely (relatedTarget outside the host) blurs it.
    b.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }))
    expect(state.getFieldRecord(['email'])?.focused).toBe(false)
    expect(state.getFieldRecord(['email'])?.blurred).toBe(true)

    hostHooks.beforeUnmount(host, hostBinding(rv))
  })

  it('marks connected for a no-control widget and clears it on unmount', () => {
    const { state, register } = makeForm()
    const rv = register(['email'])
    const host = hostWith([])

    hostHooks.mounted(host, hostBinding(rv), vnode, null)
    expect(elementCount(state, ['email'])).toBe(0)
    expect(state.getFieldRecord(['email'])?.connected).toBe(true)

    hostHooks.beforeUnmount(host, hostBinding(rv))
    expect(state.getFieldRecord(['email'])?.connected).toBe(false)
  })

  it('self-heal: latches a control that renders one tick after mount (nextTick supersede)', async () => {
    const { state, register } = makeForm()
    const rv = register(['email'])
    const host = hostWith([])

    hostHooks.mounted(host, hostBinding(rv), vnode, null)
    // No control at mount -> no-latch path: connected via the host mark, nothing
    // registered in the element Set.
    expect(elementCount(state, ['email'])).toBe(0)
    expect(state.getFieldRecord(['email'])?.connected).toBe(true)

    // The real control arrives a tick later; the nextTick self-heal supersedes
    // the no-latch state and latches it.
    const late = input({ type: 'text' })
    host.appendChild(late)
    await waitUntil(() => (elementCount(state, ['email']) === 1 ? true : null))
    expect(elementCount(state, ['email'])).toBe(1)
    expect(state.getFieldRecord(['email'])?.connected).toBe(true)

    // The latched control owns focus now (element listener, proving the
    // supersede ran registerElement on it).
    late.dispatchEvent(new Event('focus'))
    expect(state.getFieldRecord(['email'])?.focused).toBe(true)

    // Teardown deregisters the now-latched control (Set empties -> disconnected).
    hostHooks.beforeUnmount(host, hostBinding(rv))
    expect(state.getFieldRecord(['email'])?.connected).toBe(false)
  })

  it('self-heal: a MutationObserver latches a control that arrives after the first tick', async () => {
    const { state, register } = makeForm()
    const rv = register(['email'])
    const host = hostWith([])

    hostHooks.mounted(host, hostBinding(rv), vnode, null)
    // Let the nextTick retry pass with still no control -> the observer arms.
    await awaitSettle()
    expect(elementCount(state, ['email'])).toBe(0)

    // A genuinely-async control (post-fetch / Suspense) arrives later; the
    // observer re-queries on the childList mutation and latches it.
    host.appendChild(input({ type: 'text' }))
    await waitUntil(() => (elementCount(state, ['email']) === 1 ? true : null))
    expect(elementCount(state, ['email'])).toBe(1)
    expect(state.getFieldRecord(['email'])?.connected).toBe(true)

    hostHooks.beforeUnmount(host, hostBinding(rv))
  })

  it('self-heal: the observer is disconnected on unmount (no latch onto a detached subtree)', async () => {
    const { state, register } = makeForm()
    const rv = register(['email'])
    const host = hostWith([])

    hostHooks.mounted(host, hostBinding(rv), vnode, null)
    await awaitSettle()

    hostHooks.beforeUnmount(host, hostBinding(rv))
    expect(state.getFieldRecord(['email'])?.connected).toBe(false)

    // A control appended after teardown must not be latched by a stale observer.
    host.appendChild(input({ type: 'text' }))
    await awaitSettle()
    expect(elementCount(state, ['email'])).toBe(0)
  })

  it('Case A: a pre-registered descendant makes the host step aside (no double-register)', () => {
    const { state, register } = makeForm()
    const rv = register(['email'])
    const inner = input({ type: 'text' })
    const host = hostWith([inner])

    // Simulate the useRegister wrapper: the inner control self-registered for
    // this path (children mount before parents) before the host's mounted.
    rv.registerElement(inner)
    expect(elementCount(state, ['email'])).toBe(1)

    hostHooks.mounted(host, hostBinding(rv), vnode, null)
    // Discriminator matched -> the host took no latch, no second registration.
    expect(elementCount(state, ['email'])).toBe(1)

    // And the host's teardown must not deregister the inner control it never
    // owned: the inner control's own directive is responsible for that.
    hostHooks.beforeUnmount(host, hostBinding(rv))
    expect(elementCount(state, ['email'])).toBe(1)
  })

  it('setValueFromHost writes the value AND marks interacted (the v-model channel)', () => {
    const { state, register } = makeForm()
    const rv = register(['email'])
    expect(state.getFieldRecord(['email'])?.interacted ?? false).toBe(false)

    rv.setValueFromHost('typed@host')

    expect(state.getValueAtPath(['email'])).toBe('typed@host')
    expect(state.getFieldRecord(['email'])?.interacted).toBe(true)
  })

  it('a latched-control blur after a host edit arms blurredAfterInteraction', () => {
    const { state, register } = makeForm()
    const rv = register(['email'])
    const inner = input({ type: 'text' })
    const host = hostWith([inner])

    hostHooks.mounted(host, hostBinding(rv), vnode, null)
    expect(elementCount(state, ['email'])).toBe(1)

    // A host value edit marks interacted; the first blur after that arms the
    // gate (focus listeners ride the latched control via registerElement).
    rv.setValueFromHost('typed')
    inner.dispatchEvent(new Event('focus'))
    inner.dispatchEvent(new Event('blur'))

    expect(state.getFieldRecord(['email'])?.blurredAfterInteraction).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Integration: mount a real component tree with the modifier injected through
// withDirectives' 4-tuple (dir, value, arg, modifiers), proving the
// compile-time signal reaches binding.modifiers and the branch fires.
// ---------------------------------------------------------------------------

const schema = z.object({ email: z.string(), name: z.string() })
type Api = UseFormReturn<typeof schema>

type HostMount = {
  app: App
  api: Api
  hostEl: () => HTMLElement | null
  show: Ref<boolean>
  warnings: string[]
}

async function mountHost(Child: ReturnType<typeof defineComponent>): Promise<HostMount> {
  const handle: { api?: Api } = {}
  const warnings: string[] = []
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(' '))
  })
  const show = ref(true)

  const Parent = defineComponent({
    setup() {
      const api = useForm({ schema, key: `host-${Math.random().toString(36).slice(2)}` })
      handle.api = api
      const rv = api.register('email')
      return () => {
        if (!show.value) return h('div', { class: 'placeholder' })
        // The 4-tuple's modifiers slot mirrors what componentBridgeTransform
        // stamps; `registerValue` mirrors its always-injected prop.
        return withDirectives(h(Child, { registerValue: rv }), [
          [vRegister, rv, '', { [SSR_COMPONENT_HOST_MODIFIER]: true }],
        ])
      }
    },
  })

  const app = createApp(Parent).use(createAttaform())
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  await waitUntil(() => (handle.api !== undefined && root.firstElementChild !== null ? true : null))
  await awaitSettle()
  warnSpy.mockRestore()

  if (handle.api === undefined) throw new Error('mountHost: api never set')
  return {
    app,
    api: handle.api,
    hostEl: () => root.firstElementChild as HTMLElement | null,
    show,
    warnings,
  }
}

const DivWrappedInput = defineComponent({
  name: 'DivWrappedInput',
  inheritAttrs: false,
  setup: () => () => h('div', { class: 'wrapper' }, [h('input', { type: 'text', class: 'inner' })]),
})

const CompositePin = defineComponent({
  name: 'CompositePin',
  inheritAttrs: false,
  setup: () => () =>
    h('div', { class: 'pin' }, [
      h('input', { class: 'a', maxlength: '1' }),
      h('input', { class: 'b', maxlength: '1' }),
    ]),
})

const NoControlWidget = defineComponent({
  name: 'NoControlWidget',
  inheritAttrs: false,
  setup: () => () => h('div', { class: 'slider' }, [h('span', 'no native control')]),
})

// Renders its inner control only after mount (a stand-in for a Suspense
// boundary / post-fetch v-if): at the directive's mounted the host has no
// control, so the self-heal must latch it once it appears.
const AsyncControl = defineComponent({
  name: 'AsyncControl',
  inheritAttrs: false,
  setup() {
    const ready = ref(false)
    onMounted(() => {
      ready.value = true
    })
    return () =>
      h('div', { class: 'async-wrapper' }, ready.value ? [h('input', { class: 'late' })] : [])
  },
})

const UseRegisterWrapper = defineComponent({
  name: 'UseRegisterWrapper',
  inheritAttrs: false,
  setup() {
    const register = useRegister()
    return { register }
  },
  render() {
    return h('div', { class: 'wrapper' }, [
      withDirectives(h('input', { type: 'text', class: 'inner' }), [[vRegister, this.register]]),
    ])
  },
})

describe('v-register component host: integration (modifier plumbed through)', () => {
  let m: HostMount | undefined
  afterEach(() => {
    m?.app.unmount()
    m = undefined
    document.body.innerHTML = ''
  })

  it('div-wrapped input: the modifier activates Case B; inner-control focus tracks', async () => {
    m = await mountHost(DivWrappedInput)
    expect(m.hostEl()?.tagName).toBe('DIV')
    expect(m.api.fields.email.connected).toBe(true)

    const inner = m.hostEl()?.querySelector('input.inner') as HTMLInputElement
    inner.dispatchEvent(new Event('focus'))
    await waitUntil(() => (m?.api.fields.email.focused === true ? true : null))
    expect(m.api.fields.email.focused).toBe(true)

    inner.dispatchEvent(new Event('blur'))
    await waitUntil(() => (m?.api.fields.email.blurred === true ? true : null))
    expect(m.api.fields.email.blurred).toBe(true)
  })

  it('does NOT fire the "is a no-op" warn — a value-binding host is not a no-op', async () => {
    m = await mountHost(DivWrappedInput)
    expect(m.warnings.filter((w) => w.includes('is a no-op')).length).toBe(0)
  })

  it('composite host: connected true, and focus tracks at the widget root', async () => {
    m = await mountHost(CompositePin)
    expect(m.api.fields.email.connected).toBe(true)

    const host = m.hostEl()
    const a = host?.querySelector('input.a')
    const b = host?.querySelector('input.b')
    if (!(a instanceof HTMLInputElement) || !(b instanceof HTMLInputElement)) {
      throw new Error('composite segments missing')
    }

    // No control latched, so focus rides bubbling focusin / focusout on the
    // widget root. Entering a segment focuses the field.
    a.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await waitUntil(() => (m?.api.fields.email.focused === true ? true : null))
    expect(m.api.fields.email.focused).toBe(true)

    // A hop between segments (relatedTarget inside the host) is not a blur.
    a.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: b }))
    b.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: a }))
    await awaitSettle()
    expect(m.api.fields.email.focused).toBe(true)

    // Leaving the widget (relatedTarget outside) blurs it.
    b.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }))
    await waitUntil(() => (m?.api.fields.email.blurred === true ? true : null))
    expect(m.api.fields.email.focused).toBe(false)
    expect(m.api.fields.email.blurred).toBe(true)
  })

  it('no-control widget: connected true on mount, cleared when the host unmounts', async () => {
    m = await mountHost(NoControlWidget)
    expect(m.api.fields.email.connected).toBe(true)

    m.show.value = false
    await waitUntil(() => (m?.api.fields.email.connected === false ? true : null))
    expect(m.api.fields.email.connected).toBe(false)
  })

  it('useRegister wrapper is Case A: the inner control owns binding, no "no-op" warn', async () => {
    m = await mountHost(UseRegisterWrapper)
    expect(m.warnings.filter((w) => w.includes('is a no-op')).length).toBe(0)

    const inner = m.hostEl()?.querySelector('input.inner') as HTMLInputElement
    inner.dispatchEvent(new Event('focus'))
    await waitUntil(() => (m?.api.fields.email.focused === true ? true : null))
    expect(m.api.fields.email.focused).toBe(true)
  })

  it('async control: the self-heal latches an inner control rendered after mount', async () => {
    m = await mountHost(AsyncControl)

    // The control renders after the child's onMounted; the self-heal latches it.
    await waitUntil(() => {
      const late = m?.hostEl()?.querySelector('input.late')
      return late ? true : null
    })
    const inner = m.hostEl()?.querySelector('input.late')
    if (!(inner instanceof HTMLInputElement)) throw new Error('late control missing')

    // Latched: the control's own focus listener now drives focused (proving the
    // supersede ran registerElement on it, not just the widget-root tracking).
    inner.dispatchEvent(new Event('focus'))
    await waitUntil(() => (m?.api.fields.email.focused === true ? true : null))
    expect(m.api.fields.email.focused).toBe(true)
    expect(m.api.fields.email.connected).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Phase 3: autoAria on the latched control. The host root's own setupAria (the
// `created` hook) no-ops on a non-interactive wrapper, so the directive manages
// aria on the discovered inner control instead, seeding the authored-attr locks
// from live DOM attributes (no vnode is available for a runtime-discovered
// element). Case A (useRegister wrapper) is untouched: its inner control's own
// directive already manages aria, and activateComponentHost steps aside before
// the latch.
// ---------------------------------------------------------------------------

const ariaSchema = z.object({ email: z.string().min(1), note: z.string().optional() })
type AriaApi = UseFormReturn<typeof ariaSchema>

const forceState =
  (state: 'idle' | 'pending' | 'error' | 'success'): GetDisplayState =>
  () => ({ display: state })

type AriaHostMount = {
  app: App
  api: AriaApi
  host: () => HTMLElement
  inner: () => HTMLInputElement
}

async function mountAriaHost(
  Child: ReturnType<typeof defineComponent>,
  opts?: { getDisplayState?: GetDisplayState }
): Promise<AriaHostMount> {
  const handle: { api?: AriaApi } = {}
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const Parent = defineComponent({
    setup() {
      const api = useForm({
        schema: ariaSchema,
        key: `aria-host-${Math.random().toString(36).slice(2)}`,
        ...(opts?.getDisplayState ? { getDisplayState: opts.getDisplayState } : {}),
      })
      handle.api = api
      const rv = api.register('email')
      return () =>
        withDirectives(h(Child, { registerValue: rv }), [
          [vRegister, rv, '', { [SSR_COMPONENT_HOST_MODIFIER]: true }],
        ])
    },
  })
  const app = createApp(Parent).use(createAttaform())
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  await waitUntil(() => (handle.api !== undefined && root.firstElementChild !== null ? true : null))
  await awaitSettle()
  warnSpy.mockRestore()
  if (handle.api === undefined) throw new Error('mountAriaHost: api never set')
  const host = (): HTMLElement => root.firstElementChild as HTMLElement
  return {
    app,
    api: handle.api,
    host,
    inner: () => host().querySelector('input.inner') as HTMLInputElement,
  }
}

// Authors aria-invalid on its own inner control, so the live-DOM lock has
// something present at latch time to leave alone.
const DivWrappedAuthoredAria = defineComponent({
  name: 'DivWrappedAuthoredAria',
  inheritAttrs: false,
  setup: () => () =>
    h('div', { class: 'wrapper' }, [
      h('input', { type: 'text', class: 'inner', 'aria-invalid': 'false' }),
    ]),
})

describe('v-register component host: autoAria on the latched control (Phase 3)', () => {
  let m: AriaHostMount | undefined
  afterEach(() => {
    m?.app.unmount()
    m = undefined
    document.body.innerHTML = ''
  })

  it('lights up aria-required on the discovered control, not the wrapper root', async () => {
    m = await mountAriaHost(DivWrappedInput, { getDisplayState: forceState('idle') })
    // The required schema field surfaces aria-required on the inner control.
    expect(m.inner().getAttribute('aria-required')).toBe('true')
    // The presentational wrapper root carries no (invalid) aria.
    expect(m.host().hasAttribute('aria-required')).toBe(false)
  })

  it('reflects a forced error state as aria-invalid + describedby on the control', async () => {
    m = await mountAriaHost(DivWrappedInput, { getDisplayState: forceState('error') })
    expect(m.inner().getAttribute('aria-invalid')).toBe('true')
    expect(m.inner().getAttribute('aria-describedby')).toBe(m.api.fields.email.aria.errorId)
  })

  it('watches display state live — a failed submit flips aria-invalid post-mount', async () => {
    m = await mountAriaHost(DivWrappedInput)
    // Gate closed pre-interaction: nothing surfaced on the control.
    expect(m.inner().hasAttribute('aria-invalid')).toBe(false)

    // A failed submit opens the gate; the control's own watch flips
    // aria-invalid with no parent re-render. This liveness is exactly what
    // the runtime-SSR frozen seed lacked before this phase.
    await m.api.handleSubmit(() => undefined)()
    await waitUntil(() => (m?.inner().getAttribute('aria-invalid') === 'true' ? true : null))
    expect(m.inner().getAttribute('aria-invalid')).toBe('true')
  })

  it('respects aria the component authored on its own control (live-DOM lock)', async () => {
    m = await mountAriaHost(DivWrappedAuthoredAria, { getDisplayState: forceState('error') })
    // The component shipped aria-invalid="false" on its control; the error
    // state would set it true, but the lock seeded from the live attribute
    // leaves it untouched.
    expect(m.inner().getAttribute('aria-invalid')).toBe('false')
    // Unauthored managed attrs still flow (the field is required).
    expect(m.inner().getAttribute('aria-required')).toBe('true')
  })

  it('clears the control aria it set when the host unmounts', async () => {
    m = await mountAriaHost(DivWrappedInput, { getDisplayState: forceState('error') })
    const inner = m.inner()
    expect(inner.getAttribute('aria-invalid')).toBe('true')
    m.app.unmount()
    m = undefined
    // beforeUnmount tears down the control's watch and strips the attrs it set.
    expect(inner.hasAttribute('aria-invalid')).toBe(false)
    expect(inner.hasAttribute('aria-required')).toBe(false)
    expect(inner.hasAttribute('aria-describedby')).toBe(false)
  })

  it('manages no control aria for a composite host (no latch, no target)', async () => {
    m = await mountAriaHost(CompositePin, { getDisplayState: forceState('error') })
    // More than one control -> no latch -> no discovered aria target. The
    // composite widget owns its members' aria; value still binds via v-model.
    const segs = m.host().querySelectorAll('input')
    expect(segs.length).toBe(2)
    for (const seg of segs) expect(seg.hasAttribute('aria-invalid')).toBe(false)
  })
})
