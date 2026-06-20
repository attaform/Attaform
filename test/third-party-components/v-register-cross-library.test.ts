// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createApp,
  defineComponent,
  h,
  ref,
  withDirectives,
  type App,
  type Ref,
  type VNode,
} from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { vRegister } from '../../src/runtime/core/directive'
import { SSR_COMPONENT_HOST_MODIFIER } from '../../src/runtime/core/register-protocol'
import { createAttaform } from '../../src/runtime/core/plugin'
import { awaitSettle, waitUntil } from '../utils/form-harness'
import PrimeVue from 'primevue/config'
import InputText from 'primevue/inputtext'
import Password from 'primevue/password'
import {
  NumberFieldRoot,
  NumberFieldInput,
  PinInputRoot,
  PinInputInput,
  SliderRoot,
  SliderTrack,
  SliderRange,
  SliderThumb,
  ComboboxRoot,
  ComboboxAnchor,
  ComboboxInput,
} from 'reka-ui'

/**
 * Phase 4 of the third-party-component story (plan
 * `~/.claude/plans/zany-finding-melody.md`): validate phases 1-3 against the
 * real rendered DOM of two production headless / component libraries plus a
 * synthetic escape fixture, rather than the hand-rolled stand-ins of the
 * directive unit tests.
 *
 * Each mount mirrors the compile-time `componentBridgeTransform` output at
 * runtime: the v-model value channel (`:modelValue` + `@update:modelValue`
 * carrying the typed `innerRef`), the `:registerValue` prop, and `v-register`
 * stamped with `SSR_COMPONENT_HOST_MODIFIER` via `withDirectives`' 4-tuple. The
 * directive then supplies the rich FieldState by discovering the inner control.
 *
 * The matrix surfaced one real trap (the mirror-input latch inflation, now
 * fixed by `isLatchableControl`); the Combobox case below is its regression
 * guard against the actual reka-ui BubbleInput.
 */

// reka-ui Slider observes its track with ResizeObserver, which jsdom lacks.
class ResizeObserverStub {
  observe(): void {
    /* no-op */
  }
  unobserve(): void {
    /* no-op */
  }
  disconnect(): void {
    /* no-op */
  }
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any

// useForm is overloaded on the schema type; the harness varies the schema at
// runtime, so call through a permissive alias (mirrors form-harness's pattern).
const useFormHost = useForm as (opts: Record<string, unknown>) => AnyApi

type Mount = {
  app: App
  api: AnyApi
  host: () => HTMLElement | null
  inner: (selector?: string) => HTMLInputElement | null
  show: Ref<boolean>
  warnings: string[]
}

// The transform-equivalent value channel + register prop. Re-read on every
// parent render (inside the render closure) so `modelValue` tracks `innerRef`.
function vmodel(rv: AnyApi): Record<string, unknown> {
  return {
    modelValue: rv.innerRef.value,
    'onUpdate:modelValue': (v: unknown) => rv.setValueFromHost(v),
    registerValue: rv,
  }
}

const mounts: Mount[] = []

async function mountHost(
  schema: unknown,
  child: (rv: AnyApi, vm: Record<string, unknown>) => VNode,
  opts: { prime?: boolean } = {}
): Promise<Mount> {
  const handle: { api?: AnyApi } = {}
  const warnings: string[] = []
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    warnings.push(a.map(String).join(' '))
  })
  const show = ref(true)

  const Parent = defineComponent({
    setup() {
      const api = useFormHost({ schema, key: `xlib-${Math.random().toString(36).slice(2)}` })
      handle.api = api
      const rv = api.register('field')
      return () => {
        if (!show.value) return h('div', { class: 'placeholder' })
        return withDirectives(child(rv, vmodel(rv)), [
          [vRegister, rv, '', { [SSR_COMPONENT_HOST_MODIFIER]: true }],
        ])
      }
    },
  })

  const app = createApp(Parent).use(createAttaform())
  if (opts.prime) app.use(PrimeVue, { unstyled: true })
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  await waitUntil(() => (handle.api !== undefined && root.firstElementChild !== null ? true : null))
  await awaitSettle()
  warnSpy.mockRestore()

  if (handle.api === undefined) throw new Error('mountHost: api never set')
  const hostEl = (): HTMLElement | null => root.firstElementChild as HTMLElement | null
  const m: Mount = {
    app,
    api: handle.api,
    host: hostEl,
    inner: (selector = 'input') =>
      (hostEl()?.querySelector(selector) ?? null) as HTMLInputElement | null,
    show,
    warnings,
  }
  mounts.push(m)
  return m
}

afterEach(() => {
  for (const m of mounts.splice(0)) {
    try {
      m.app.unmount()
    } catch {
      /* ignore */
    }
  }
  document.body.innerHTML = ''
})

// ---------------------------------------------------------------------------
// PrimeVue
// ---------------------------------------------------------------------------

describe('cross-library matrix: PrimeVue', () => {
  it('InputText: the component root IS the native input -> binds like a native control', async () => {
    const m = await mountHost(
      z.object({ field: z.string().min(1) }),
      (_rv, vm) => h(InputText, { ...vm }),
      { prime: true }
    )
    const el = m.host() as HTMLInputElement
    expect(el.tagName).toBe('INPUT')

    // The per-tag variant registered the input directly (callModelHook), and
    // activateComponentHost's discriminator stepped aside (el.contains(el)).
    expect(m.api.fields.field.connected).toBe(true)
    el.dispatchEvent(new Event('focus'))
    await waitUntil(() => (m.api.fields.field.focused === true ? true : null))
    expect(m.api.fields.field.focused).toBe(true)

    // autoAria is managed on the input itself; the redundant v-model channel
    // does not break value reflection.
    expect(el.getAttribute('aria-required')).toBe('true')
    m.api.setValue('field', 'seeded')
    await awaitSettle()
    expect(el.value).toBe('seeded')

    // A value-binding host is not a no-op.
    expect(m.warnings.filter((w) => w.includes('is a no-op')).length).toBe(0)
  })

  it('Password: div host -> latches the single inner password input', async () => {
    const m = await mountHost(
      z.object({ field: z.string().min(1) }),
      (_rv, vm) => h(Password, { ...vm, feedback: false }),
      { prime: true }
    )
    expect(m.host()?.tagName).toBe('DIV')
    const inner = m.inner('input[type=password]') as HTMLInputElement
    expect(inner).not.toBeNull()

    expect(m.api.fields.field.connected).toBe(true)
    inner.dispatchEvent(new Event('focus'))
    await waitUntil(() => (m.api.fields.field.focused === true ? true : null))
    expect(m.api.fields.field.focused).toBe(true)

    // aria lands on the discovered inner control, not the wrapper div.
    expect(m.host()?.getAttribute('aria-required')).toBeNull()
    expect(inner.getAttribute('aria-required')).toBe('true')

    m.api.setValue('field', 'hunter2')
    await awaitSettle()
    expect(inner.value).toBe('hunter2')
  })
})

// ---------------------------------------------------------------------------
// reka-ui
// ---------------------------------------------------------------------------

describe('cross-library matrix: reka-ui', () => {
  it('NumberField: div host -> latches the spinbutton input, carries a typed number', async () => {
    const m = await mountHost(z.object({ field: z.number() }), (_rv, vm) =>
      h(NumberFieldRoot, { ...vm }, () => [h(NumberFieldInput)])
    )
    expect(m.host()?.getAttribute('role')).toBe('group')
    const inner = m.inner('input') as HTMLInputElement
    expect(inner.getAttribute('role')).toBe('spinbutton')

    expect(m.api.fields.field.connected).toBe(true)
    inner.dispatchEvent(new Event('focus'))
    await waitUntil(() => (m.api.fields.field.focused === true ? true : null))
    expect(m.api.fields.field.focused).toBe(true)
    expect(inner.getAttribute('aria-required')).toBe('true')

    m.api.setValue('field', 7)
    await awaitSettle()
    expect(inner.value).toBe('7')
  })

  it('Combobox (multi-root via PopperRoot): value channel binds, but the directive is dropped', async () => {
    // FINDING (Phase 4): reka-ui's Combobox roots in PopperRoot, a multi-root
    // (fragment) component. Vue forwards a runtime directive only to a SINGLE
    // element root, so v-register is silently dropped here: it emits the
    // "non-element root node" dev warning and none of the directive hooks run.
    // The compile-time v-model is prop / emit based, so the VALUE channel is
    // unaffected; only the directive-driven FieldState (latch -> connected,
    // focus / blur, aria, scroll-to-error) is lost. This is a structural Vue
    // limitation with no library-side fix: such a component must expose a single
    // element root (reka-ui `asChild`) or be wrapped so v-register lands on an
    // inner element. Asserted here so the limitation is documented and a
    // regression in either direction is loud.
    const m = await mountHost(z.object({ field: z.string() }), (_rv, vm) =>
      h(ComboboxRoot, { ...vm, name: 'field' }, () => [h(ComboboxAnchor, () => [h(ComboboxInput)])])
    )

    // Vue warned that the directive could not attach to a non-element root.
    expect(m.warnings.some((w) => w.includes('non-element root node'))).toBe(true)

    // The directive never ran: no latch, so the inner input's focus is untracked
    // and the field never reads connected from a host mark.
    const real = m.inner('input[role=combobox]') as HTMLInputElement
    expect(real).not.toBeNull()
    real.dispatchEvent(new Event('focus'))
    await awaitSettle()
    expect(m.api.fields.field.focused).not.toBe(true)
    expect(m.api.fields.field.connected).not.toBe(true)
  })

  it('PinInput: composite (>1 segment) -> declines the latch, still connected', async () => {
    // The field is a string here only so `fields.field.connected` reads cleanly;
    // the latch outcome is DOM-driven (segment count), independent of the model
    // type, and PinInput renders from the array modelValue passed below.
    const m = await mountHost(z.object({ field: z.string() }), (_rv, vm) =>
      h(
        PinInputRoot,
        { ...vm, modelValue: Array.isArray(vm['modelValue']) ? vm['modelValue'] : [] },
        () => [0, 1, 2, 3].map((i) => h(PinInputInput, { index: i }))
      )
    )

    // Value binds via v-model, so the field reads connected without a latch.
    expect(m.api.fields.field.connected).toBe(true)

    // A segment focus does not track: no single control latched, so no element
    // focus listener (widget-root focus is Phase 2b).
    const seg = m.inner('input') as HTMLInputElement
    seg.dispatchEvent(new Event('focus'))
    await awaitSettle()
    expect(m.api.fields.field.focused).toBe(false)

    m.show.value = false
    await waitUntil(() => (m.api.fields.field.connected === false ? true : null))
    expect(m.api.fields.field.connected).toBe(false)
  })

  it('Slider: no native control -> no latch, connected on mount and cleared on unmount', async () => {
    // String field for a clean `connected` read; Slider renders from the array
    // modelValue passed below (see the PinInput note).
    const m = await mountHost(z.object({ field: z.string() }), (_rv, vm) =>
      h(
        SliderRoot,
        { ...vm, modelValue: Array.isArray(vm['modelValue']) ? vm['modelValue'] : [50] },
        () => [h(SliderTrack, () => [h(SliderRange)]), h(SliderThumb, { index: 0 })]
      )
    )
    // The thumb is a role=slider span, not a native control.
    expect(m.inner('input')).toBeNull()
    expect(m.api.fields.field.connected).toBe(true)

    m.show.value = false
    await waitUntil(() => (m.api.fields.field.connected === false ? true : null))
    expect(m.api.fields.field.connected).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Value channel + the composition escape path
// ---------------------------------------------------------------------------

// Standard v-model (modelValue + update:modelValue), div host, typed number.
const StandardModelInput = defineComponent({
  name: 'StandardModelInput',
  props: { modelValue: { type: Number, default: 0 } },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () =>
      h('div', { class: 'host' }, [
        h('input', {
          class: 'inner',
          value: String(props.modelValue),
          onInput: (e: Event) =>
            emit('update:modelValue', Number((e.target as HTMLInputElement).value)),
        }),
      ])
  },
})

// A component that speaks `value` / `update:value` (NOT the standard
// modelValue). The transform injects modelValue, which this component ignores.
const ValueModelInput = defineComponent({
  name: 'ValueModelInput',
  props: { value: { type: String, default: 'UNBOUND' } },
  emits: ['update:value'],
  setup(props, { emit }) {
    return () =>
      h('div', { class: 'host' }, [
        h('input', {
          class: 'inner',
          value: props.value,
          onInput: (e: Event) => emit('update:value', (e.target as HTMLInputElement).value),
        }),
      ])
  },
})

// The composition escape hatch: a thin wrapper mapping standard v-model onto a
// value/update:value component.
const BridgedValueModel = defineComponent({
  name: 'BridgedValueModel',
  props: { modelValue: { type: String, default: '' } },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () =>
      h(ValueModelInput, {
        value: props.modelValue,
        'onUpdate:value': (v: string) => emit('update:modelValue', v),
      })
  },
})

// A hand-authored component whose root is a fragment (multiple sibling nodes).
// Reproduces the multi-root limitation reka-ui's PopperRoot-based Combobox hits,
// without any library, so the structural Vue rule is pinned for native custom
// components too: a runtime directive only forwards to a single ELEMENT root.
const MultiRootComponent = defineComponent({
  name: 'MultiRootComponent',
  props: { modelValue: { type: String, default: '' } },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () => [
      h('input', {
        class: 'inner',
        value: props.modelValue,
        onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value),
      }),
      h('span', 'sibling root node'),
    ]
  },
})

describe('cross-library matrix: value channel + escape path', () => {
  it('standard v-model: latches the inner control and round-trips a TYPED value', async () => {
    const m = await mountHost(z.object({ field: z.number() }), (_rv, vm) =>
      h(StandardModelInput, { ...vm })
    )
    expect(m.api.fields.field.connected).toBe(true)

    // Seed: form -> modelValue -> inner reflects.
    m.api.setValue('field', 7)
    await awaitSettle()
    const inner = m.inner('input.inner') as HTMLInputElement
    expect(inner.value).toBe('7')

    // Round-trip: the component emits a NUMBER; setValueFromHost preserves type.
    inner.value = '42'
    inner.dispatchEvent(new Event('input'))
    await awaitSettle()
    expect(m.api.fields.field.value).toBe(42)
    expect(typeof m.api.fields.field.value).toBe('number')
  })

  it('value/update:value component: the injected modelValue does NOT reach it (escape needed)', async () => {
    const m = await mountHost(z.object({ field: z.string() }), (_rv, vm) =>
      h(ValueModelInput, { ...vm })
    )
    m.api.setValue('field', 'fromform')
    await awaitSettle()
    const inner = m.inner('input.inner') as HTMLInputElement
    // It reads its own `value` prop, never set, so the form value never lands.
    // This documents WHY a non-standard-v-model component must be wrapped.
    expect(inner.value).toBe('UNBOUND')
  })

  it('a wrapper mapping modelValue <-> value bridges the escape-path component', async () => {
    const m = await mountHost(z.object({ field: z.string() }), (_rv, vm) =>
      h(BridgedValueModel, { ...vm })
    )
    m.api.setValue('field', 'fromform')
    await awaitSettle()
    const inner = m.inner('input.inner') as HTMLInputElement
    expect(inner.value).toBe('fromform')
    expect(m.api.fields.field.connected).toBe(true)
  })

  it('multi-root (fragment) component: value binds via v-model, the directive is dropped', async () => {
    // The general rule behind the reka-ui Combobox case, reproduced for a
    // hand-authored component: Vue forwards a runtime directive only to a single
    // ELEMENT root, so v-register is dropped on a fragment-rooted component (it
    // warns and no hook runs). Value rides the prop / emit v-model regardless;
    // the FieldState half does not.
    const m = await mountHost(z.object({ field: z.string() }), (_rv, vm) =>
      h(MultiRootComponent, { ...vm })
    )

    expect(m.warnings.some((w) => w.includes('non-element root node'))).toBe(true)

    // Value channel is unaffected by root structure (props / emits).
    const inner = m.host() as HTMLInputElement // fragment root: first element is the input
    expect(inner.tagName).toBe('INPUT')
    m.api.setValue('field', 'bound')
    await awaitSettle()
    expect(inner.value).toBe('bound')

    // Directive half is gone: no latch -> focus untracked, never connected.
    inner.dispatchEvent(new Event('focus'))
    await awaitSettle()
    expect(m.api.fields.field.focused).not.toBe(true)
    expect(m.api.fields.field.connected).not.toBe(true)
  })
})
