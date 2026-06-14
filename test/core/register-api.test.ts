// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { computed, isRef, ref } from 'vue'
import { createFormStore } from '../../src/runtime/core/create-form-store'
import { vRegister } from '../../src/runtime/core/directive'
import { computeFieldIdentity } from '../../src/runtime/core/field-ids'
import { canonicalizePath } from '../../src/runtime/core/paths'
import { buildRegister, type InstanceRegisterConfig } from '../../src/runtime/core/register-api'
import type { DisplayState } from '../../src/runtime/types/types-api'
import { fakeSchema } from '../utils/fake-schema'

type F = { email: string; note: string }

function makeRegister(opts?: { ssr?: boolean; formKey?: string; instanceId?: string }) {
  const state = createFormStore<F>({
    formKey: opts?.formKey ?? `r-${Math.random().toString(36).slice(2)}`,
    schema: fakeSchema<F>({ email: '', note: '' }),
    ...(opts?.ssr === true ? { ssr: true } : {}),
  })
  return { state, register: buildRegister(state, opts?.instanceId ?? 'test:inst') }
}

describe('buildRegister', () => {
  describe('RegisterValue shape', () => {
    it('returns innerRef, registerElement, deregisterElement, setValueWithInternalPath', () => {
      const { register } = makeRegister()
      const rv = register(['email'])
      expect(typeof rv.registerElement).toBe('function')
      expect(typeof rv.deregisterElement).toBe('function')
      expect(typeof rv.setValueWithInternalPath).toBe('function')
      // Tightened from `.toBeDefined()` — the contract is a Vue Ref,
      // not an arbitrary non-undefined value.
      expect(isRef(rv.innerRef)).toBe(true)
    })

    it('innerRef reflects current form value', () => {
      const { state, register } = makeRegister()
      const rv = register(['email'])
      expect(rv.innerRef.value).toBe('')
      state.setValueAtPath(['email'], 'typed@x')
      expect(rv.innerRef.value).toBe('typed@x')
    })

    it('setValueWithInternalPath writes to the form', () => {
      const { state, register } = makeRegister()
      const rv = register(['email'])
      rv.setValueWithInternalPath('written@x')
      expect(state.form.value.email).toBe('written@x')
    })
  })

  describe('wrapper-component primitives (path, segments, formKey, formInstanceId)', () => {
    // These four fields are the wrapper-component story: a generic
    // child using `useRegister()` derives field state and form
    // identity from them without re-threading props from the parent.

    it('exposes the canonical PathKey string', () => {
      const { register } = makeRegister()
      const rv = register(['email'])
      // PathKey is the JSON-encoded segment array — opaque, stable for
      // Map/Set keys, equality, and log strings.
      expect(rv.path).toBe('["email"]')
      expect(typeof rv.path).toBe('string')
      expect(isRef(rv.path)).toBe(false)
    })

    it('canonicalises array and dotted paths to the same PathKey', () => {
      const { register } = makeRegister()
      expect(register(['email']).path).toBe(register('email').path)
    })

    it('exposes structured segments for form.fields(rv.segments) lookups', () => {
      const { register } = makeRegister()
      expect(register('email').segments).toEqual(['email'])
      expect(register(['items', 0, 'name']).segments).toEqual(['items', 0, 'name'])
    })

    it('freezes segments so wrapper components can pass them without copying', () => {
      const { register } = makeRegister()
      const rv = register(['email'])
      expect(Object.isFrozen(rv.segments)).toBe(true)
    })

    it('exposes the form key from the FormStore', () => {
      const { register } = makeRegister({ formKey: 'signup-form' })
      const rv = register(['email'])
      expect(rv.formKey).toBe('signup-form')
    })

    it('exposes the formInstanceId passed to buildRegister', () => {
      const { register } = makeRegister({ instanceId: 'inst-42' })
      const rv = register(['email'])
      expect(rv.formInstanceId).toBe('inst-42')
    })

    it('reads track via the shallowReadonly proxy in a computed scope', () => {
      // Vue's shallowReadonly proxy registers reads as dependencies.
      // The values themselves never mutate within an RV's lifetime
      // (path / formKey / formInstanceId are baked at construction),
      // but the tracking pass should still visit them — important
      // for wrapper-component patterns that read these inside a
      // `computed(() => form.fields(rv.value?.segments))` derivation.
      const { register } = makeRegister({ formKey: 'k', instanceId: 'i' })
      const rv = register(['email'])
      const derived = computed(() => `${rv.formKey}:${rv.formInstanceId}:${rv.segments.join('.')}`)
      expect(derived.value).toBe('k:i:email')
    })

    it('blocks direct field mutation under shallowReadonly', () => {
      const { register } = makeRegister()
      const rv = register(['email'])
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        // Vue's readonly proxies log a console.warn and silently drop
        // the write — the value is unchanged, no exception thrown.
        ;(rv as unknown as { path: string }).path = 'phone' as never
        expect(rv.path).toBe('["email"]')
        expect(warn).toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })
  })

  describe('element registration', () => {
    it('registers interactive elements and tracks connection', () => {
      const { state, register } = makeRegister()
      const rv = register(['email'])
      const input = document.createElement('input')
      rv.registerElement(input)
      expect(state.getFieldRecord(['email'])?.connected).toBe(true)
    })

    it('skips non-interactive elements silently', () => {
      const { state, register } = makeRegister()
      const rv = register(['email'])
      const div = document.createElement('div')
      rv.registerElement(div)
      // The field record exists (from init) but was not connected via this call.
      expect(state.getFieldRecord(['email'])?.connected).toBe(false)
    })

    it('attaches focus/blur listeners that drive markFocused', () => {
      const { state, register } = makeRegister()
      const rv = register(['email'])
      const input = document.createElement('input')
      document.body.appendChild(input)
      rv.registerElement(input)

      input.dispatchEvent(new FocusEvent('focus'))
      expect(state.getFieldRecord(['email'])?.focused).toBe(true)

      input.dispatchEvent(new FocusEvent('blur'))
      expect(state.getFieldRecord(['email'])?.focused).toBe(false)
      expect(state.getFieldRecord(['email'])?.touched).toBe(true)

      document.body.removeChild(input)
    })

    it('catches autofocus that fired before the listener was attached', () => {
      // The browser applies `<input autofocus>` during HTML parse and
      // dispatches the resulting `focus` event BEFORE Vue's directive
      // lifecycle runs. By the time `attachFocusListeners` wires up,
      // the focus event has already come and gone. The probe inside
      // `attachFocusListeners` exists to close that race: if the
      // element is already `document.activeElement` at attach-time,
      // call `markFocused(true)` synchronously so FieldState reflects
      // DOM truth instead of the optimistic `focused: false` seeded
      // at registration. Simulates the race by focusing the input
      // BEFORE calling `registerElement` (the call order inside the
      // directive `created` hook for an autofocused element).
      const { state, register } = makeRegister()
      const rv = register(['email'])
      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()
      expect(document.activeElement).toBe(input)
      // Sanity: the FormStore has not seen any focus signal yet — the
      // listener isn't attached and `input.focus()` above only fired a
      // native DOM event no one was listening to.
      expect(state.getFieldRecord(['email'])?.focused).toBe(null)

      rv.registerElement(input)
      // After registration, the probe inside `attachFocusListeners`
      // sees `document.activeElement === input` and flips focused.
      expect(state.getFieldRecord(['email'])?.focused).toBe(true)
      expect(state.getFieldRecord(['email'])?.blurred).toBe(false)
      expect(state.getFieldRecord(['email'])?.connected).toBe(true)

      document.body.removeChild(input)
    })

    it('does not flip focused when registering an element that is NOT the active one', () => {
      // Negative case for the autofocus probe — pin that we don't
      // false-positive when a sibling input happens to be focused.
      const { state, register } = makeRegister()
      const rv = register(['email'])
      const sibling = document.createElement('input')
      const target = document.createElement('input')
      document.body.appendChild(sibling)
      document.body.appendChild(target)
      sibling.focus()
      expect(document.activeElement).toBe(sibling)

      rv.registerElement(target)
      // `target` was not the active element at attach-time, so the
      // probe leaves the optimistic `focused: false` in place.
      expect(state.getFieldRecord(['email'])?.focused).toBe(false)
      expect(state.getFieldRecord(['email'])?.blurred).toBe(true)
      expect(state.getFieldRecord(['email'])?.connected).toBe(true)

      document.body.removeChild(sibling)
      document.body.removeChild(target)
    })

    it('removes focus/blur listeners on deregister', () => {
      const { state, register } = makeRegister()
      const rv = register(['email'])
      const input = document.createElement('input')
      document.body.appendChild(input)
      rv.registerElement(input)
      // Cause a change so we can tell if post-deregister events sneak through.
      input.dispatchEvent(new FocusEvent('focus'))
      expect(state.getFieldRecord(['email'])?.focused).toBe(true)

      rv.deregisterElement(input)
      // After deregister, re-dispatch: if a listener still fires,
      // `markFocused(blur)` would flip the record to `focused: false,
      // blurred: true`. Instead the disconnect transition has set
      // both flags to `null` (no element ⇒ DOM-state concepts don't
      // apply) and the missing listener leaves them at `null`.
      input.dispatchEvent(new FocusEvent('blur'))
      expect(state.getFieldRecord(['email'])?.focused).toBe(null)
      expect(state.getFieldRecord(['email'])?.blurred).toBe(null)
      expect(state.getFieldRecord(['email'])?.connected).toBe(false)
      document.body.removeChild(input)
    })
  })

  describe('cross-form isolation', () => {
    it('two registers for different forms do not share DOM state', () => {
      const stateA = createFormStore<F>({
        formKey: 'A',
        schema: fakeSchema<F>({ email: '', note: '' }),
      })
      const stateB = createFormStore<F>({
        formKey: 'B',
        schema: fakeSchema<F>({ email: '', note: '' }),
      })
      const registerA = buildRegister(stateA, 'test:inst')
      const registerB = buildRegister(stateB, 'test:inst')

      const rvA = registerA(['email'])
      const rvB = registerB(['email'])

      const input = document.createElement('input')
      document.body.appendChild(input)
      rvA.registerElement(input)

      expect(stateA.getFieldRecord(['email'])?.connected).toBe(true)
      expect(stateB.getFieldRecord(['email'])?.connected).toBe(false)

      // Writing to A's registerValue doesn't touch B.
      rvA.setValueWithInternalPath('only-in-A')
      expect(stateA.form.value.email).toBe('only-in-A')
      expect(stateB.form.value.email).toBe('')

      rvA.deregisterElement(input)
      document.body.removeChild(input)
      void rvB
    })
  })

  describe('aria wiring', () => {
    function makeAriaRegister(config?: InstanceRegisterConfig) {
      const state = createFormStore<F>({
        formKey: 'aria-form',
        schema: fakeSchema<F>({ email: '', note: '' }),
      })
      return { state, register: buildRegister(state, 'aria:inst', config) }
    }

    it('bakes aria ids matching computeFieldIdentity', () => {
      const { register } = makeAriaRegister({ getDisplayStateAt: () => 'idle' })
      const rv = register(['email'])
      const expected = computeFieldIdentity(
        'aria:inst',
        'aria-form',
        canonicalizePath(['email']).key
      )
      expect(rv.aria).toEqual(expected.aria)
    })

    it('exposes the schema required flag as a boolean', () => {
      const { register } = makeAriaRegister({ getDisplayStateAt: () => 'idle' })
      expect(typeof register(['email']).isRequired).toBe('boolean')
    })

    it('enables aria by default, and the verdict reuses getDisplayStateAt', () => {
      const ds = ref<DisplayState>('idle')
      const { register } = makeAriaRegister({ getDisplayStateAt: () => ds.value })
      const rv = register(['email'])
      expect(rv.ariaEnabled).toBe(true)
      expect(rv.ariaDisplayState?.value).toBe('idle')
      // Reactive: a verdict change flows through without re-registering.
      ds.value = 'error'
      expect(rv.ariaDisplayState?.value).toBe('error')
    })

    it('disables aria for the whole form when autoAria is false', () => {
      const { register } = makeAriaRegister({ autoAria: false, getDisplayStateAt: () => 'idle' })
      expect(register(['email']).ariaEnabled).toBe(false)
    })

    it('disables aria per-binding via the register autoAria option', () => {
      const { register } = makeAriaRegister({ getDisplayStateAt: () => 'idle' })
      expect(register(['email'], { autoAria: false }).ariaEnabled).toBe(false)
      // Sibling bindings on the same form keep aria on.
      expect(register(['note']).ariaEnabled).toBe(true)
    })

    it('re-enables aria per-binding even when the form opted out', () => {
      const { register } = makeAriaRegister({ autoAria: false, getDisplayStateAt: () => 'idle' })
      // Per-binding autoAria overrides the form-level opt-out in both directions.
      expect(register(['email'], { autoAria: true }).ariaEnabled).toBe(true)
      // Bindings that don't override still inherit the form's opt-out.
      expect(register(['note']).ariaEnabled).toBe(false)
    })

    it('omits ariaDisplayState when no accessor is wired (hand-rolled factory)', () => {
      const { register } = makeAriaRegister()
      expect(register(['email']).ariaDisplayState).toBeUndefined()
    })

    it('getSSRProps tolerates the null vnode the compiled SSR helper passes', () => {
      // Vue's compiled SSR directive-props helper calls getSSRProps with
      // a null vnode (no vnode object in string-based SSR). Reading
      // `vnode.props` unguarded would crash every server render.
      const { register } = makeAriaRegister({ getDisplayStateAt: () => 'error' })
      const rv = register(['email'])
      const binding = { value: rv }
      const ssr = vRegister.getSSRProps?.(binding as never, null as never)
      expect(ssr).toMatchObject({ 'aria-invalid': 'true' })
    })
  })
})
