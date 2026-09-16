import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, expectTypeOf, it } from 'vitest'
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

/**
 * The published counts. Kept beside the type-level assertions below so a
 * member change fails `pnpm typecheck` there and the prose scan here.
 */
const REQUIRED_COUNT = 14
const OPTIONAL_COUNT = 4

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
  it('declares exactly the 14 required methods the contract pages list', () => {
    expectTypeOf<RequiredMembers>().toEqualTypeOf<
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

  it('no page states a count the contract does not have', () => {
    // The type-level assertions above fail `pnpm typecheck`, and their
    // docblock names two pages to update. That was not enough:
    // `reference/types.md` carried "12-method + 2-optional" through a
    // sweep that fixed both named pages, because nothing read the prose.
    // This does, across every page, so a third site cannot go quiet.
    const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
    const WORDS: Record<string, number> = {
      twelve: 12,
      thirteen: 13,
      fourteen: 14,
      fifteen: 15,
      sixteen: 16,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
    }
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`
        if (entry.isDirectory()) walk(rel)
        else if (entry.name.endsWith('.md')) files.push(rel)
      }
    }
    walk('docs')
    walk('skills')

    const num = (raw: string): number => WORDS[raw.toLowerCase()] ?? Number(raw)
    const wrong: string[] = []
    for (const file of files) {
      readFileSync(join(REPO_ROOT, file), 'utf8')
        .split('\n')
        .forEach((line, index) => {
          const mentionsContract =
            line.includes('AbstractSchema') ||
            /\bcontract\b/i.test(line) ||
            /required method/i.test(line)
          if (!mentionsContract) return
          for (const m of line.matchAll(/([A-Za-z]+|\d+)[- ](?:required )?methods?\b/gi)) {
            const n = num(m[1] ?? '')
            if (Number.isNaN(n) || n === REQUIRED_COUNT) continue
            wrong.push(
              `${file}:${index + 1} says ${m[1]} methods, the contract has ${REQUIRED_COUNT}`
            )
          }
          for (const m of line.matchAll(/([A-Za-z]+|\d+)[- ]optional(?: hooks?)?\b/gi)) {
            const n = num(m[1] ?? '')
            if (Number.isNaN(n) || n === OPTIONAL_COUNT) continue
            wrong.push(
              `${file}:${index + 1} says ${m[1]} optional, the contract has ${OPTIONAL_COUNT}`
            )
          }
        })
    }
    expect(wrong).toEqual([])
  })
})
