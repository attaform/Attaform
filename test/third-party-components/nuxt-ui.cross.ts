// @vitest-environment jsdom
//
// Nuxt UI slice of the third-party-component cross-library matrix.
//
// This file is intentionally NOT named `*.test.ts`: the main `vitest.config.ts`
// glob would pick it up and run it under the bare `@vitejs/plugin-vue` harness,
// where Nuxt UI's `#build/ui/*` / `#imports` virtuals do not resolve. It runs
// only via `pnpm test:nuxt-ui` (`vitest.nuxt-ui.config.ts`, which adds
// `@nuxt/ui/vite`). `tsc` still type-checks it (tsconfig includes `test/`).
//
// Nuxt UI v4 is built ON reka-ui, so the structural interop outcomes mirror the
// reka-ui slice (latch / no-latch / multi-root). The value here is pinning that
// a real, opinionated design-system layer ON TOP of reka-ui still binds through
// `v-register` -- the "bring your own components" adoption claim, exercised
// against a batteries-included kit rather than raw primitives.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, ref, withDirectives, type App, type VNode } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { vRegister } from '../../src/runtime/core/directive'
import { SSR_COMPONENT_HOST_MODIFIER } from '../../src/runtime/core/register-protocol'
import { createAttaform } from '../../src/runtime/core/plugin'
import { awaitSettle, waitUntil } from '../utils/form-harness'
import ui from '@nuxt/ui/vue-plugin'
import UInput from '@nuxt/ui/components/Input.vue'
import UInputNumber from '@nuxt/ui/components/InputNumber.vue'
import UPinInput from '@nuxt/ui/components/PinInput.vue'
import USlider from '@nuxt/ui/components/Slider.vue'
import USelectMenu from '@nuxt/ui/components/SelectMenu.vue'

// reka-ui's Slider observes its track with ResizeObserver, which jsdom lacks.
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
// runtime, so call through a permissive alias (mirrors the reka-ui slice).
const useFormHost = useForm as (opts: Record<string, unknown>) => AnyApi

type Mount = {
  app: App
  api: AnyApi
  host: () => HTMLElement | null
  inner: (selector?: string) => HTMLInputElement | null
  show: { value: boolean }
  warnings: string[]
}

// The transform-equivalent value channel + register prop, re-read on every
// parent render so `modelValue` tracks `innerRef`.
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
  child: (rv: AnyApi, vm: Record<string, unknown>) => VNode
): Promise<Mount> {
  const handle: { api?: AnyApi } = {}
  const warnings: string[] = []
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    warnings.push(a.map(String).join(' '))
  })
  const show = ref(true)

  const Parent = defineComponent({
    setup() {
      const api = useFormHost({ schema, key: `nuxtui-${Math.random().toString(36).slice(2)}` })
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

  const app = createApp(Parent).use(createAttaform()).use(ui)
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

describe('cross-library matrix: Nuxt UI (reka-ui based design system)', () => {
  it('UInput: wrapper root -> latches the single inner text input', async () => {
    const m = await mountHost(z.object({ field: z.string().min(1) }), (_rv, vm) =>
      h(UInput, { ...vm })
    )
    // The Primitive root wraps the input; the directive discovers and latches it.
    expect(m.host()?.tagName).not.toBe('INPUT')
    const inner = m.inner('input')
    if (!inner) throw new Error('UInput inner input missing')

    expect(m.api.fields.field.connected).toBe(true)
    inner.dispatchEvent(new Event('focus'))
    await waitUntil(() => (m.api.fields.field.focused === true ? true : null))
    expect(m.api.fields.field.focused).toBe(true)

    // aria lands on the discovered control, not the wrapper.
    expect(inner.getAttribute('aria-required')).toBe('true')

    m.api.setValue('field', 'seeded')
    await awaitSettle()
    expect(inner.value).toBe('seeded')
  })

  it('UInputNumber: NumberField wrapper -> latches the spinbutton, carries a typed number', async () => {
    const m = await mountHost(z.object({ field: z.number() }), (_rv, vm) =>
      h(UInputNumber, { ...vm })
    )
    const inner = m.inner('input')
    if (!inner) throw new Error('UInputNumber inner input missing')
    expect(inner.getAttribute('role')).toBe('spinbutton')

    expect(m.api.fields.field.connected).toBe(true)
    inner.dispatchEvent(new Event('focus'))
    await waitUntil(() => (m.api.fields.field.focused === true ? true : null))
    expect(m.api.fields.field.focused).toBe(true)

    m.api.setValue('field', 7)
    await awaitSettle()
    expect(inner.value).toBe('7')
  })

  it('UPinInput: composite segments -> declines the latch, focus tracks at the widget root', async () => {
    // The field is a string here only so `fields.field.connected` reads cleanly
    // (an array field node aggregates rather than exposing a leaf `connected`);
    // the latch outcome is DOM-driven (segment count), independent of the model
    // type. PinInput renders from the array `modelValue` passed below.
    const m = await mountHost(z.object({ field: z.string() }), (_rv, vm) =>
      h(UPinInput, {
        ...vm,
        length: 4,
        modelValue: Array.isArray(vm['modelValue']) ? vm['modelValue'] : [],
      })
    )

    // Value binds via v-model, so the field reads connected without a latch.
    expect(m.api.fields.field.connected).toBe(true)

    // Drop the visually-hidden BubbleInput mirror to reach the user-facing
    // segments (the same control isLatchableControl excludes from the latch).
    const segs = Array.from(m.host()?.querySelectorAll('input') ?? []).filter(
      (el) => el.getAttribute('aria-hidden') !== 'true' && el.getAttribute('tabindex') !== '-1'
    )
    expect(segs.length).toBeGreaterThan(1)
    const [first, second] = segs
    if (!(first instanceof HTMLInputElement) || !(second instanceof HTMLInputElement)) {
      throw new Error('UPinInput segments missing')
    }

    // Entering a segment from outside focuses the field.
    first.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await awaitSettle()
    expect(m.api.fields.field.focused).toBe(true)

    // Tabbing between segments is an intra-widget hop, not a blur.
    first.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: second }))
    second.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: first }))
    await awaitSettle()
    expect(m.api.fields.field.focused).toBe(true)

    // Leaving the widget entirely blurs it.
    second.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body })
    )
    await awaitSettle()
    expect(m.api.fields.field.focused).toBe(false)

    m.show.value = false
    await waitUntil(() => (m.api.fields.field.connected === false ? true : null))
    expect(m.api.fields.field.connected).toBe(false)
  })

  it('USlider: no native control -> no latch, focus tracks the thumb, cleared on unmount', async () => {
    const m = await mountHost(z.object({ field: z.number() }), (_rv, vm) =>
      h(USlider, {
        ...vm,
        modelValue: typeof vm['modelValue'] === 'number' ? vm['modelValue'] : 50,
      })
    )
    expect(m.inner('input')).toBeNull()
    expect(m.api.fields.field.connected).toBe(true)

    const thumb = m.host()?.querySelector('[role=slider]')
    if (!(thumb instanceof HTMLElement)) throw new Error('USlider thumb missing')
    thumb.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await awaitSettle()
    expect(m.api.fields.field.focused).toBe(true)
    thumb.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }))
    await awaitSettle()
    expect(m.api.fields.field.focused).toBe(false)

    m.show.value = false
    await waitUntil(() => (m.api.fields.field.connected === false ? true : null))
    expect(m.api.fields.field.connected).toBe(false)
  })

  it('USelectMenu: Combobox (multi-root) -> value channel binds, the directive is dropped', async () => {
    // SelectMenu roots in reka-ui's Combobox (PopperRoot), a multi-root /
    // fragment component. Vue forwards a runtime directive only to a single
    // ELEMENT root, so v-register is dropped: the value rides the prop / emit
    // v-model regardless, but the directive-driven FieldState (latch ->
    // connected, focus, aria) is lost. This is the real-world case the docs'
    // "give it a single root or wrap it" guidance points at.
    const m = await mountHost(z.object({ field: z.string() }), (_rv, vm) =>
      h(USelectMenu, { ...vm, items: ['Apple', 'Banana', 'Cherry'] })
    )

    expect(m.warnings.some((w) => w.includes('non-element root node'))).toBe(true)
    expect(m.api.fields.field.connected).not.toBe(true)
  })
})
