// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, withDirectives, type App, type VNode } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { attachRegistryToApp, createRegistry } from '../../src/runtime/core/registry'
import { vRegister } from '../../src/runtime/core/directive'
import type { UseFormReturnType } from '../../src/runtime/types/types-api'

/**
 * Plain `<input type="text">` (no `.number` modifier, no
 * `type="number"`) bound to a `z.number()` leaf. The path-level
 * coerce closure handles string→number conversion for non-empty
 * input, so typing digits commits cleanly. The bug: clearing the
 * input writes `''` through the assigner, the slim gate rejects
 * (empty string is not a number), storage stays at the prior
 * number, and the force-sync snaps the DOM back to the stored
 * digits. From the user's view the LAST character is undeletable
 * (`'42' → '4'` works because `'4'` coerces; `'4' → ''` rejects
 * and snaps back to `'4'`).
 *
 * The values demo at /play/values exposes exactly this: a
 * `z.number()` `age` field rendered as `type="text"
 * inputmode="numeric"`. Partial deletes work; the final delete
 * doesn't.
 *
 * Contract: the user can fully clear the input. Storage tracks
 * blank via `markBlank` so submit-time validation surfaces the
 * required-but-missing error, instead of the directive silently
 * forcing a stale value.
 */

type AnySchema = z.ZodObject<Record<string, z.ZodType>>

function mountInputForPath<F extends AnySchema>(
  schema: F,
  path: string,
  defaultValues?: Partial<z.input<F>>
): {
  app: App
  input: HTMLInputElement
  form: UseFormReturnType<z.output<F> & Record<string, unknown>>
} {
  let captured!: UseFormReturnType<z.output<F> & Record<string, unknown>>
  const inputRef: { el: HTMLInputElement | null } = { el: null }
  const Probe = defineComponent({
    setup() {
      const config = {
        schema,
        key: `numeric-text-clear-${Math.random().toString(36).slice(2)}`,
        ...(defaultValues !== undefined ? { defaultValues } : {}),
      } as unknown as Parameters<typeof useForm>[0]
      captured = useForm(config) as unknown as UseFormReturnType<
        z.output<F> & Record<string, unknown>
      >
      const rv = captured.register(path as never)
      return (): VNode =>
        withDirectives(
          h('input', {
            type: 'text',
            inputmode: 'numeric',
            ref: (el: unknown) => {
              if (el instanceof HTMLInputElement) inputRef.el = el
            },
          }),
          [[vRegister, rv]]
        )
    },
  })
  const app = createApp(Probe)
  attachRegistryToApp(app, createRegistry())
  app.mount(document.createElement('div'))
  if (inputRef.el === null) throw new Error('input ref never captured')
  return { app, input: inputRef.el, form: captured }
}

function typeInto(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('vRegisterText × type="text" inputmode="numeric" × z.number() — DOM clear', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  it('partial deletes survive (digits coerce cleanly to numbers)', () => {
    const schema = z.object({ age: z.number() })
    const { app, input, form } = mountInputForPath(schema, 'age', { age: 0 })
    apps.push(app)

    typeInto(input, '42')
    expect(form.values.age).toBe(42)
    expect(input.value).toBe('42')

    typeInto(input, '4')
    expect(form.values.age).toBe(4)
    expect(input.value).toBe('4')
  })

  it('full clear leaves the DOM empty (no snapback to the prior digit)', () => {
    const schema = z.object({ age: z.number() })
    const { app, input } = mountInputForPath(schema, 'age', { age: 0 })
    apps.push(app)

    typeInto(input, '42')
    typeInto(input, '4')
    expect(input.value).toBe('4')

    typeInto(input, '')
    expect(input.value).toBe('')
  })

  it('full clear from the mount-time default also leaves the DOM empty', () => {
    const schema = z.object({ age: z.number() })
    const { app, input } = mountInputForPath(schema, 'age', { age: 0 })
    apps.push(app)

    expect(input.value).toBe('0')

    typeInto(input, '')
    expect(input.value).toBe('')
  })

  it('re-typing after a full clear writes the new number', () => {
    const schema = z.object({ age: z.number() })
    const { app, input, form } = mountInputForPath(schema, 'age', { age: 0 })
    apps.push(app)

    typeInto(input, '7')
    typeInto(input, '')
    typeInto(input, '9')

    expect(form.values.age).toBe(9)
    expect(input.value).toBe('9')
  })
})
