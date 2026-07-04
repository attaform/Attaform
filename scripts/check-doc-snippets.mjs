#!/usr/bin/env node
/**
 * Doc-snippet staleness gate. Extracts every fenced `ts` / `vue` code
 * block that imports from `attaform` out of the docs, the published
 * Agent Skill, and the curated llms.txt template, then type-checks each
 * against the *built*
 * `dist/*.d.mts` — the exact surface a consumer sees. A docs example
 * that imports a symbol the library no longer exports (the drift that
 * prompted the schema-entry refactor) fails here instead of silently
 * misleading a reader or a low-context model.
 *
 * Scope — import-bearing blocks only. A block that imports from
 * `attaform` is asserting the public surface; a bare fragment
 * (`form.setValue(...)` with no import) is not independently
 * type-checkable and is deliberately skipped. This mirrors the origin
 * story: the failure mode is a wrong *import*, and an import lives in a
 * `ts` block or an SFC `<script setup>`, never in a template-only `vue`
 * fragment — so those self-exclude.
 *
 * Engine — one `tsc` pass over a generated fixture project, mirroring
 * `check:bundled-types`: same bundler-resolution tsconfig, same real
 * `dist` (built via `pnpm prepack` if stubbed). `vue` blocks contribute
 * their `<script setup>` (where the import + form wiring live); the
 * template is not type-checked (a missing `v-register` is a directive,
 * not a type error, so vue-tsc would add false positives for no signal).
 *
 * Usage:
 *   pnpm check:doc-snippets
 *
 * Side effects:
 *   - Builds `dist/` if missing/stubbed (`pnpm prepack`).
 *   - Regenerates `tests/fixtures/doc-snippets/.generated/*.ts`
 *     (gitignored) and runs `tsc` over them.
 *   - Exits non-zero on any compile error, remapped to the source
 *     markdown file + line.
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, relative, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const distDir = resolve(repoRoot, 'dist')
const sentinelDts = resolve(distDir, 'zod-v4.d.ts')
const fixtureRoot = resolve(repoRoot, 'tests/fixtures/doc-snippets')
const generatedDir = resolve(fixtureRoot, '.generated')
const tsconfigPath = resolve(fixtureRoot, 'tsconfig.json')

const docsDir = resolve(repoRoot, 'docs')
// The published Agent Skill (skills/attaform/SKILL.md) teaches the same
// `attaform` imports it documents; scanning it here type-checks the
// skill's code against the built surface, so it can't ship a stale
// import any more than a docs page can.
const skillsDir = resolve(repoRoot, 'skills')
// The curated llms.txt template carries hand-written `ts` blocks (the
// wizard "API at a glance", the Quick reference cheat-sheet) that live
// nowhere in docs/ — including it type-checks that curated code too.
const llmsTemplate = resolve(repoRoot, 'apps/site/scripts/llms.template.md')

const KEEP_LANGS = new Set(['ts', 'typescript', 'vue'])
const ATTAFORM_IMPORT = /\bfrom\s+['"]attaform(?:\/[\w-]+)?['"]/

// --- collect markdown sources (deterministic order) ---------------------
function collectMarkdown(dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...collectMarkdown(full))
    else if (name.endsWith('.md')) out.push(full)
  }
  return out
}

// --- fence parsing ------------------------------------------------------
// Any ```-prefixed line opens a block; a bare ``` closes it. Content
// inside a block is never re-scanned, so a ```ts shown literally inside
// another fence can't be mistaken for a real block.
function parseFencedBlocks(text) {
  const lines = text.split('\n')
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const open = /^```([A-Za-z][\w-]*)?/.exec(lines[i])
    if (open) {
      const lang = (open[1] || '').toLowerCase()
      const fenceLine = i + 1 // 1-based
      const body = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      blocks.push({ lang, fenceLine, body })
      i++ // skip the closing fence
    } else {
      i++
    }
  }
  return blocks
}

// The `<script setup>` inner content of a vue block, plus the source
// line its first line sits on. Null when the block has no script.
function extractVueScript(block) {
  const openIdx = block.body.findIndex((l) => /<script\b/.test(l))
  if (openIdx === -1) return null
  const closeIdx = block.body.findIndex((l, k) => k > openIdx && /<\/script>/.test(l))
  if (closeIdx === -1) return null
  return {
    lines: block.body.slice(openIdx + 1, closeIdx),
    // body[0] is at (fenceLine + 1); the inner's first line is body[openIdx + 1].
    startLine: block.fenceLine + 1 + (openIdx + 1),
  }
}

// Fixture line numbers (1-based) that belong to an `import`/`export … from
// 'attaform…'` statement — single- or multi-line. An error on one of these
// lines is real surface drift (a symbol or subpath the built dist no longer
// exposes); everything else is a narrative gap the tolerant gate accepts.
function attaformImportLineSet(fixtureText) {
  const lines = fixtureText.split('\n')
  const set = new Set()
  for (let i = 0; i < lines.length; i++) {
    if (!/\bfrom\s+['"]attaform(?:\/[\w-]+)?['"]/.test(lines[i])) continue
    set.add(i + 1)
    // A brace import wrapped across lines puts `from '…'` on its own line;
    // walk back to the opening `import {` so a bad member on any line counts.
    if (!/\b(?:import|export)\b/.test(lines[i])) {
      let k = i - 1
      while (k >= 0 && !/\b(?:import|export)\b/.test(lines[k])) set.add(k-- + 1)
      if (k >= 0) set.add(k + 1)
    }
  }
  return set
}

// --- generate fixtures --------------------------------------------------
rmSync(generatedDir, { recursive: true, force: true })
mkdirSync(generatedDir, { recursive: true })

const sources = collectMarkdown(docsDir)
if (existsSync(skillsDir)) sources.push(...collectMarkdown(skillsDir))
if (existsSync(llmsTemplate)) sources.push(llmsTemplate)

const fixtures = []
const stats = { ts: 0, vue: 0, files: new Set() }
let counter = 0

for (const file of sources) {
  const rel = relative(repoRoot, file)
  for (const block of parseFencedBlocks(readFileSync(file, 'utf8'))) {
    if (!KEEP_LANGS.has(block.lang)) continue
    if (!ATTAFORM_IMPORT.test(block.body.join('\n'))) continue

    let codeLines
    let codeStartLine
    if (block.lang === 'vue') {
      const script = extractVueScript(block)
      if (!script || !ATTAFORM_IMPORT.test(script.lines.join('\n'))) continue
      codeLines = script.lines
      codeStartLine = script.startLine
      stats.vue++
    } else {
      codeLines = block.body
      codeStartLine = block.fenceLine + 1
      stats.ts++
    }

    counter++
    const slug = rel.replace(/[^\w.-]+/g, '__').replace(/\.md$/, '')
    const fixtureName = `${String(counter).padStart(3, '0')}-${slug}.ts`
    // Line 1 is this header; the first code line is fixture line 2, which
    // maps back to `codeStartLine` in the source markdown.
    const contents = `// @source ${rel}:${block.fenceLine}\n${codeLines.join('\n')}\n`
    writeFileSync(join(generatedDir, fixtureName), contents, 'utf8')
    fixtures.push({
      fixtureName,
      sourceRel: rel,
      fenceLine: block.fenceLine,
      codeStartLine,
      lang: block.lang,
      surfaceLines: attaformImportLineSet(contents),
    })
    stats.files.add(rel)
  }
}

if (fixtures.length === 0) {
  console.error(
    '[check-doc-snippets] extracted 0 snippets — the fence parser or the attaform-import filter is broken\n' +
      '  (docs carry dozens of `import ... from "attaform"` blocks). Aborting rather than passing vacuously.',
  )
  process.exit(1)
}

// --- ensure a real bundle (not the unbuild --stub shim) -----------------
function distIsRealBundle() {
  try {
    // `unbuild --stub` writes `export * from "/app/src/..."`; a real
    // bundle imports from `./shared/...` chunks.
    return !readFileSync(sentinelDts, 'utf8').slice(0, 256).includes('/src/')
  } catch {
    return false
  }
}

if (!distIsRealBundle()) {
  console.log('[check-doc-snippets] dist/ missing or stubbed — building real bundle first')
  execSync('pnpm prepack', { cwd: repoRoot, stdio: 'inherit' })
}

// --- type-check ---------------------------------------------------------
console.log(
  `[check-doc-snippets] type-checking ${fixtures.length} doc snippets ` +
    `(${stats.ts} ts, ${stats.vue} vue) from ${stats.files.size} files against dist/*.d.mts`,
)

let tscOutput = ''
try {
  // `--pretty false` gives the compact `path(line,col): error TS…` form the
  // classifier below parses (and drops ANSI colour). tsc still exits non-zero
  // on tolerated narrative errors, so the pass/fail decision is ours, not its.
  execSync(`pnpm exec tsc --pretty false --project "${tsconfigPath}"`, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
} catch (err) {
  tscOutput = `${err.stdout || ''}${err.stderr || ''}`
}

// --- classify: attaform-surface drift (fail) vs narrative gap (tolerate) ---
// The tolerant gate (chosen deliberately) fails ONLY on errors that land on an
// `attaform` import line — a removed export, a wrong subpath, a missing default.
// API-shape drift is `check:bundled-types`' job; here the unique signal is
// "every documented `attaform` import still resolves". Narrative gaps — a block
// that reuses `schema`/`form` from an earlier block, references the multistep
// example cast, or imports a placeholder consumer file — are reported, not failed.
const byName = new Map(fixtures.map((f) => [f.fixtureName, f]))
const TSC_ERROR = /^(.*?\.ts)\((\d+),\d+\): error (TS\d+): (.*)$/
const surfaceErrors = []
const tolerated = []

for (const raw of tscOutput.split('\n')) {
  const match = TSC_ERROR.exec(raw.trim())
  if (!match) continue
  const [, pathStr, lineStr, code, message] = match
  const fixtureName = pathStr.split(/[\\/]/).pop()
  const fx = byName.get(fixtureName)
  const entry = { fx, line: Number(lineStr), code, message, raw: raw.trim() }
  // An error we can't attribute to a known fixture (the shim, a project-level
  // "no inputs" error) is treated as surface too, so infra breakage fails loudly.
  if (!fx || fx.surfaceLines.has(entry.line)) surfaceErrors.push(entry)
  else tolerated.push(entry)
}

function locate(entry) {
  if (!entry.fx) return entry.raw
  const sourceLine = entry.fx.codeStartLine + (entry.line - 2)
  return `${entry.fx.sourceRel}:${sourceLine}  ${entry.code}: ${entry.message}  [${entry.fx.lang} block @ ${entry.fx.sourceRel}:${entry.fx.fenceLine}]`
}

// --- tolerated breakdown (kept legible so "green" never hides real drift) ---
const BENIGN = {
  TS2304: 'undefined example identifier',
  TS18004: 'shorthand property not in scope',
  TS2307: 'placeholder / consumer module',
  TS7006: 'untyped example callback param',
}
const review = tolerated.filter((e) => !BENIGN[e.code])
const benignCounts = {}
for (const e of tolerated) if (BENIGN[e.code]) benignCounts[e.code] = (benignCounts[e.code] || 0) + 1
const toleratedFixtures = new Set(tolerated.map((e) => (e.fx ? e.fx.fixtureName : e.raw))).size

function printToleratedSummary() {
  if (!tolerated.length) return
  console.log(`  tolerated ${tolerated.length} narrative gap(s) across ${toleratedFixtures} snippet(s) (not surface drift):`)
  for (const [code, count] of Object.entries(benignCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(4)}× ${BENIGN[code]} (${code})`)
  }
  if (review.length) {
    console.log(`  ${review.length} typed mismatch(es) tolerated per the surface-only policy — worth an eyeball:`)
    for (const e of review) console.log(`    ${locate(e)}`)
  }
}

if (surfaceErrors.length) {
  console.error(
    `\n[check-doc-snippets] FAILED — ${surfaceErrors.length} attaform-surface error(s): a docs import no longer matches dist:\n`,
  )
  for (const e of surfaceErrors) console.error(`  ${locate(e)}`)
  console.error(
    '\n  Fix the doc to match the published surface (or the surface, if the doc is right).\n' +
      `  Extracted fixtures are on disk for inspection: ${relative(repoRoot, generatedDir)}/`,
  )
  printToleratedSummary()
  process.exit(1)
}

console.log(
  `[check-doc-snippets] ok — 0 attaform-surface errors across ${fixtures.length} snippets ` +
    `(${stats.ts} ts, ${stats.vue} vue) from ${stats.files.size} files`,
)
printToleratedSummary()
process.exit(0)
