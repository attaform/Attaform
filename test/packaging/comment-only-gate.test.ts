import { describe, expect, it } from 'vitest'
import { census, codeprint, fingerprint, vueprint } from '../../scripts/check-comment-only.mjs'

/**
 * `scripts/check-comment-only.mjs` exists to let a reviewer trust "I only
 * touched comments" on a branch too large to read. A gate that cannot fail
 * is worse than no gate, because it converts an unverified claim into a
 * verified-looking one, so each property it asserts is pinned here in both
 * directions.
 *
 * The cases are not hypothetical. Every one of them fired during the first
 * comment cleanup (#646): the template-literal pair is the
 * `TOAST_AMBIENT_DTS` shape that caught three of my own edits, and the
 * template-literal-type pair is why the implementation uses the parser
 * rather than `ts.createScanner`.
 */
describe('check-comment-only: the code fingerprint', () => {
  it('ignores an edited comment', () => {
    const before = '// old wording\nexport const a = 1\n'
    const after = '// completely different wording\nexport const a = 1\n'
    expect(codeprint(after)).toBe(codeprint(before))
  })

  it('ignores an edited docblock, which TypeScript parses into real AST nodes', () => {
    const before = '/** Old. */\nexport function f(): void {}\n'
    const after =
      '/**\n * New, and much longer.\n * @remarks with a tag.\n */\nexport function f(): void {}\n'
    expect(codeprint(after)).toBe(codeprint(before))
  })

  it('catches a one-character change to code', () => {
    expect(codeprint('export const a = 1\n')).not.toBe(codeprint('export const a = 2\n'))
  })

  it('catches a deleted line of code hidden under a comment rewrite', () => {
    const before = '// note\nconst a = 1\nconst b = 2\n'
    const after = '// a longer note that pads the diff\nconst a = 1\n'
    expect(codeprint(after)).not.toBe(codeprint(before))
  })

  it('catches a "comment" edited inside a template literal, which is emitted code', () => {
    const before = 'export const DTS = `\n/** Shows on hover. */\ndeclare const x: number\n`\n'
    const after = 'export const DTS = `\n/** Different hover text. */\ndeclare const x: number\n`\n'
    expect(codeprint(after)).not.toBe(codeprint(before))
  })

  it('catches a "comment" edited inside a regex character class', () => {
    const before = 'export const re = /[/*a]/\n'
    const after = 'export const re = /[/*b]/\n'
    expect(codeprint(after)).not.toBe(codeprint(before))
  })

  it('stays synchronised past a template literal type, where a raw scanner does not', () => {
    // The desync shape: a backtick inside a following COMMENT gets read as
    // template content once the scanner loses its place at `TemplateHead`.
    const before = 'type P = `a${string}b`\n// mentions `a code span` in prose\nconst x = 1\n'
    const after =
      'type P = `a${string}b`\n// rewritten, still mentions `a code span`\nconst x = 1\n'
    expect(codeprint(after)).toBe(codeprint(before))
    expect(codeprint(before)).not.toBe(codeprint('type P = `a${string}c`\nconst x = 1\n'))
  })
})

describe('check-comment-only: single-file components', () => {
  const sfc = (script: string, template: string, style = '.a { color: red; }') =>
    `<script setup lang="ts">\n${script}\n</script>\n\n<template>\n${template}\n</template>\n\n<style scoped>\n${style}\n</style>\n`

  it('ignores a comment change inside the script block', () => {
    const before = sfc('// old\nconst a = 1', '<div />')
    const after = sfc('// new and longer\nconst a = 1', '<div />')
    expect(vueprint(after)).toBe(vueprint(before))
  })

  it('ignores an HTML comment change inside the template', () => {
    const before = sfc('const a = 1', '<!-- old -->\n<div />')
    const after = sfc('const a = 1', '<!-- new, much longer -->\n<div />')
    expect(vueprint(after)).toBe(vueprint(before))
  })

  it('catches a one-character change to a template attribute', () => {
    const before = sfc('const a = 1', '<div class="chip" />')
    const after = sfc('const a = 1', '<div class="chips" />')
    expect(vueprint(after)).not.toBe(vueprint(before))
  })

  it('catches a change to the style block', () => {
    const before = sfc('const a = 1', '<div />', '.a { color: red; }')
    const after = sfc('const a = 1', '<div />', '.a { color: blue; }')
    expect(vueprint(after)).not.toBe(vueprint(before))
  })

  it('catches a token change in the second of two script blocks', () => {
    const two = (n: number) =>
      `<script lang="ts">\nexport default {}\n</script>\n<script setup lang="ts">\nconst a = ${n}\n</script>\n<template><div /></template>\n`
    expect(vueprint(two(2))).not.toBe(vueprint(two(1)))
  })

  it('routes .vue through vueprint and everything else through codeprint', () => {
    const text = '<script setup lang="ts">\nconst a = 1\n</script>\n<template><div /></template>\n'
    expect(fingerprint('App.vue', text)).toBe(vueprint(text, 'App.vue'))
    expect(fingerprint('a.ts', 'const a = 1\n')).toBe(codeprint('const a = 1\n', 'a.ts'))
  })
})

describe('check-comment-only: the directive census', () => {
  it('catches a dropped @__PURE__, which the fingerprint cannot see', () => {
    const before = 'const x = /* @__PURE__ */ f()\n'
    const after = 'const x = f()\n'
    // The fingerprint agrees, which is exactly why the census has to exist:
    // `@__PURE__` is a comment, and losing it changes tree-shaking.
    expect(codeprint(after)).toBe(codeprint(before))
    expect(census(after)).not.toBe(census(before))
  })

  it('catches a dropped eslint-disable', () => {
    const before = '// eslint-disable-next-line no-console\nconsole.log(1)\n'
    const after = '// a plain comment now\nconsole.log(1)\n'
    expect(codeprint(after)).toBe(codeprint(before))
    expect(census(after)).not.toBe(census(before))
  })

  it('is unmoved by ordinary prose', () => {
    const before = '// one wording\nconst a = 1\n'
    const after = '// another wording entirely\nconst a = 1\n'
    expect(census(after)).toBe(census(before))
  })
})
