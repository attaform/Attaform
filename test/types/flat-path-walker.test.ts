import { describe, expectTypeOf, it } from 'vitest'
import type { PartialFlatPath } from '../../src/runtime/types/types-core'
import type { RegisterFlatPath } from '../../src/runtime/types/types-api'

/**
 * Characterization test for the two `*FlatPath` walkers. The two
 * share a recursion skeleton and only diverge at container / array-
 * root emission: `PartialFlatPath` enumerates every reachable container
 * (so a consumer can address the container with `setValue`,
 * `form.values.<path>`, etc.), while `RegisterFlatPath` skips
 * containers because `v-register` only binds onto leaves.
 *
 * These pins enumerate the divergence so the upcoming `FlatPathBuilder`
 * unification (TYPES-D2) preserves both surfaces byte-for-byte. Each
 * assertion narrows down to "this exact string is / isn't a member of
 * the walker's output union" via `Extract`, which side-steps the
 * `${number}` distribution that makes raw `toEqualTypeOf` brittle.
 */

describe('PartialFlatPath — container + array-root + leaf enumeration', () => {
  it('emits container + leaf for nested object', () => {
    type Form = { user: { email: string } }
    type Paths = PartialFlatPath<Form>
    expectTypeOf<Extract<Paths, 'user'>>().toEqualTypeOf<'user'>()
    expectTypeOf<Extract<Paths, 'user.email'>>().toEqualTypeOf<'user.email'>()
  })

  it('emits root + indexed for primitive arrays', () => {
    type Form = { tags: string[] }
    type Paths = PartialFlatPath<Form>
    expectTypeOf<Extract<Paths, 'tags'>>().toEqualTypeOf<'tags'>()
    expectTypeOf<Extract<Paths, `tags.${number}`>>().toEqualTypeOf<`tags.${number}`>()
  })

  it('emits root + indexed + leaf for arrays of objects', () => {
    type Form = { rows: Array<{ sku: string }> }
    type Paths = PartialFlatPath<Form>
    expectTypeOf<Extract<Paths, 'rows'>>().toEqualTypeOf<'rows'>()
    expectTypeOf<Extract<Paths, `rows.${number}`>>().toEqualTypeOf<`rows.${number}`>()
    expectTypeOf<Extract<Paths, `rows.${number}.sku`>>().toEqualTypeOf<`rows.${number}.sku`>()
  })

  it('emits primitive leaf at top level', () => {
    type Form = { name: string }
    type Paths = PartialFlatPath<Form>
    expectTypeOf<Extract<Paths, 'name'>>().toEqualTypeOf<'name'>()
  })

  it('emits deep container + leaf paths', () => {
    type Form = { a: { b: { c: { d: string } } } }
    type Paths = PartialFlatPath<Form>
    expectTypeOf<Extract<Paths, 'a'>>().toEqualTypeOf<'a'>()
    expectTypeOf<Extract<Paths, 'a.b'>>().toEqualTypeOf<'a.b'>()
    expectTypeOf<Extract<Paths, 'a.b.c'>>().toEqualTypeOf<'a.b.c'>()
    expectTypeOf<Extract<Paths, 'a.b.c.d'>>().toEqualTypeOf<'a.b.c.d'>()
  })
})

describe('RegisterFlatPath — leaf-only enumeration (no containers)', () => {
  it('skips container for nested object, emits only the leaf', () => {
    type Form = { user: { email: string } }
    type Paths = RegisterFlatPath<Form>
    // The bare container path is NOT registrable — v-register binds onto
    // an `<input>` / `<select>` / `<textarea>` element backed by a leaf.
    expectTypeOf<Extract<Paths, 'user'>>().toEqualTypeOf<never>()
    expectTypeOf<Extract<Paths, 'user.email'>>().toEqualTypeOf<'user.email'>()
  })

  it('emits root + indexed for primitive arrays (multi-select / multi-checkbox)', () => {
    type Form = { tags: string[] }
    type Paths = RegisterFlatPath<Form>
    // Primitive arrays admit the array-root path — a `<select multiple>`
    // or grouped checkboxes register onto the array itself.
    expectTypeOf<Extract<Paths, 'tags'>>().toEqualTypeOf<'tags'>()
    expectTypeOf<Extract<Paths, `tags.${number}`>>().toEqualTypeOf<`tags.${number}`>()
  })

  it('emits ONLY the deep leaf for arrays of objects (no array root, no element container)', () => {
    type Form = { rows: Array<{ sku: string }> }
    type Paths = RegisterFlatPath<Form>
    // Neither the array root nor the per-element container are leaves;
    // both get skipped.
    expectTypeOf<Extract<Paths, 'rows'>>().toEqualTypeOf<never>()
    expectTypeOf<Extract<Paths, `rows.${number}`>>().toEqualTypeOf<never>()
    expectTypeOf<Extract<Paths, `rows.${number}.sku`>>().toEqualTypeOf<`rows.${number}.sku`>()
  })

  it('emits primitive leaf at top level', () => {
    type Form = { name: string }
    type Paths = RegisterFlatPath<Form>
    expectTypeOf<Extract<Paths, 'name'>>().toEqualTypeOf<'name'>()
  })

  it('skips every intermediate container, emits only the deepest leaf', () => {
    type Form = { a: { b: { c: { d: string } } } }
    type Paths = RegisterFlatPath<Form>
    expectTypeOf<Extract<Paths, 'a'>>().toEqualTypeOf<never>()
    expectTypeOf<Extract<Paths, 'a.b'>>().toEqualTypeOf<never>()
    expectTypeOf<Extract<Paths, 'a.b.c'>>().toEqualTypeOf<never>()
    expectTypeOf<Extract<Paths, 'a.b.c.d'>>().toEqualTypeOf<'a.b.c.d'>()
  })
})
