import { describe, expectTypeOf, it } from 'vitest'
import type { DefaultValuesShape } from '../../src/runtime/types/types-core'
import type { Unset } from '../../src/runtime/core/unset'

/**
 * Compile-time tests for `DefaultValuesShape<T>`. Mirrors the shape of
 * `write-shape.test.ts` but adds the `Unset` widening at every primitive
 * leaf. Non-primitive leaves stay strict — passing `unset` against
 * `z.date()` is a TS error.
 *
 * Used by `UseFormConfiguration.defaultValues`, `setValue`'s value
 * parameter, and `reset`'s parameter (commit 7 wires those).
 */

describe('DefaultValuesShape — primitive leaf widening', () => {
  it('widens string to string | Unset', () => {
    expectTypeOf<DefaultValuesShape<string>>().toEqualTypeOf<string | Unset>()
  })

  it('widens number to number | Unset', () => {
    expectTypeOf<DefaultValuesShape<number>>().toEqualTypeOf<number | Unset>()
  })

  it('widens boolean to boolean | Unset', () => {
    expectTypeOf<DefaultValuesShape<boolean>>().toEqualTypeOf<boolean | Unset>()
  })

  it('widens bigint to bigint | Unset', () => {
    expectTypeOf<DefaultValuesShape<bigint>>().toEqualTypeOf<bigint | Unset>()
  })

  it('widens string literals to string | Unset', () => {
    expectTypeOf<DefaultValuesShape<'red' | 'green'>>().toEqualTypeOf<string | Unset>()
  })

  it('widens number literals to number | Unset', () => {
    expectTypeOf<DefaultValuesShape<42>>().toEqualTypeOf<number | Unset>()
  })
})

describe('DefaultValuesShape — non-primitive leaves admit Unset', () => {
  it('Date widens to Date | Unset', () => {
    expectTypeOf<DefaultValuesShape<Date>>().toEqualTypeOf<Date | Unset>()
  })

  it('RegExp widens to RegExp | Unset', () => {
    expectTypeOf<DefaultValuesShape<RegExp>>().toEqualTypeOf<RegExp | Unset>()
  })

  it('Map widens to Map | Unset', () => {
    expectTypeOf<DefaultValuesShape<Map<string, number>>>().toEqualTypeOf<
      Map<string, number> | Unset
    >()
  })

  it('Set widens to Set | Unset', () => {
    expectTypeOf<DefaultValuesShape<Set<string>>>().toEqualTypeOf<Set<string> | Unset>()
  })

  it('null and undefined pass through unchanged', () => {
    expectTypeOf<DefaultValuesShape<null>>().toEqualTypeOf<null>()
    expectTypeOf<DefaultValuesShape<undefined>>().toEqualTypeOf<undefined>()
  })
})

describe('DefaultValuesShape — recursion through containers', () => {
  it('object widens each primitive leaf independently AND admits Unset at its own level', () => {
    type Input = { name: string; age: number; alive: boolean }
    type Output =
      | {
          name: string | Unset
          age: number | Unset
          alive: boolean | Unset
        }
      | Unset
    expectTypeOf<DefaultValuesShape<Input>>().toEqualTypeOf<Output>()
  })

  it('nested objects recurse with Unset at every container level', () => {
    type Input = { user: { id: number; profile: { displayName: string } } }
    type Output =
      | {
          user:
            | {
                id: number | Unset
                profile: { displayName: string | Unset } | Unset
              }
            | Unset
        }
      | Unset
    expectTypeOf<DefaultValuesShape<Input>>().toEqualTypeOf<Output>()
  })

  it('unbounded array recurses on the element type AND admits Unset at its own level', () => {
    expectTypeOf<DefaultValuesShape<number[]>>().toEqualTypeOf<Array<number | Unset> | Unset>()
  })

  it('tuple positions widen independently AND admit Unset at the tuple level', () => {
    type Input = readonly [string, number, boolean]
    type Output = [string | Unset, number | Unset, boolean | Unset] | Unset
    expectTypeOf<DefaultValuesShape<Input>>().toEqualTypeOf<Output>()
  })

  it('Date inside an object admits Unset at both levels', () => {
    type Input = { joinedAt: Date; income: number }
    type Output = { joinedAt: Date | Unset; income: number | Unset } | Unset
    expectTypeOf<DefaultValuesShape<Input>>().toEqualTypeOf<Output>()
  })
})

describe('DefaultValuesShape — assignability for backward compatibility', () => {
  it('plain number is assignable to widened number | Unset', () => {
    const value: DefaultValuesShape<number> = 42
    expectTypeOf(value).toMatchTypeOf<number | Unset>()
  })

  it('plain string is assignable to widened string | Unset', () => {
    const value: DefaultValuesShape<string> = 'hello'
    expectTypeOf(value).toMatchTypeOf<string | Unset>()
  })

  it('object with plain number is assignable to widened object', () => {
    const value: DefaultValuesShape<{ count: number }> = { count: 0 }
    expectTypeOf(value).toMatchTypeOf<{ count: number | Unset }>()
  })
})

/**
 * Container-position widening — `unset` admitted anywhere, not just
 * at primitive leaves.
 *
 * The contract: `DefaultValuesShape<T>` adds `| Unset` at EVERY
 * recursable position (objects, arrays, tuples, records, DUs,
 * optional / nullable wrappers, non-recursable leaves like Date /
 * Map / Set / RegExp, and the root).
 *
 * Each assertion below checks "Unset is assignable to
 * DefaultValuesShape<...> at this position." Because the root itself
 * now admits `| Unset`, indexed access into the position needs to
 * strip the Unset arm first (`Exclude<..., Unset>`) — TypeScript
 * can't index into the Unset symbol arm.
 */

type Strip<T> = Exclude<T, Unset>

describe('DefaultValuesShape — Unset at container positions', () => {
  it('Unset admitted at the root', () => {
    type Schema = { name: string; age: number }
    expectTypeOf<Unset>().toMatchTypeOf<DefaultValuesShape<Schema>>()
  })

  it('Unset admitted at a bare object container', () => {
    type Schema = { profile: { name: string; age: number } }
    expectTypeOf<Unset>().toMatchTypeOf<Strip<DefaultValuesShape<Schema>>['profile']>()
  })

  it('Unset admitted at an array container', () => {
    type Schema = { tags: string[] }
    expectTypeOf<Unset>().toMatchTypeOf<Strip<DefaultValuesShape<Schema>>['tags']>()
  })

  it('Unset admitted at a tuple container', () => {
    type Schema = { coords: readonly [string, number] }
    expectTypeOf<Unset>().toMatchTypeOf<Strip<DefaultValuesShape<Schema>>['coords']>()
  })

  it('Unset admitted at a record container', () => {
    type Schema = { counts: Record<string, number> }
    expectTypeOf<Unset>().toMatchTypeOf<Strip<DefaultValuesShape<Schema>>['counts']>()
  })

  it('Unset admitted at an optional container', () => {
    type Schema = { profile?: { name: string } }
    expectTypeOf<Unset>().toMatchTypeOf<Strip<DefaultValuesShape<Schema>>['profile']>()
  })

  it('Unset admitted at a nullable container', () => {
    type Schema = { profile: { name: string } | null }
    expectTypeOf<Unset>().toMatchTypeOf<Strip<DefaultValuesShape<Schema>>['profile']>()
  })

  it('Unset admitted at a discriminated-union container', () => {
    type Schema = {
      cargo: { kind: 'boat'; length: number } | { kind: 'truck'; payload: number }
    }
    expectTypeOf<Unset>().toMatchTypeOf<Strip<DefaultValuesShape<Schema>>['cargo']>()
  })

  it('Unset admitted at a Date leaf', () => {
    type Schema = { joinedAt: Date }
    expectTypeOf<Unset>().toMatchTypeOf<Strip<DefaultValuesShape<Schema>>['joinedAt']>()
  })

  it('Unset admitted at a Map / Set / RegExp leaf', () => {
    type SchemaM = { m: Map<string, number> }
    type SchemaS = { s: Set<string> }
    type SchemaR = { r: RegExp }
    expectTypeOf<Unset>().toMatchTypeOf<Strip<DefaultValuesShape<SchemaM>>['m']>()
    expectTypeOf<Unset>().toMatchTypeOf<Strip<DefaultValuesShape<SchemaS>>['s']>()
    expectTypeOf<Unset>().toMatchTypeOf<Strip<DefaultValuesShape<SchemaR>>['r']>()
  })

  it('Unset admitted at every level of a nested object', () => {
    type Schema = { a: { b: { c: string } } }
    type LevelOne = Strip<DefaultValuesShape<Schema>>['a']
    type LevelTwo = Strip<LevelOne> extends { b: infer B } ? B : never
    expectTypeOf<Unset>().toMatchTypeOf<DefaultValuesShape<Schema>>()
    expectTypeOf<Unset>().toMatchTypeOf<LevelOne>()
    expectTypeOf<Unset>().toMatchTypeOf<LevelTwo>()
  })
})
