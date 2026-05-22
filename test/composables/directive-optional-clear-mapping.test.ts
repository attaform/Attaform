// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, withDirectives, type App, type VNode } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { attachRegistryToApp, createRegistry } from '../../src/runtime/core/registry'
import { vRegister } from '../../src/runtime/core/directive'
import type { UseFormReturnType } from '../../src/runtime/types/types-api'

/**
 * Schema-aware DOM-clear → storage mapping.
 *
 * When a user clears a v-register'd input, the directive consults
 * the schema's slim primitive set at that path. If `undefined` is
 * in the set (the leaf was declared `.optional()`), the write
 * commits `undefined` to storage. This preserves the `.optional()`
 * "absent" semantic across user interactions: a cleared optional
 * input re-enters the absent state instead of getting stuck at the
 * inner type's falsy default.
 *
 * Required leaves keep the current behavior (clear writes `''` for
 * strings, markBlank + slim-default for numbers). Nullable-only
 * leaves also keep current behavior — `null` is the consumer's
 * deliberate "explicit empty" signal, not what a DOM clear means.
 *
 * The contract:
 *   - Slim set contains `'undefined'`        → clear writes undefined.
 *   - Slim set contains `'null'` (no undef)  → clear writes ''.
 *   - Slim set primitive only                → clear writes '' / markBlank.
 */

type AnySchema = z.ZodObject<Record<string, z.ZodType>>

function mountInputForPath<F extends AnySchema>(
  schema: F,
  path: string,
  defaultValues?: Partial<z.input<F>>,
  options?: { numberModifier?: boolean }
): {
  app: App
  input: HTMLInputElement
  form: UseFormReturnType<z.output<F> & Record<string, unknown>>
} {
  let captured!: UseFormReturnType<z.output<F> & Record<string, unknown>>
  const inputRef: { el: HTMLInputElement | null } = { el: null }
  const useNumber = options?.numberModifier === true
  const Probe = defineComponent({
    setup() {
      const config = {
        schema,
        key: `clear-undef-${Math.random().toString(36).slice(2)}`,
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
            ref: (el: unknown) => {
              if (el instanceof HTMLInputElement) inputRef.el = el
            },
          }),
          useNumber ? [[vRegister, rv, 'number' as never, { number: true }]] : [[vRegister, rv]]
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

function blur(input: HTMLInputElement): void {
  input.dispatchEvent(new Event('change', { bubbles: true }))
  input.dispatchEvent(new Event('blur', { bubbles: true }))
}

describe('DOM clear → schema-aware empty mapping', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  describe('optional string', () => {
    it('clears to undefined after typing', () => {
      const schema = z.object({ note: z.string().optional() })
      const { app, input, form } = mountInputForPath(schema, 'note')
      apps.push(app)
      typeInto(input, 'something')
      expect(form.values.note).toBe('something')
      typeInto(input, '')
      expect(form.values.note).toBeUndefined()
    })

    it('returns to undefined when defaultValues started undefined', () => {
      const schema = z.object({ note: z.string().optional() })
      const { app, input, form } = mountInputForPath(schema, 'note', { note: undefined })
      apps.push(app)
      expect(form.values.note).toBeUndefined()
      typeInto(input, 'hello')
      expect(form.values.note).toBe('hello')
      typeInto(input, '')
      expect(form.values.note).toBeUndefined()
    })

    it('re-typing after clear writes the new string', () => {
      const schema = z.object({ note: z.string().optional() })
      const { app, input, form } = mountInputForPath(schema, 'note')
      apps.push(app)
      typeInto(input, 'first')
      typeInto(input, '')
      typeInto(input, 'second')
      expect(form.values.note).toBe('second')
    })
  })

  describe('required string', () => {
    it('clears to "" (regression)', () => {
      const schema = z.object({ name: z.string() })
      const { app, input, form } = mountInputForPath(schema, 'name')
      apps.push(app)
      typeInto(input, 'alice')
      typeInto(input, '')
      expect(form.values.name).toBe('')
    })
  })

  describe('nullable-only string', () => {
    it('clears to "" — null is reserved for explicit setValue', () => {
      const schema = z.object({ note: z.string().nullable() })
      const { app, input, form } = mountInputForPath(schema, 'note')
      apps.push(app)
      typeInto(input, 'something')
      typeInto(input, '')
      expect(form.values.note).toBe('')
    })
  })

  describe('optional + nullable string', () => {
    it('clears to undefined — optional wins, null stays the deliberate signal', () => {
      const schema = z.object({ note: z.string().nullable().optional() })
      const { app, input, form } = mountInputForPath(schema, 'note')
      apps.push(app)
      typeInto(input, 'hello')
      typeInto(input, '')
      expect(form.values.note).toBeUndefined()
    })
  })

  describe('optional number', () => {
    it('clears to undefined (replaces markBlank + slim-default 0)', () => {
      const schema = z.object({ count: z.number().optional() })
      const { app, input, form } = mountInputForPath(schema, 'count', undefined, {
        numberModifier: true,
      })
      apps.push(app)
      typeInto(input, '42')
      blur(input)
      expect(form.values.count).toBe(42)
      typeInto(input, '')
      blur(input)
      expect(form.values.count).toBeUndefined()
    })
  })

  describe('required number', () => {
    it('clears to slim default 0 (regression — markBlank stays for required)', () => {
      const schema = z.object({ count: z.number() })
      const { app, input, form } = mountInputForPath(schema, 'count', undefined, {
        numberModifier: true,
      })
      apps.push(app)
      typeInto(input, '42')
      blur(input)
      typeInto(input, '')
      blur(input)
      // markBlank: storage holds slim default 0; displayValue returns ''.
      expect(form.values.count).toBe(0)
    })
  })

  /**
   * The actual DX bug — and why this whole change exists.
   *
   * Without the schema-aware empty mapping, a user who types invalid
   * data into an optional field and then clears it is stuck with a
   * permanent validation error. The cleared input shows nothing, but
   * the error UI still says "Enter a valid email" / "Must be ≥ 10",
   * because storage holds the literal DOM output ('' or 0) which is
   * neither undefined (the optional escape) nor a valid inner value.
   *
   * The fix is what makes the optional path reachable from the DOM
   * after any user interaction. Required fields keep their current
   * contract: '' / 0 stays in storage, validation continues to fail,
   * the user has to type a valid value to clear the error.
   */
  describe('validation cycle after clear', () => {
    it('z.email().optional() — typing invalid then clearing returns to valid', async () => {
      const schema = z.object({ email: z.email().optional() })
      const { app, input, form } = mountInputForPath(schema, 'email')
      apps.push(app)
      typeInto(input, 'not-an-email')
      await form.validateAsync()
      expect((form.errors.email ?? []).length).toBeGreaterThan(0)
      typeInto(input, '')
      await form.validateAsync()
      expect(form.errors.email).toEqual([])
      expect(form.values.email).toBeUndefined()
    })

    it('z.email() (required) — error persists after clear (regression)', async () => {
      const schema = z.object({ email: z.email() })
      const { app, input, form } = mountInputForPath(schema, 'email')
      apps.push(app)
      typeInto(input, 'not-an-email')
      await form.validateAsync()
      expect((form.errors.email ?? []).length).toBeGreaterThan(0)
      typeInto(input, '')
      await form.validateAsync()
      // Required string: clear writes '' to storage, which still fails
      // .email() parse. Error persists by design.
      expect((form.errors.email ?? []).length).toBeGreaterThan(0)
    })

    it('z.number().min(10).optional() — typing too-low then clearing returns to valid', async () => {
      const schema = z.object({ count: z.number().min(10).optional() })
      const { app, input, form } = mountInputForPath(schema, 'count', undefined, {
        numberModifier: true,
      })
      apps.push(app)
      typeInto(input, '3')
      blur(input)
      await form.validateAsync()
      expect((form.errors.count ?? []).length).toBeGreaterThan(0)
      typeInto(input, '')
      blur(input)
      await form.validateAsync()
      expect(form.errors.count).toEqual([])
      expect(form.values.count).toBeUndefined()
    })

    it('z.number().min(10) (required) — error persists after clear (regression)', async () => {
      const schema = z.object({ count: z.number().min(10) })
      const { app, input, form } = mountInputForPath(schema, 'count', undefined, {
        numberModifier: true,
      })
      apps.push(app)
      typeInto(input, '3')
      blur(input)
      await form.validateAsync()
      expect((form.errors.count ?? []).length).toBeGreaterThan(0)
      typeInto(input, '')
      blur(input)
      await form.validateAsync()
      // Required number: markBlank stays, storage holds slim default 0,
      // which still fails .min(10) parse. Error persists by design.
      expect((form.errors.count ?? []).length).toBeGreaterThan(0)
    })
  })
})
