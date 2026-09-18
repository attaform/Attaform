#!/usr/bin/env node
/**
 * Prove a branch's changes are comment-only.
 *
 * Attaform's first comment cleanup (#646) rewrote 48,900 comment lines
 * across 632 files. "I only touched comments" is not reviewable at that
 * size, and it is not trustworthy either: three edits on that branch looked
 * like docblocks and were emitted code. This is what made the claim
 * checkable, so it ships rather than living in a scratch directory.
 *
 * Two independent checks, because neither covers the other.
 *
 * 1. CODE FINGERPRINT. Parse with the TypeScript parser and walk the AST
 *    down to its leaf tokens. A comment edit leaves that stream identical;
 *    eating a line of code, or changing one character of it, does not. The
 *    parser is used rather than a regex so comment-like text inside a
 *    string, template literal or regex is never mistaken for a comment.
 *    That is the case that actually bit: a JSDoc block inside
 *    `TOAST_AMBIENT_DTS` is the ambient `.d.ts` shipped into the docs
 *    playground's TypeScript worker, and rewriting it changes what the
 *    program emits.
 *
 *    NOT `ts.createScanner`. The raw scanner cannot continue past a
 *    `TemplateHead` without an explicit `reScanTemplateToken()`, so any
 *    file holding a template literal type desynchronizes and starts
 *    swallowing backtick-carrying COMMENT text as template content. It
 *    fired on comment-only edits to `src/runtime/types/*`, which is
 *    exactly where a docblock cleanup does its highest-value work.
 *
 *    A leaf's `getText()` starts at `getStart()`, which skips leading
 *    trivia, so ordinary comments never enter the stream. JSDoc is the one
 *    exception: TypeScript parses it into real AST nodes that
 *    `getChildren()` returns, so the JSDoc kind range is skipped
 *    explicitly. Sound only while `checkJs` is off, which it is
 *    (tsconfig.json sets neither `checkJs` nor `allowJs`), so JSDoc type
 *    tags in `.js` / `.mjs` are inert documentation. Tags that DO carry
 *    meaning are covered by check 2.
 *
 * 2. DIRECTIVE CENSUS. `@__PURE__`, `eslint-disable` and friends ARE
 *    comments, so check 1 is blind to losing one. `@__PURE__` in
 *    particular changes tree-shaking and would move the eager budget.
 *    Their per-file counts must not change.
 *
 * Neither check is a substitute for reading the diff. Both of the mistakes
 * that reached a commit during the cleanup were invisible here: a scratch
 * marker left in a markdown file, and a link rewrite that changed link text
 * as well as hrefs. The gate answers one question only, "did the code
 * change", and answers it exactly.
 *
 * Usage: node scripts/check-comment-only.mjs [baseRef]
 *        (default: the merge base with `main`)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { argv } from 'node:process'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ts = createRequire(join(ROOT, 'package.json'))('typescript')

const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 })

/**
 * `git show` for a path that may not exist at `base`, which is how an ADDED
 * file presents. Without silencing stderr, git's own `fatal: path ... does
 * not exist` reaches the terminal before this script's catch runs, so every
 * added file on a branch prints two lines: git's, then ours saying the same
 * thing more usefully.
 */
const gitShowQuiet = (ref, rel) =>
  execFileSync('git', ['show', `${ref}:${rel}`], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'ignore'],
  })

/** Extensions the TypeScript parser can fingerprint. Everything else is eyeballed. */
export const SCANNABLE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx|vue)$/

/**
 * Comment text that is not commentary. A closed list on purpose: a new
 * build-affecting pragma should arrive here with the change that introduces
 * it, rather than be caught by a heuristic that also fires on prose.
 */
export const DIRECTIVES = [
  '@__PURE__',
  '@__NO_SIDE_EFFECTS__',
  'eslint-disable',
  'eslint-enable',
  '@vitest-environment',
  '@vitest-environment-options',
  '@ts-expect-error',
  '@ts-ignore',
  '@ts-nocheck',
  'prettier-ignore',
  'v8 ignore',
  'istanbul ignore',
  'webpackChunkName',
  'vite-ignore',
  '@vite-ignore',
  '@internal',
  '@deprecated',
  'sourceMappingURL',
  '#!',
]

const FIRST_JSDOC = ts.SyntaxKind.FirstJSDocNode
const LAST_JSDOC = ts.SyntaxKind.LastJSDocNode

/** The leaf-token stream of one TypeScript program, as a comparable string. */
export function codeprint(text, fileName = 'f.ts') {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const out = []
  const walk = (node) => {
    if (node.kind >= FIRST_JSDOC && node.kind <= LAST_JSDOC) return
    const kids = node.getChildren(sf)
    if (kids.length === 0) {
      const t = node.getText(sf)
      if (t.length > 0) out.push(t)
      return
    }
    for (const k of kids) walk(k)
  }
  walk(sf)
  return out.join(' ')
}

const SFC_SCRIPT = /<script\b[^>]*>([\s\S]*?)<\/script>/gi

/**
 * An SFC is not one TypeScript program, so it gets its own fingerprint.
 * Each `<script>` block is codeprinted independently, because a block is a
 * complete program and concatenating two would produce a parse matching
 * neither. Everything outside them (template, style, custom blocks) is
 * compared as text with HTML comments stripped, so a `<!-- ... -->` edit
 * passes and a one-character change to markup or CSS does not.
 */
export function vueprint(text, fileName = 'f.vue') {
  const scripts = []
  let rest = ''
  let last = 0
  SFC_SCRIPT.lastIndex = 0
  for (let m = SFC_SCRIPT.exec(text); m !== null; m = SFC_SCRIPT.exec(text)) {
    scripts.push(codeprint(m[1], `${fileName}.${scripts.length}.ts`))
    rest += text.slice(last, m.index + m[0].indexOf('>') + 1)
    last = m.index + m[0].length - '</script>'.length
  }
  rest += text.slice(last)
  const markup = rest
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return `${scripts.length} ${scripts.join(' ')} ${markup}`
}

/** Dispatch on extension, so a caller never has to pick the right printer. */
export const fingerprint = (fileName, text) =>
  fileName.endsWith('.vue') ? vueprint(text, fileName) : codeprint(text, fileName)

/** Per-directive occurrence counts, as a comparable string. */
export const census = (text) => DIRECTIVES.map((d) => `${d}:${text.split(d).length - 1}`).join(' ')

/**
 * Compare every changed file against `base`. Returns the report rather than
 * printing it, so the suite can assert on it.
 */
export function checkCommentOnly(base) {
  const changed = git('diff', '--name-only', base, '--').trim().split('\n').filter(Boolean)
  const skipped = []
  const failures = []
  let checked = 0

  for (const rel of changed) {
    if (!SCANNABLE.test(rel)) {
      skipped.push(rel)
      continue
    }
    let before
    try {
      before = gitShowQuiet(base, rel)
    } catch {
      failures.push(`${rel}: ADDED or renamed, not a comment-only change`)
      continue
    }
    if (!existsSync(join(ROOT, rel))) {
      failures.push(`${rel}: DELETED, not a comment-only change`)
      continue
    }
    const after = readFileSync(join(ROOT, rel), 'utf8')
    checked += 1
    if (fingerprint(rel, before) !== fingerprint(rel, after)) {
      failures.push(`${rel}: CODE CHANGED (leaf-token stream differs)`)
    }
    const [cb, ca] = [census(before), census(after)]
    if (cb !== ca) {
      const moved = DIRECTIVES.map((d, i) => [d, cb.split(' ')[i], ca.split(' ')[i]])
        .filter(([, b, a]) => b !== a)
        .map(([d, b, a]) => `${d} ${b.split(':')[1]}->${a.split(':')[1]}`)
        .join(', ')
      failures.push(`${rel}: DIRECTIVE COUNT CHANGED (${moved})`)
    }
  }
  return { changed: changed.length, checked, skipped, failures }
}

const isMain = import.meta.url === pathToFileURL(realpathSync(argv[1])).href
if (isMain) {
  const base = argv[2] ?? git('merge-base', 'HEAD', 'main').trim()
  const { changed, checked, skipped, failures } = checkCommentOnly(base)
  console.log(`[check-comment-only] base ${base.slice(0, 8)}, ${changed} changed file(s)`)
  console.log(`[check-comment-only] fingerprint + directive census on ${checked} scannable file(s)`)
  if (skipped.length > 0) {
    console.log(
      `[check-comment-only] NOT machine-checked (${skipped.length}, review by eye): ` +
        skipped.join(', ')
    )
  }
  if (failures.length > 0) {
    console.error('\n[check-comment-only] FAILED:')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('[check-comment-only] ok, every scannable change is provably comment-only')
}
