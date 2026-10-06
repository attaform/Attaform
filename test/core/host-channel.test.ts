import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { z as z3 } from 'zod-v3'
import { zodAdapter as zodAdapterV4 } from '../../src/runtime/adapters/zod-v4'
import { zodAdapter as zodAdapterV3 } from '../../src/runtime/adapters/zod-v3'
import { createFormStore } from '../../src/runtime/core/create-form-store'
import { armDomBinding } from '../../src/runtime/core/dom-binding'
import { buildRegister } from '../../src/runtime/core/register-api'
import { canonicalizePath } from '../../src/runtime/core/paths'
import type {
  AbstractSchema,
  HostModifiers,
  RegisterOptions,
} from '../../src/runtime/types/types-api'
import type { GenericForm } from '../../src/runtime/types/types-core'

/**
 * The component-host write channel: a v-register component host's emits
 * get the native write contract (the binding site's modifiers, register
 * transforms, schema coercion, `.lazy` buffering) through the channel the
 * directive arms on the form's DOM binding.
 */

// Same structural unification as `host-numeric-clear.test.ts`: the two
// adapter factories carry version-divergent generic signatures, so the
// shared harness calls both through the curried AbstractSchema factory
// shape they each produce.
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
      string: z.object({ n: z.string() }),
      optionalString: z.object({ n: z.string().optional() }),
    },
  },
  {
    name: 'zod-v3',
    adapt: zodAdapterV3 as unknown as HostAdapter,
    schemas: {
      number: z3.object({ n: z3.number() }),
      string: z3.object({ n: z3.string() }),
      optionalString: z3.object({ n: z3.string().optional() }),
    },
  },
] as const

const KEY = canonicalizePath(['n']).key
const NONE: HostModifiers = {}

afterEach(() => {
  vi.restoreAllMocks()
})

describe.each(adapters)('component-host write channel [$name]', ({ adapt, schemas }) => {
  function host(
    schema: unknown,
    defaultValues: GenericForm,
    options?: RegisterOptions,
    { arm = true }: { arm?: boolean } = {}
  ) {
    const formKey = `host-ch-${Math.random().toString(36).slice(2)}`
    const abstract = adapt(schema)(formKey, { maxRecursionDepth: 64 })
    const state = createFormStore({ formKey, schema: abstract, defaultValues })
    const rv = buildRegister(state, 'host:inst')(['n'], options)
    const binding = arm ? armDomBinding(rv) : undefined
    const value = (): unknown => state.getValueAtPath(['n'])
    return { state, rv, binding, value }
  }

  describe('.number', () => {
    it('casts a numeric string emit to a number', () => {
      const { rv, value } = host(schemas.number, { n: 1 })
      expect(rv.setValueFromHost('42', { number: true })).toBe(true)
      expect(value()).toBe(42)
    })

    it('marks the field blank on an empty or non-numeric string', () => {
      const { state, rv, value } = host(schemas.number, { n: 1 })
      expect(rv.setValueFromHost('', { number: true })).toBe(true)
      expect(value()).toBe(0)
      expect(state.blankPaths.has(KEY)).toBe(true)

      rv.setValueFromHost('7', { number: true })
      expect(state.blankPaths.has(KEY)).toBe(false)
      rv.setValueFromHost('abc', { number: true })
      expect(value()).toBe(0)
      expect(state.blankPaths.has(KEY)).toBe(true)
    })

    it('refuses an overflow to Infinity and keeps the last finite value', () => {
      const { rv, value } = host(schemas.number, { n: 5 })
      expect(rv.setValueFromHost('1e309', { number: true })).toBe(false)
      expect(value()).toBe(5)
    })

    it('passes a non-string emit through unchanged', () => {
      const { rv, value } = host(schemas.number, { n: 1 })
      rv.setValueFromHost(9, { number: true })
      expect(value()).toBe(9)
    })
  })

  describe('transforms and coercion', () => {
    it('coerces a numeric string into a number leaf with no modifier', () => {
      const { rv, value } = host(schemas.number, { n: 1 })
      expect(rv.setValueFromHost('42', NONE)).toBe(true)
      expect(value()).toBe(42)
    })

    it('runs register transforms on the emitted value', () => {
      const { rv, value } = host(
        schemas.string,
        { n: '' },
        { transforms: [(v) => String(v).toUpperCase()] }
      )
      rv.setValueFromHost('ab', NONE)
      expect(value()).toBe('AB')
    })

    it('runs transforms on an empty string when the leaf accepts strings', () => {
      const { rv, value } = host(
        schemas.string,
        { n: 'x' },
        { transforms: [(v) => (v === '' ? 'empty' : v)] }
      )
      rv.setValueFromHost('', NONE)
      expect(value()).toBe('empty')
    })

    it('commits an async transform result once it resolves', async () => {
      let resolve: (v: unknown) => void = () => {}
      const { state, rv, value } = host(
        schemas.string,
        { n: '' },
        {
          transforms: [
            () =>
              new Promise((r) => {
                resolve = r
              }),
          ],
        }
      )
      expect(rv.setValueFromHost('ab', NONE)).toBe(true)
      expect(state.fieldTransformCounts.get(KEY)).toBe(1)
      expect(value()).toBe('')
      resolve('AB')
      await vi.waitFor(() => expect(value()).toBe('AB'))
      expect(state.fieldTransformCounts.get(KEY) ?? 0).toBe(0)
    })

    it('aborts the write on a throwing transform without throwing to the caller', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const { rv, value } = host(
        schemas.string,
        { n: 'kept' },
        {
          transforms: [
            () => {
              throw new Error('boom')
            },
          ],
        }
      )
      expect(() => rv.setValueFromHost('ab', NONE)).not.toThrow()
      expect(value()).toBe('kept')
      expect(error).toHaveBeenCalled()
    })

    it('routes null and undefined through the blank rule, skipping transforms', () => {
      const seen: unknown[] = []
      const { state, rv, value } = host(
        schemas.number,
        { n: 3 },
        { transforms: [(v) => (seen.push(v), v)] }
      )
      rv.setValueFromHost(null, NONE)
      expect(value()).toBe(0)
      expect(state.blankPaths.has(KEY)).toBe(true)
      rv.setValueFromHost(undefined, NONE)
      expect(state.blankPaths.has(KEY)).toBe(true)
      expect(seen).toEqual([])
    })

    it('writes undefined as a genuine value on an optional leaf', () => {
      const { state, rv, value } = host(schemas.optionalString, { n: 'x' })
      rv.setValueFromHost(undefined, NONE)
      expect(value()).toBeUndefined()
      expect(state.blankPaths.has(KEY)).toBe(false)
    })
  })

  describe('.lazy', () => {
    it('buffers emits while focus is inside the host and commits the last one on leave', () => {
      const { rv, binding, value } = host(schemas.string, { n: '' })
      const mods: HostModifiers = { lazy: true }
      binding?.hostChannel.markEditing(rv, true, mods)
      rv.setValueFromHost('a', mods)
      rv.setValueFromHost('ab', mods)
      expect(value()).toBe('')
      binding?.hostChannel.markEditing(rv, false, mods)
      expect(value()).toBe('ab')
    })

    it('commits immediately when focus is not inside the host', () => {
      const { rv, value } = host(schemas.string, { n: '' })
      rv.setValueFromHost('ab', { lazy: true })
      expect(value()).toBe('ab')
    })

    it('discards a buffered value on release', () => {
      const { rv, binding, value } = host(schemas.string, { n: 'kept' })
      const mods: HostModifiers = { lazy: true }
      binding?.hostChannel.markEditing(rv, true, mods)
      rv.setValueFromHost('typed', mods)
      binding?.hostChannel.release(rv)
      binding?.hostChannel.markEditing(rv, false, mods)
      expect(value()).toBe('kept')
    })

    it('holds a draft while one is buffered and storage has not moved', () => {
      const { rv, binding } = host(schemas.string, { n: '' })
      const mods: HostModifiers = { lazy: true }
      binding?.hostChannel.markEditing(rv, true, mods)
      expect(binding?.hostChannel.holdsDraft(rv)).toBe(false)
      rv.setValueFromHost('ab', mods)
      expect(binding?.hostChannel.holdsDraft(rv)).toBe(true)

      binding?.hostChannel.markEditing(rv, false, mods)
      expect(binding?.hostChannel.holdsDraft(rv)).toBe(false)
    })

    it('lets a write that moves storage win over the buffered value', () => {
      const { state, rv, binding, value } = host(schemas.string, { n: '' })
      const mods: HostModifiers = { lazy: true }
      binding?.hostChannel.markEditing(rv, true, mods)
      rv.setValueFromHost('typed', mods)
      state.setValueAtPath(['n'], 'programmatic')
      expect(binding?.hostChannel.holdsDraft(rv)).toBe(false)

      binding?.hostChannel.markEditing(rv, false, mods)
      expect(value()).toBe('programmatic')
    })

    it('buffers typing that follows a write that moved storage', () => {
      const { state, rv, binding, value } = host(schemas.string, { n: '' })
      const mods: HostModifiers = { lazy: true }
      binding?.hostChannel.markEditing(rv, true, mods)
      rv.setValueFromHost('typed', mods)
      state.setValueAtPath(['n'], 'programmatic')
      rv.setValueFromHost('programmatic!', mods)
      expect(binding?.hostChannel.holdsDraft(rv)).toBe(true)

      binding?.hostChannel.markEditing(rv, false, mods)
      expect(value()).toBe('programmatic!')
    })
  })

  describe('.trim', () => {
    it('writes the raw emit, then commits the trimmed form when focus leaves', () => {
      const { rv, binding, value } = host(schemas.string, { n: '' })
      const mods: HostModifiers = { trim: true }
      binding?.hostChannel.markEditing(rv, true, mods)
      rv.setValueFromHost('  ab ', mods)
      expect(value()).toBe('  ab ')
      binding?.hostChannel.markEditing(rv, false, mods)
      expect(value()).toBe('ab')
    })

    it('trims the buffered value under .lazy.trim', () => {
      const { rv, binding, value } = host(schemas.string, { n: '' })
      const mods: HostModifiers = { lazy: true, trim: true }
      binding?.hostChannel.markEditing(rv, true, mods)
      rv.setValueFromHost(' pw ', mods)
      expect(value()).toBe('')
      binding?.hostChannel.markEditing(rv, false, mods)
      expect(value()).toBe('pw')
    })
  })

  describe('setValueFromHostInput', () => {
    it('writes the value an input emit carries as an own property', () => {
      const { state, rv, value } = host(schemas.number, { n: 18 })
      expect(rv.setValueFromHostInput({ originalEvent: null, value: 42 }, NONE)).toBe(true)
      expect(value()).toBe(42)
      expect(state.getFieldRecord(['n'])?.interacted).toBe(true)
    })

    it('ignores a native Event, a primitive and an object without an own value', () => {
      const { rv, value } = host(schemas.number, { n: 18 })
      const inherited = Object.create({ value: 5 })
      expect(rv.setValueFromHostInput(new Event('input'), NONE)).toBe(false)
      expect(rv.setValueFromHostInput(42, NONE)).toBe(false)
      expect(rv.setValueFromHostInput(null, NONE)).toBe(false)
      expect(rv.setValueFromHostInput({ formattedValue: '5' }, NONE)).toBe(false)
      expect(rv.setValueFromHostInput(inherited, NONE)).toBe(false)
      expect(value()).toBe(18)
    })
  })

  describe('an unarmed store', () => {
    it('commits directly through the blank rule, with no transforms', () => {
      const { state, rv, value } = host(
        schemas.number,
        { n: 3 },
        { transforms: [() => 99] },
        { arm: false }
      )
      rv.setValueFromHost(7, NONE)
      expect(value()).toBe(7)
      rv.setValueFromHost('', NONE)
      expect(state.blankPaths.has(KEY)).toBe(true)
      expect(rv.setValueFromHostInput({ value: 5 }, NONE)).toBe(false)
    })
  })
})
