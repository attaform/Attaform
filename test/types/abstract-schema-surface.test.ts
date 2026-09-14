import { describe, expectTypeOf, it } from 'vitest'
import type { AbstractSchema } from '../../src/runtime/types/types-api'

/**
 * The `AbstractSchema` member set, pinned against the two pages that
 * publish it as a contract for consumers to implement.
 *
 * This is enumeration drift, the shape that has now bitten three times
 * in the docs (`DisplayCtx`, `FormStatus`, and this). Four methods
 * — `getEmptyValueAtPath`, `isPreprocessOrCoerceLeaf`,
 * `isFixedObjectAtPath`, `entryKeyKindAtPath` — were added to the type
 * and to the pages' worked example, while the pages' CONTRACT BLOCK
 * and its "twelve required methods" count stayed where they were. A
 * consumer implementing from the block got a type error naming four
 * methods the page never mentioned.
 *
 * The optional hooks drifted further still: the pages listed two, and
 * `hasContainerOrRootRefine` / `hasDiscriminatedUnions` had been there
 * for some time. This very test found them, by failing to compile
 * against the two-hook union it was first written with.
 *
 * A member added or removed here fails `pnpm typecheck` (not `vitest`,
 * which erases `expectTypeOf`). When it does, update BOTH of these, in
 * the contract block, the prose counts, the frontmatter `description`,
 * and the `Required methods` / `Optional hooks` metaRows:
 *
 *   - docs/schemas/abstract-schema.md
 *   - docs/reference/custom-adapters.md
 *
 * A method also wants its own `###` section on each page. The contract
 * is implemented by people outside this repo, so an undocumented
 * required method is an unimplementable one.
 */

/** Every member the contract declares, required and optional. */
type Members = keyof AbstractSchema<Record<string, unknown>, Record<string, unknown>>

/** Every member REQUIRED of an implementor. */
type RequiredMembers = {
  [K in Members]-?: Record<string, never> extends Pick<
    AbstractSchema<Record<string, unknown>, Record<string, unknown>>,
    K
  >
    ? never
    : K
}[Members]

describe('the AbstractSchema surface the docs publish', () => {
  it('declares exactly the 15 required methods the contract pages list', () => {
    expectTypeOf<RequiredMembers>().toEqualTypeOf<
      | 'fingerprint'
      | 'getDefaultValues'
      | 'getDefaultAtPath'
      | 'getEmptyValueAtPath'
      | 'arrayShapeAtPath'
      | 'isLeafAtPath'
      | 'isOpaqueLeafAtPath'
      | 'isPreprocessOrCoerceLeaf'
      | 'isRequiredAtPath'
      | 'isFixedObjectAtPath'
      | 'entryKeyKindAtPath'
      | 'getSchemasAtPath'
      | 'getSlimPrimitiveTypesAtPath'
      | 'getUnionDiscriminatorAtPath'
      | 'validateAtPath'
    >()
  })

  it('declares exactly the 4 optional hooks, and no more', () => {
    expectTypeOf<Exclude<Members, RequiredMembers>>().toEqualTypeOf<
      | 'getFieldMetaAtPath'
      | 'needsAsyncValidation'
      | 'hasContainerOrRootRefine'
      | 'hasDiscriminatedUnions'
    >()
  })

  it('resolves the fingerprint asynchronously', () => {
    // The pages' worked example used to return a bare string here,
    // which only compiled because an undeclared example type made the
    // receiver `any`. An adapter author reading it wrote an
    // unassignable method.
    expectTypeOf<
      AbstractSchema<Record<string, unknown>, Record<string, unknown>>['fingerprint']
    >().returns.toEqualTypeOf<Promise<string>>()
  })
})
