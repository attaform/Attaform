import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zodV4Adapter } from '../../src/runtime/adapters/zod-v4/adapter'
import { canonicalizePath } from '../../src/runtime/core/paths'
import { unset } from '../../src/runtime/core/unset'
import { substituteUnsetSentinels, walkUnsetSentinels } from '../../src/runtime/core/unset-walker'
import type { AbstractSchema } from '../../src/runtime/types/types-api'
import type { GenericForm } from '../../src/runtime/types/types-core'

/**
 * Characterization tests for the two unset-walker entry points. Pins
 * the behaviours that DIVERGE between them (the construction-time
 * `walkUnsetSentinels` synthesizes schema-only keys and auto-marks
 * numeric leaves; the setValue-time `substituteUnsetSentinels` trusts
 * the caller's shape and does neither) plus the contracts they SHARE
 * (explicit-unset expansion, DU stubbing, reference stability). Guards
 * the shared-core refactor that folds both onto one walker behind a
 * `synthesizeSchemaKeys` flag.
 */
function adapterFor(schema: z.ZodObject): AbstractSchema<GenericForm, GenericForm> {
  return zodV4Adapter(schema)('f', {
    maxRecursionDepth: 64,
  }) as unknown as AbstractSchema<GenericForm, GenericForm>
}

const keyFor = (segments: (string | number)[]): string => canonicalizePath(segments).key

describe('walkUnsetSentinels — construction-time walk (synthesizes schema keys, auto-marks numeric)', () => {
  it('synthesizes schema-only keys and auto-marks the unspecified numeric leaf', () => {
    const schema = adapterFor(z.object({ name: z.string(), age: z.number() }))
    const result = walkUnsetSentinels({ name: 'a' }, schema)
    expect(result.cleanedValues).toEqual({ name: 'a', age: 0 })
    expect(result.paths).toEqual([keyFor(['age'])])
  })

  it('does NOT auto-mark an unspecified string leaf (no storage/display divergence)', () => {
    const schema = adapterFor(z.object({ name: z.string(), nick: z.string() }))
    const result = walkUnsetSentinels({ name: 'a' }, schema)
    expect(result.cleanedValues).toEqual({ name: 'a', nick: '' })
    expect(result.paths).toEqual([])
  })

  it('preserves an explicit consumer `undefined` key (does not fill from schema, does not mark)', () => {
    const schema = adapterFor(z.object({ name: z.string(), age: z.number() }))
    const result = walkUnsetSentinels({ name: undefined, age: 5 }, schema)
    expect(result.cleanedValues).toEqual({ name: undefined, age: 5 })
    expect('name' in (result.cleanedValues as Record<string, unknown>)).toBe(true)
    expect(result.paths).toEqual([])
  })

  it('auto-marks every numeric leaf reachable from root when values is undefined', () => {
    const schema = adapterFor(z.object({ name: z.string(), age: z.number() }))
    const result = walkUnsetSentinels(undefined, schema)
    expect(result.cleanedValues).toBeUndefined()
    expect(result.paths).toEqual([keyFor(['age'])])
  })

  it('is reference-stable when nothing is synthesized, marked, or substituted', () => {
    const schema = adapterFor(z.object({ name: z.string(), age: z.number() }))
    const values = { name: 'a', age: 5 }
    const result = walkUnsetSentinels(values, schema)
    expect(result.cleanedValues).toBe(values)
    expect(result.paths).toEqual([])
  })
})

describe('substituteUnsetSentinels — setValue-time walk (trusts caller, no synthesis, no auto-mark)', () => {
  it('does NOT synthesize schema-only keys for a partial payload', () => {
    const schema = adapterFor(z.object({ name: z.string(), age: z.number() }))
    const result = substituteUnsetSentinels({ name: 'a' }, [], schema)
    expect(result.cleanedValues).toEqual({ name: 'a' })
    expect('age' in (result.cleanedValues as Record<string, unknown>)).toBe(false)
    expect(result.paths).toEqual([])
  })

  it('passes an explicit `undefined` key through without marking', () => {
    const schema = adapterFor(z.object({ name: z.string() }))
    const result = substituteUnsetSentinels({ name: undefined }, [], schema)
    expect(result.cleanedValues).toEqual({ name: undefined })
    expect(result.paths).toEqual([])
  })

  it('does NOT auto-mark a present numeric leaf', () => {
    const schema = adapterFor(z.object({ age: z.number() }))
    const result = substituteUnsetSentinels({ age: 0 }, [], schema)
    expect(result.cleanedValues).toEqual({ age: 0 })
    expect(result.paths).toEqual([])
  })

  it('roots produced paths at the supplied prefix', () => {
    const schema = adapterFor(z.object({ cargo: z.object({ age: z.number() }) }))
    const result = substituteUnsetSentinels({ age: unset }, ['cargo'], schema)
    expect(result.cleanedValues).toEqual({ age: 0 })
    expect(result.paths).toEqual([keyFor(['cargo', 'age'])])
  })

  it('is reference-stable when no substitution happens', () => {
    const schema = adapterFor(z.object({ name: z.string(), age: z.number() }))
    const values = { name: 'a', age: 5 }
    const result = substituteUnsetSentinels(values, [], schema)
    expect(result.cleanedValues).toBe(values)
    expect(result.paths).toEqual([])
  })
})

describe('unset-walker — contracts shared by both entry points', () => {
  it('expands an explicit unset leaf to the slim default and marks the path', () => {
    const schema = adapterFor(z.object({ name: z.string(), age: z.number() }))
    const walked = walkUnsetSentinels({ name: 'a', age: unset }, schema)
    expect(walked.cleanedValues).toEqual({ name: 'a', age: 0 })
    expect(walked.paths).toEqual([keyFor(['age'])])

    const substituted = substituteUnsetSentinels({ age: unset }, [], schema)
    expect(substituted.cleanedValues).toEqual({ age: 0 })
    expect(substituted.paths).toEqual([keyFor(['age'])])
  })

  it('stubs a discriminated union under unset to a disc-only shape, marking only the discriminator', () => {
    const schema = adapterFor(
      z.object({
        notify: z.discriminatedUnion('channel', [
          z.object({ channel: z.literal('sms'), number: z.string() }),
          z.object({ channel: z.literal('email'), address: z.string() }),
        ]),
      })
    )
    const walked = walkUnsetSentinels({ notify: unset }, schema)
    const walkedNotify = (walked.cleanedValues as Record<string, Record<string, unknown>>).notify
    expect(Object.keys(walkedNotify)).toEqual(['channel'])
    expect(walked.paths).toEqual([keyFor(['notify', 'channel'])])

    const substituted = substituteUnsetSentinels({ notify: unset }, [], schema)
    const substitutedNotify = (substituted.cleanedValues as Record<string, Record<string, unknown>>)
      .notify
    expect(Object.keys(substitutedNotify)).toEqual(['channel'])
    expect(substituted.paths).toEqual([keyFor(['notify', 'channel'])])
  })

  it('passes opaque leaves (Date) through unchanged', () => {
    const schema = adapterFor(z.object({ when: z.date() }))
    const when = new Date('2020-01-01T00:00:00.000Z')
    const walked = walkUnsetSentinels({ when }, schema)
    expect((walked.cleanedValues as Record<string, unknown>).when).toBe(when)
    const substituted = substituteUnsetSentinels({ when }, [], schema)
    expect((substituted.cleanedValues as Record<string, unknown>).when).toBe(when)
  })
})
