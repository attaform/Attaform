#!/usr/bin/env node
/**
 * Generate the AI-agent surface for the docs site (the llms.txt index, the
 * llms-full.txt dump, and a web-fetchable copy of the Agent Skill), and keep
 * the README + quick-start page's headline code single-sourced from one tested
 * snippet. Zero dependencies (Node built-ins only), so it can run in any build
 * environment without touching the dependency graph.
 *
 * Two output classes, two rules:
 *
 *   - `public/llms.txt` + `public/llms-full.txt` are BUILD ARTIFACTS. They are
 *     gitignored and rewritten on every run. `llms.txt` is the curated index
 *     (a template spine + a generated link map + the snippet's headline code);
 *     `llms-full.txt` is every doc page concatenated. Because the links come
 *     from the site's own navigation and the code comes from a type-checked
 *     snippet, neither can silently drift from the live site.
 *
 *   - `README.md` and `docs/getting-started/quick-start.md` are COMMITTED
 *     files whose headline code blocks are single-sourced from the same
 *     snippet, spliced between `@generated-start`/`@generated-end` markers.
 *     Default mode CHECKS them and exits non-zero if they have drifted (so a
 *     build fails loudly rather than shipping a stale front door); `--fix`
 *     rewrites them (run it after editing the snippet, then commit).
 *
 * Inputs: the canonical snippet SFC, the docs navigation (the sidebar's own
 * source of truth), every `docs/**` page's frontmatter, and package.json.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url)) // apps/site/scripts
const siteRoot = resolve(here, '..') // apps/site
const repoRoot = resolve(siteRoot, '../..') // repo root
const docsDir = resolve(repoRoot, 'docs')
const SITE_ORIGIN = 'https://attaform.dev'

const FIX = process.argv.includes('--fix')

// Docs directories excluded from both the index and the full-text dump: not
// part of the product's public reading surface. `e` is the AF## error-code
// reference — served from /e (not /docs), so the /docs-route mapping here
// doesn't apply to it.
const EXCLUDED_DIRS = new Set(['scorecard', 'e'])

function log(msg) {
  console.log(`[generate-llms] ${msg}`)
}

// ─── Snippet extraction ──────────────────────────────────────────────
//
// The canonical snippet is a real, type-checked SFC. Three projections come
// out of it: the whole SFC (for the README's one ```vue block), the script
// body (for the ```ts blocks), and the template (for the ```vue template
// blocks). A type error in the snippet fails `typecheck`; a stale import can
// never reach these outputs without first breaking the build.
function loadSnippet() {
  const path = resolve(siteRoot, 'docs-demos/quick-start/snippet.vue')
  const raw = readFileSync(path, 'utf8')

  const scriptMatch = raw.match(/<script setup lang="ts">\n([\s\S]*?)\n<\/script>/)
  if (!scriptMatch) throw new Error('snippet.vue: <script setup lang="ts"> block not found')
  const templateMatch = raw.match(/<template>\n([\s\S]*?)\n<\/template>/)
  if (!templateMatch) throw new Error('snippet.vue: <template> block not found')

  const script = dedent(scriptMatch[1])
  const template = `<template>\n${templateMatch[1]}\n</template>`
  // Whole SFC for the README, minus the leading maintainer comment.
  const sfc = raw.replace(/^<!--[\s\S]*?-->\n+/, '').trim()

  return { script, template, sfc }
}

// Strip the common leading indentation off a block so an extracted script
// reads as top-level module code regardless of its indentation inside the SFC.
function dedent(block) {
  const lines = block.split('\n')
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length)
  const min = indents.length ? Math.min(...indents) : 0
  return lines
    .map((l) => l.slice(min))
    .join('\n')
    .trim()
}

// ─── Docs navigation (the index's structure) ─────────────────────────
//
// The sidebar navigation is the single source of section order + titles. It is
// a pure data literal, so we lift it out of the TS module by bracket-matching
// and evaluate it directly rather than duplicating the ordering here.
function loadDocsNavigation() {
  const src = readFileSync(resolve(siteRoot, 'composables/useDocsNavigation.ts'), 'utf8')
  const anchor = src.indexOf('export const docsNavigation')
  if (anchor === -1) throw new Error('useDocsNavigation.ts: docsNavigation export not found')
  // Anchor past the `=` so the `[]` in the `: DocsSection[]` type annotation
  // isn't mistaken for the array literal.
  const eq = src.indexOf('=', anchor)
  const start = src.indexOf('[', eq)
  let depth = 0
  let end = -1
  for (let i = start; i < src.length; i++) {
    if (src[i] === '[') depth++
    else if (src[i] === ']' && --depth === 0) {
      end = i
      break
    }
  }
  if (end === -1) throw new Error('useDocsNavigation.ts: docsNavigation array not terminated')
  const literal = src.slice(start, end + 1)
  // The literal is valid JS (single quotes, trailing commas, unquoted keys,
  // line comments) but not JSON. It contains no runtime calls, so evaluating
  // it in a bare Function is safe for this repo-owned file.
  const value = new Function(`return (${literal})`)()
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((s) => typeof s.heading === 'string')
  ) {
    throw new Error('useDocsNavigation.ts: docsNavigation did not evaluate to non-empty sections')
  }
  return value
}

// ─── Docs frontmatter + body ─────────────────────────────────────────
const docCache = new Map()

// `rel` is a path under docs/ including the .md extension, e.g.
// "getting-started/quick-start.md".
function readDoc(rel) {
  if (docCache.has(rel)) return docCache.get(rel)
  const path = join(docsDir, rel)
  let doc = null
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8')
    const fm = {}
    let body = raw
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?/)
    if (m) {
      body = raw.slice(m[0].length)
      for (const line of m[1].split('\n')) {
        const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/)
        if (kv && !(kv[1] in fm)) fm[kv[1]] = stripQuotes(kv[2].trim())
      }
    }
    doc = { fm, body }
  }
  docCache.set(rel, doc)
  return doc
}

function stripQuotes(s) {
  return s.replace(/^(['"])([\s\S]*)\1$/, '$2')
}

function firstH1(body) {
  const m = body.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : null
}

// `to` is a route path (/docs/foo/bar or /demos); return its docs/ rel path or
// null for non-doc routes.
function relFromTo(to) {
  if (!to.startsWith('/docs/')) return null
  return `${to.slice('/docs/'.length)}.md`
}

// Recursively list every doc rel path, excluding the non-product directories.
function allDocRels() {
  const out = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        if (prefix === '' && EXCLUDED_DIRS.has(entry)) continue
        walk(full, prefix ? `${prefix}/${entry}` : entry)
      } else if (entry.endsWith('.md')) {
        out.push(prefix ? `${prefix}/${entry}` : entry)
      }
    }
  }
  walk(docsDir, '')
  return out.sort()
}

// ─── llms.txt: the curated index ─────────────────────────────────────
function buildDocIndex(nav) {
  const used = new Set()
  const sections = []

  for (const section of nav) {
    const lines = []
    // The directory this section maps to (from its first /docs/ link), so any
    // page in that directory the sidebar omits still lands in the index.
    let dir = null
    for (const item of section.links) {
      if (item.to && item.to.startsWith('/docs/')) {
        dir = item.to.split('/')[2]
        break
      }
    }

    for (const item of section.links) {
      if (item.subheading || !item.to) continue // subheadings are sidebar-only
      lines.push(indexLine(item.title, item.to, used))
    }

    if (dir) {
      for (const rel of allDocRels()) {
        if (!rel.startsWith(`${dir}/`) || used.has(rel)) continue
        const to = `/docs/${rel.replace(/\.md$/, '')}`
        const doc = readDoc(rel)
        if (!doc) continue
        const title = doc.fm.title || firstH1(doc.body) || rel
        lines.push(indexLine(title, to, used))
        log(`appended non-sidebar page to "${section.heading}": ${to}`)
      }
    }

    if (lines.length) sections.push(`## ${section.heading}\n\n${lines.join('\n')}`)
  }

  const unindexed = allDocRels().filter((rel) => !used.has(rel))
  if (unindexed.length) log(`not in index (full-text only): ${unindexed.join(', ')}`)

  return sections.join('\n\n')
}

function indexLine(title, to, used) {
  const url = `${SITE_ORIGIN}${to}`
  const rel = relFromTo(to)
  if (!rel) return `- [${title}](${url})`
  used.add(rel)
  const doc = readDoc(rel)
  const desc = doc?.fm.description
  return desc ? `- [${title}](${url}): ${desc}` : `- [${title}](${url})`
}

// ─── llms-full.txt: every page concatenated ──────────────────────────
function buildFullText(nav) {
  const ordered = []
  const seen = new Set()
  // Sidebar reading order first, then any remaining pages alphabetically.
  for (const section of nav) {
    for (const item of section.links) {
      const rel = item.to ? relFromTo(item.to) : null
      if (rel && !seen.has(rel) && readDoc(rel)) {
        ordered.push(rel)
        seen.add(rel)
      }
    }
  }
  for (const rel of allDocRels()) {
    if (!seen.has(rel)) {
      ordered.push(rel)
      seen.add(rel)
    }
  }

  const parts = [
    '# Attaform documentation',
    '',
    '> The full text of every Attaform documentation page, concatenated for AI agents. Regenerated from the docs on every build. The curated index lives at https://attaform.dev/llms.txt.',
  ]
  for (const rel of ordered) {
    const doc = readDoc(rel)
    const url = `${SITE_ORIGIN}/docs/${rel.replace(/\.md$/, '')}`
    // The body leads with its own `# H1`, so no synthetic title header; the
    // page's source URL rides as a footer.
    parts.push('\n---\n')
    parts.push(stripMdc(doc.body).trim())
    parts.push('')
    parts.push(`_Source: ${url}_`)
  }
  return `${parts.join('\n')}\n`
}

// Remove MDC component blocks (`::name{...}` ... `::`) from a page body. Every
// MDC block in these docs is an empty-bodied widget (live demo, meta strip,
// benchmark, install command), so removing them drops no prose. Fenced code is
// left untouched in case a snippet legitimately opens a line with `::`.
function stripMdc(body) {
  const out = []
  let skipping = false
  let inFence = false
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence
    if (!inFence && !skipping && /^::[a-z][\w-]*/.test(line)) {
      skipping = true
      continue
    }
    if (skipping) {
      if (/^::\s*$/.test(line)) skipping = false
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

// ─── Committed-file marker sync ───────────────────────────────────────
function replaceMarker(src, marker, lang, content, file) {
  const start = `<!-- @generated-start:${marker} -->`
  const end = `<!-- @generated-end:${marker} -->`
  const si = src.indexOf(start)
  const ei = src.indexOf(end)
  if (si === -1 || ei === -1) throw new Error(`${file}: @generated markers for "${marker}" missing`)
  if (ei < si) throw new Error(`${file}: @generated markers for "${marker}" out of order`)
  const block = `${start}\n\n\`\`\`${lang}\n${content}\n\`\`\`\n\n${end}`
  return src.slice(0, si) + block + src.slice(ei + end.length)
}

function syncCommitted(snippet) {
  const targets = [
    {
      file: 'README.md',
      blocks: [{ marker: 'quick-start', lang: 'vue', content: snippet.sfc }],
    },
    {
      file: 'docs/getting-started/quick-start.md',
      blocks: [
        { marker: 'quick-start-script', lang: 'ts', content: snippet.script },
        { marker: 'quick-start-template', lang: 'vue', content: snippet.template },
      ],
    },
  ]

  const drifted = []
  for (const target of targets) {
    const path = resolve(repoRoot, target.file)
    const src = readFileSync(path, 'utf8')
    let updated = src
    for (const b of target.blocks) {
      updated = replaceMarker(updated, b.marker, b.lang, b.content, target.file)
    }
    if (updated === src) continue
    if (FIX) {
      writeFileSync(path, updated)
      log(`synced ${target.file}`)
    } else {
      drifted.push(target.file)
    }
  }
  return drifted
}

// ─── Served Agent Skill ──────────────────────────────────────────────
//
// Mirror the package's Agent Skill (`skills/attaform/**`) into `public/`
// so an agent can be pointed at a URL without installing the package and
// digging through node_modules. The skill's `references/` links are
// relative, so the mirror keeps the same directory shape and they
// resolve on the web exactly as they do on disk. `public/skill.md` is a
// memorable top-level alias for the main file. All build artifacts,
// single-sourced from the git skill, so they cannot drift.
function writeSkillArtifacts() {
  const srcDir = resolve(repoRoot, 'skills/attaform')
  const outDir = resolve(siteRoot, 'public/skills/attaform')
  mkdirSync(join(outDir, 'references'), { recursive: true })

  const main = readFileSync(join(srcDir, 'SKILL.md'), 'utf8')
  writeFileSync(join(outDir, 'SKILL.md'), main)
  writeFileSync(resolve(siteRoot, 'public/skill.md'), main)

  const refsDir = join(srcDir, 'references')
  const refs = existsSync(refsDir) ? readdirSync(refsDir).filter((f) => f.endsWith('.md')) : []
  for (const f of refs) {
    writeFileSync(join(outDir, 'references', f), readFileSync(join(refsDir, f), 'utf8'))
  }
  log(`wrote public/skill.md + public/skills/attaform/** (${refs.length} reference file(s))`)
}

// ─── Per-page Markdown endpoints ─────────────────────────────────────
//
// Emit a cleaned Markdown copy of every docs page at
// `public/docs/<path>.md`, so each page has a fetchable raw-Markdown
// endpoint (attaform.dev/docs/<path>.md) beside its HTML and the in-page
// "copy as Markdown" control has one source to read. The same MDC
// stripper used for llms-full.txt runs so component blocks (live demos,
// meta strips) do not leak into the text; the page's own `# H1` stays as
// the title. Excluded dirs (via allDocRels) are skipped, matching the
// index and full-text dump.
function writePerPageMarkdown() {
  const outRoot = resolve(siteRoot, 'public/docs')
  let count = 0
  for (const rel of allDocRels()) {
    const doc = readDoc(rel)
    if (!doc) continue
    const outPath = join(outRoot, rel)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, `${stripMdc(doc.body).trim()}\n`)
    count++
  }
  log(`wrote public/docs/**/*.md (${count} page(s))`)
}

// ─── Run ─────────────────────────────────────────────────────────────
const snippet = loadSnippet()
const nav = loadDocsNavigation()

const template = readFileSync(resolve(here, 'llms.template.md'), 'utf8')
const docIndex = buildDocIndex(nav)
// Placeholders are HTML comments so Prettier never reformats them (it rewrites
// code inside ``` fences, which would mangle a fenced token). The generator
// emits the fences itself. Function replacers so a `$` in snippet code is not
// treated as a replacement pattern.
const llms = template
  .replace('<!-- @snippet:script -->', () => '```ts\n' + snippet.script + '\n```')
  .replace('<!-- @snippet:template -->', () => '```vue\n' + snippet.template + '\n```')
  .replace('<!-- @doc-index -->', () => docIndex)

const leftover = llms.match(/<!-- @(?:snippet:script|snippet:template|doc-index) -->/)
if (leftover) throw new Error(`generate-llms: unreplaced template placeholder ${leftover[0]}`)

writeFileSync(resolve(siteRoot, 'public/llms.txt'), `${llms.trim()}\n`)
writeFileSync(resolve(siteRoot, 'public/llms-full.txt'), buildFullText(nav))
log('wrote public/llms.txt + public/llms-full.txt')

writeSkillArtifacts()
writePerPageMarkdown()

const drifted = syncCommitted(snippet)
if (drifted.length) {
  console.error(
    `[generate-llms] out of sync with the snippet: ${drifted.join(', ')}\n` +
      '  run: pnpm --filter attaform-site generate:llms --fix (then commit)'
  )
  process.exit(1)
}
