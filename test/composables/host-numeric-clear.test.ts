// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, withDirectives, type App, type PropType } from 'vue'
import { z } from 'zod'
import { z as z3 } from 'zod-v3'
import { zodAdapter as zodAdapterV4 } from '../../src/runtime/adapters/zod-v4'
import { zodAdapter as zodAdapterV3 } from '../../src/runtime/adapters/zod-v3'
import { createFormStore } from '../../src/runtime/core/create-form-store'
import { buildRegister } from '../../src/runtime/core/register-api'
import { canonicalizePath } from '../../src/runtime/core/paths'
import { vRegister } from '../../src/runtime/core/directive'
import { SSR_COMPONENT_HOST_MODIFIER } from '../../src/runtime/core/register-protocol'
import { createAttaform } from '../../src/runtime/core/plugin'
import { useForm, type UseFormReturn } from '../../src/zod'
import type { AbstractSchema } from '../../src/runtime/types/types-api'
import type { GenericForm } from '../../src/runtime/types/types-core'

/**
 * A numeric leaf wrapped in a presentational component and bound by
 * `v-register` is the "bring your own component" shape. A native
 * `<input v-register>` special-cases a DOM clear on a numeric-only leaf
 * (`el.value === ''`) into `markBlank` — storage lands on the slim `0`
 * with the blank flag, and the box stays empty. `setValueFromHost` (the
 * component-host analog: v-model desugar → `onUpdate:modelValue`) now
 * mirrors that: an emitted empty signal ('' / null / undefined) the
 * slim gate would reject routes to `markBlank` instead of a rejected
 * write, so form state doesn't freeze at the old value while the
 * component's DOM shows empty (issue #518).
 *
 * The slim-set gate keeps the normalization honest: a `.nullable()` /
 * `.optional()` leaf still takes null / undefined as a genuine value.
 *
 * The reverse direction is `hostModelValue`: a blank path presents as
 * `undefined` on the `:modelValue` channel (the typed-model analog of
 * the native path's `''`), so a naive numeric component renders empty
 * on the round-trip exactly as a native input does.
 */

// The two adapter factories carry version-divergent generic signatures,
// so one shared harness can't call both without unifying them to the
// structural shape they both produce (a curried AbstractSchema factory).
// Each adapter's schemas are built below with its own `z`, so no
// cross-version union is ever invoked.
type HostAdapter = (
  schema: unknown
) => (
  formKey: string,
  options: { maxRecursionDepth: number }
) => AbstractSchema<GenericForm, GenericForm>

const adapters = [
  {
    name: 'zod-v4',
    adapt: zodAdapterV4 as unknown as HostAdapter,
    schemas: {
      number: z.object({ n: z.number() }),
      nullable: z.object({ n: z.number().nullable() }),
      optional: z.object({ n: z.number().optional() }),
      string: z.object({ n: z.string() }),
    },
  },
  {
    name: 'zod-v3',
    adapt: zodAdapterV3 as unknown as HostAdapter,
    schemas: {
      number: z3.object({ n: z3.number() }),
      nullable: z3.object({ n: z3.number().nullable() }),
      optional: z3.object({ n: z3.number().optional() }),
      string: z3.object({ n: z3.string() }),
    },
  },
] as const

const KEY = canonicalizePath(['n']).key

describe.each(adapters)(
  'setValueFromHost numeric-clear normalization [$name]',
  ({ adapt, schemas }) => {
    function hostFor(schema: unknown, defaultValues: GenericForm) {
      const formKey = `host-num-${Math.random().toString(36).slice(2)}`
      // Materialize the curried adapter the way useAbstractForm does before
      // handing the store a real AbstractSchema.
      const abstract = adapt(schema)(formKey, { maxRecursionDepth: 64 })
      const state = createFormStore({ formKey, schema: abstract, defaultValues })
      return { state, rv: buildRegister(state, 'host:inst')(['n']) }
    }

    it('required z.number(): a host-emitted "" blanks the field (slim 0 + blank flag)', () => {
      const { state, rv } = hostFor(schemas.number, { n: 42 })
      expect(state.getValueAtPath(['n'])).toBe(42)

      const accepted = rv.setValueFromHost('')

      expect(accepted).toBe(true)
      expect(state.getValueAtPath(['n'])).toBe(0) // slim default, well-typed
      expect(state.blankPaths.has(KEY)).toBe(true)
    })

    it('required z.number(): a host-emitted null blanks the field (common cleared-control signal)', () => {
      const { state, rv } = hostFor(schemas.number, { n: 42 })

      const accepted = rv.setValueFromHost(null)

      expect(accepted).toBe(true)
      expect(state.getValueAtPath(['n'])).toBe(0)
      expect(state.blankPaths.has(KEY)).toBe(true)
    })

    it('required z.number(): a host-emitted undefined blanks the field', () => {
      const { state, rv } = hostFor(schemas.number, { n: 42 })

      const accepted = rv.setValueFromHost(undefined)

      expect(accepted).toBe(true)
      expect(state.getValueAtPath(['n'])).toBe(0)
      expect(state.blankPaths.has(KEY)).toBe(true)
    })

    it('required z.number(): a real emitted number writes through (no blank)', () => {
      const { state, rv } = hostFor(schemas.number, { n: 42 })

      const accepted = rv.setValueFromHost(7)

      expect(accepted).toBe(true)
      expect(state.getValueAtPath(['n'])).toBe(7)
      expect(state.blankPaths.has(KEY)).toBe(false)
    })

    it('z.number().nullable(): a host-emitted null is a genuine value, not a blank signal', () => {
      const { state, rv } = hostFor(schemas.nullable, { n: 42 })

      const accepted = rv.setValueFromHost(null)

      expect(accepted).toBe(true)
      expect(state.getValueAtPath(['n'])).toBe(null) // stored, not coerced to 0
      expect(state.blankPaths.has(KEY)).toBe(false)
    })

    it('z.number().optional(): a host-emitted undefined is a genuine value, not a blank signal', () => {
      const { state, rv } = hostFor(schemas.optional, { n: 42 })

      const accepted = rv.setValueFromHost(undefined)

      expect(accepted).toBe(true)
      expect(state.getValueAtPath(['n'])).toBe(undefined)
      expect(state.blankPaths.has(KEY)).toBe(false)
    })

    it('z.string(): a host-emitted "" is a normal text clear, never routed through blank', () => {
      const { state, rv } = hostFor(schemas.string, { n: 'seed' })

      const accepted = rv.setValueFromHost('')

      expect(accepted).toBe(true)
      expect(state.getValueAtPath(['n'])).toBe('') // '' is a valid string, stored as-is
      expect(state.blankPaths.has(KEY)).toBe(false)
    })
  }
)

describe('hostModelValue — blank-aware :modelValue presentation', () => {
  function numericHost(defaultValues: GenericForm) {
    const formKey = `host-model-${Math.random().toString(36).slice(2)}`
    const abstract = zodAdapterV4(z.object({ n: z.number() }))(formKey, { maxRecursionDepth: 64 })
    const state = createFormStore({ formKey, schema: abstract, defaultValues })
    return { state, rv: buildRegister(state, 'host:inst')(['n']) }
  }

  it('presents the raw typed value for a filled path', () => {
    const { rv } = numericHost({ n: 42 })
    expect(rv.hostModelValue.value).toBe(42)
  })

  it('presents undefined for a blank path so a naive component renders empty', () => {
    const { rv } = numericHost({ n: 42 })
    rv.setValueFromHost('') // clear -> blank

    // Storage still holds the slim 0, but the model channel presents the
    // typed-model analog of "empty" so `undefined ?? '' === ''` in the host.
    expect(rv.hostModelValue.value).toBeUndefined()
  })

  it('flips back to the typed value once the host re-supplies a number', () => {
    const { rv } = numericHost({ n: 42 })
    rv.setValueFromHost('')
    expect(rv.hostModelValue.value).toBeUndefined()

    rv.setValueFromHost(9)
    expect(rv.hostModelValue.value).toBe(9)
  })
})

// A naive presentational numeric component: parses non-empty input to a
// number, emits the raw '' on a clear (no number to emit). Its modelValue
// admits undefined -- that is how a blank field reaches a typed model. No
// useRegister; the manually-wired v-model pair mirrors what
// componentBridgeTransform generates (:modelValue reads hostModelValue,
// @update routes through setValueFromHost).
const NumHost = defineComponent({
  name: 'NumHost',
  props: {
    modelValue: { type: [Number, String] as PropType<number | string | undefined>, default: '' },
  },
  emits: ['update:modelValue'],
  setup:
    (props, { emit }) =>
    () =>
      h('input', {
        value: props.modelValue ?? '',
        onInput: (e: Event) => {
          const raw = (e.target as HTMLInputElement).value
          emit('update:modelValue', raw === '' ? '' : Number(raw))
        },
      }),
})

const roundTripSchema = z.object({ n: z.number() })
type RoundTripApi = UseFormReturn<typeof roundTripSchema>

describe('component host numeric round-trip (integration): clear syncs DOM and state', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    document.body.innerHTML = ''
  })

  function mountNumHost(): { api: RoundTripApi; input: () => HTMLInputElement } {
    const handle: { api?: RoundTripApi } = {}
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const Parent = defineComponent({
      setup() {
        const api = useForm({
          schema: roundTripSchema,
          defaultValues: { n: 42 },
          key: `num-host-${Math.random().toString(36).slice(2)}`,
        })
        handle.api = api
        const rv = api.register('n')
        return () =>
          withDirectives(
            h(NumHost, {
              modelValue: rv.hostModelValue.value,
              'onUpdate:modelValue': (v: unknown) => rv.setValueFromHost(v),
            }),
            [[vRegister, rv, '', { [SSR_COMPONENT_HOST_MODIFIER]: true }]]
          )
      },
    })
    const app = createApp(Parent).use(createAttaform())
    apps.push(app)
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    warnSpy.mockRestore()
    if (handle.api === undefined) throw new Error('mountNumHost: api never set')
    return {
      api: handle.api,
      input: () => root.querySelector('input') as HTMLInputElement,
    }
  }

  function typeInto(input: HTMLInputElement, value: string): void {
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  it('seeds the component from the default and accepts a typed number', async () => {
    const { api, input } = mountNumHost()
    expect(input().value).toBe('42')

    typeInto(input(), '7')
    await Promise.resolve()

    expect(api.values.n).toBe(7)
    expect(api.fields('n').blank).toBe(false)
  })

  it('clearing the component blanks the field AND leaves the DOM empty (issue #518)', async () => {
    const { api, input } = mountNumHost()
    typeInto(input(), '7')
    await Promise.resolve()

    typeInto(input(), '') // user clears the numeric control
    await Promise.resolve()

    // State is correct: storage lands on the slim default with the blank
    // flag, so submit-time validation sees "no value supplied" rather than
    // silently submitting the frozen 7.
    expect(api.values.n).toBe(0)
    expect(api.fields('n').blank).toBe(true)
    // And the round-trip presents undefined back to the component, so the
    // box reads empty the way a native <input v-register> would.
    expect(input().value).toBe('')
  })
})
