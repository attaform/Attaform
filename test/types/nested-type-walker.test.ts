import { describe, expectTypeOf, it } from 'vitest'
import type { NestedReadType, NestedType } from '../../src/runtime/types/types-core'

/**
 * Characterization test for the two path-resolved-type walkers.
 * They share the descent skeleton (segment-by-segment, distributing
 * over union variants via KeyofUnion / ValueOfUnion), and diverge at
 * the leaf:
 *
 * - `NestedType` is the strict write-side resolver. Once the walk
 *   reaches the requested leaf, the resolved type is returned
 *   unchanged. Used by `setValue`'s value parameter and
 *   `form.fields.<path>`'s state map.
 * - `NestedReadType` is the read-side resolver. If the walk ever
 *   crossed an array index segment (`items.0.sku`, for instance),
 *   the leaf is widened with `| undefined` to reflect the runtime
 *   possibility of an out-of-bounds read. Used by
 *   `register(path).innerRef` and `form.toRef(path)`.
 *
 * These pins lock the per-walker behaviour at concrete shapes so the
 * upcoming `NestedTypeBuilder` evaluation (TYPES-D4) can confirm
 * parity before any changes ship.
 */

describe('NestedType — strict resolve (no `| undefined` from array crossings)', () => {
  it('resolves a nested object leaf to its exact type', () => {
    expectTypeOf<NestedType<{ user: { email: string } }, 'user.email'>>().toEqualTypeOf<string>()
  })

  it('resolves a deep leaf cleanly', () => {
    expectTypeOf<NestedType<{ a: { b: { c: number } } }, 'a.b.c'>>().toEqualTypeOf<number>()
  })

  it('resolves an array-element leaf WITHOUT widening to `| undefined`', () => {
    expectTypeOf<
      NestedType<{ items: Array<{ sku: string }> }, 'items.0.sku'>
    >().toEqualTypeOf<string>()
  })

  it('resolves an array-primitive element WITHOUT widening', () => {
    expectTypeOf<NestedType<{ tags: string[] }, 'tags.0'>>().toEqualTypeOf<string>()
  })

  it('distributes over discriminated unions at descent', () => {
    type Form = {
      cargo: { kind: 'dry'; fragile: boolean } | { kind: 'hazmat'; unNumber: string }
    }
    expectTypeOf<NestedType<Form, 'cargo.kind'>>().toEqualTypeOf<'dry' | 'hazmat'>()
  })

  it('returns the resolved type at the container path itself', () => {
    expectTypeOf<NestedType<{ user: { email: string } }, 'user'>>().toEqualTypeOf<{
      email: string
    }>()
  })

  it('resolves `never` for paths that escape the schema', () => {
    expectTypeOf<NestedType<{ a: string }, 'b'>>().toEqualTypeOf<never>()
  })
})

describe('NestedReadType — taint leaves with `| undefined` once an array index crosses', () => {
  it('resolves a non-array leaf without tainting', () => {
    expectTypeOf<
      NestedReadType<{ user: { email: string } }, 'user.email'>
    >().toEqualTypeOf<string>()
  })

  it('taints an array-element leaf with `| undefined`', () => {
    expectTypeOf<NestedReadType<{ items: Array<{ sku: string }> }, 'items.0.sku'>>().toEqualTypeOf<
      string | undefined
    >()
  })

  it('taints an array-primitive element with `| undefined`', () => {
    expectTypeOf<NestedReadType<{ tags: string[] }, 'tags.0'>>().toEqualTypeOf<string | undefined>()
  })

  it('does NOT taint when the walk never crosses an array index', () => {
    expectTypeOf<NestedReadType<{ a: { b: { c: number } } }, 'a.b.c'>>().toEqualTypeOf<number>()
  })

  it('keeps taint sticky once any segment was numeric', () => {
    // After items.0, every deeper segment carries the taint forward.
    expectTypeOf<
      NestedReadType<{ items: Array<{ child: { name: string } }> }, 'items.0.child.name'>
    >().toEqualTypeOf<string | undefined>()
  })

  it('distributes over discriminated unions at descent', () => {
    type Form = {
      cargo: { kind: 'dry'; fragile: boolean } | { kind: 'hazmat'; unNumber: string }
    }
    expectTypeOf<NestedReadType<Form, 'cargo.kind'>>().toEqualTypeOf<'dry' | 'hazmat'>()
  })

  it('resolves the array root WITHOUT tainting (no segment was numeric yet)', () => {
    expectTypeOf<NestedReadType<{ tags: string[] }, 'tags'>>().toEqualTypeOf<string[]>()
  })

  it('returns `never` for paths that escape the schema', () => {
    expectTypeOf<NestedReadType<{ a: string }, 'b'>>().toEqualTypeOf<never>()
  })
})
