import { describe, expectTypeOf, it } from 'vitest'
import type { DefaultValuesShape, WriteShape } from '../../src/runtime/types/types-core'
import type { Unset } from '../../src/runtime/core/unset'

/**
 * Characterization test for the two structural-shape walkers. They
 * share the recursion topology (object → mapped, tuple → positional,
 * array → recurse, primitive → terminal); the only divergence is that
 * `DefaultValuesShape` adds `| Unset` at every primitive (except
 * symbol / null / undefined) and at every container position.
 *
 * These pins lock the topology so the upcoming
 * `DefaultValuesShape = AugmentWithUnset<WriteShape<T>>` wrapper
 * (TYPES-D3) keeps both surfaces byte-for-byte. The `WriteShape`
 * arm also pins the primitive-literal widening (`'red' | 'green'`
 * collapses to `string`) that the runtime slim-primitive write
 * contract depends on.
 */

describe('WriteShape — primitive widening + structural preservation', () => {
  it('widens primitive literals to their primitive supertype', () => {
    expectTypeOf<WriteShape<{ color: 'red' | 'green' }>>().toEqualTypeOf<{ color: string }>()
    expectTypeOf<WriteShape<{ kind: 'on' }>>().toEqualTypeOf<{ kind: string }>()
    expectTypeOf<WriteShape<{ count: 42 }>>().toEqualTypeOf<{ count: number }>()
    expectTypeOf<WriteShape<{ ok: true }>>().toEqualTypeOf<{ ok: boolean }>()
  })

  it('preserves opaque leaves (Date, RegExp, Map, Set, function) unchanged', () => {
    expectTypeOf<WriteShape<Date>>().toEqualTypeOf<Date>()
    expectTypeOf<WriteShape<RegExp>>().toEqualTypeOf<RegExp>()
    expectTypeOf<WriteShape<Map<string, number>>>().toEqualTypeOf<Map<string, number>>()
    expectTypeOf<WriteShape<Set<string>>>().toEqualTypeOf<Set<string>>()
  })

  it('preserves tuple positions over readonly tuples', () => {
    expectTypeOf<WriteShape<readonly [string, number]>>().toEqualTypeOf<[string, number]>()
  })

  it('recurses into arrays of objects', () => {
    expectTypeOf<WriteShape<Array<{ sku: 'A' | 'B' }>>>().toEqualTypeOf<Array<{ sku: string }>>()
  })

  it('recurses into nested objects', () => {
    expectTypeOf<WriteShape<{ user: { age: 21 } }>>().toEqualTypeOf<{ user: { age: number } }>()
  })

  it('passes null / undefined / symbol through unchanged at leaves', () => {
    expectTypeOf<WriteShape<{ s: symbol }>>().toEqualTypeOf<{ s: symbol }>()
    expectTypeOf<WriteShape<{ n: null }>>().toEqualTypeOf<{ n: null }>()
    expectTypeOf<WriteShape<{ u: undefined }>>().toEqualTypeOf<{ u: undefined }>()
  })
})

describe('DefaultValuesShape — WriteShape topology + `| Unset` everywhere', () => {
  it('widens primitives AND adds `| Unset` at each non-symbol primitive leaf', () => {
    expectTypeOf<DefaultValuesShape<{ color: 'red' | 'green' }>>().toEqualTypeOf<
      { color: string | Unset } | Unset
    >()
    expectTypeOf<DefaultValuesShape<{ count: 42 }>>().toEqualTypeOf<
      { count: number | Unset } | Unset
    >()
    expectTypeOf<DefaultValuesShape<{ ok: true }>>().toEqualTypeOf<
      { ok: boolean | Unset } | Unset
    >()
  })

  it('preserves symbol leaves (no `| Unset` widening)', () => {
    // Symbol is excluded — the runtime sentinel never carries symbol
    // semantics, and `setValue('foo', unset)` shouldn't tempt the type
    // system into treating a symbol leaf as Unset-admissible.
    expectTypeOf<DefaultValuesShape<{ s: symbol }>>().toEqualTypeOf<{ s: symbol } | Unset>()
  })

  it('widens opaque leaves to `T | Unset`', () => {
    expectTypeOf<DefaultValuesShape<Date>>().toEqualTypeOf<Date | Unset>()
    expectTypeOf<DefaultValuesShape<RegExp>>().toEqualTypeOf<RegExp | Unset>()
  })

  it('admits `| Unset` at tuple positions AND on the tuple container', () => {
    expectTypeOf<DefaultValuesShape<readonly [string, number]>>().toEqualTypeOf<
      [string | Unset, number | Unset] | Unset
    >()
  })

  it('widens arrays — element gets Unset, array itself gets Unset', () => {
    expectTypeOf<DefaultValuesShape<{ tags: string[] }>>().toEqualTypeOf<
      { tags: Array<string | Unset> | Unset } | Unset
    >()
  })

  it('widens nested objects recursively', () => {
    expectTypeOf<DefaultValuesShape<{ user: { age: 21 } }>>().toEqualTypeOf<
      { user: { age: number | Unset } | Unset } | Unset
    >()
  })

  it('threads `| Unset` through arrays-of-objects', () => {
    expectTypeOf<DefaultValuesShape<{ rows: Array<{ sku: 'A' | 'B' }> }>>().toEqualTypeOf<
      { rows: Array<{ sku: string | Unset } | Unset> | Unset } | Unset
    >()
  })

  it('passes null / undefined through unchanged at leaves', () => {
    expectTypeOf<DefaultValuesShape<{ n: null }>>().toEqualTypeOf<{ n: null } | Unset>()
    expectTypeOf<DefaultValuesShape<{ u: undefined }>>().toEqualTypeOf<{ u: undefined } | Unset>()
  })
})
