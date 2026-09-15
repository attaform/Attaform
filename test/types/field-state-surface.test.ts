import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `reading-the-form/fields.md` is the reference for what a leaf carries,
 * and its five tables are the list a reader works from. They held 33 of
 * the 37 properties, and the page's own "33-property FieldState" count
 * agreed with its tables, so nothing looked wrong from inside the page.
 *
 * The four it missed were not filler. `disabled` is the read for
 * `useForm({ disabled })`, a feature the pitch page advertises.
 * `transforming`, `busy`, and `transformError` are the whole async-
 * `register`-transform surface, so a reader wiring a spinner reached for
 * `validating` and got the half that ignores transforms.
 *
 * `reference/types.md` had a third number, 31.
 *
 * So the table is tied to the type. The type is read out of the source
 * declaration rather than through TypeScript, because `expectTypeOf` is
 * erased by vitest and this check has to fail in `pnpm test` too.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

function read(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8')
}

/** Property names declared on `FieldState`, from the type's own block. */
function fieldStateProperties(): string[] {
  const source = read('src/runtime/types/types-api.ts')
  const start = source.indexOf('export type FieldState<Value = unknown> = {')
  expect(start, 'FieldState declaration moved or was renamed').toBeGreaterThan(-1)
  const end = source.indexOf('\n}', start)
  const block = source.slice(start, end)
  return [...block.matchAll(/^ {2}readonly ([A-Za-z]+)/gm)].map((m) => m[1] ?? '')
}

/** Property names in the leading cell of any markdown table row on a page. */
function documentedProperties(file: string): string[] {
  return [...read(file).matchAll(/^\| `([A-Za-z]+)`/gm)].map((m) => m[1] ?? '')
}

function markdownFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) markdownFiles(rel, out)
    else if (entry.name.endsWith('.md')) out.push(rel)
  }
  return out
}

describe('FieldState vs the page that tabulates it', () => {
  it('fields.md has a row for every property', () => {
    const declared = fieldStateProperties()
    expect(declared.length, 'FieldState went empty; the regex or the block moved').toBeGreaterThan(
      20
    )
    const documented = new Set(documentedProperties('docs/reading-the-form/fields.md'))
    expect(declared.filter((name) => !documented.has(name))).toEqual([])
  })

  it('every stated property count matches the type', () => {
    const expected = fieldStateProperties().length
    const wrong: string[] = []
    for (const file of markdownFiles('docs', [])) {
      read(file)
        .split('\n')
        .forEach((line, index) => {
          if (!line.includes('FieldState')) return
          for (const match of line.matchAll(/(\d+)[- ]propert(?:y|ies)/g)) {
            if (Number(match[1]) === expected) continue
            wrong.push(`${file}:${index + 1} says ${match[1]}, the type has ${expected}`)
          }
        })
    }
    expect(wrong).toEqual([])
  })
})
