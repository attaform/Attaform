#!/usr/bin/env node
/**
 * Generates `.bestpractices.json` from `docs/scorecard/cii-best-practices-answers.md`.
 *
 * bestpractices.dev auto-discovers a `.bestpractices.json` at the repo root and
 * pre-fills the OpenSSF Passing-level submission form from it. The schema mirrors
 * what bestpractices.dev produces when you fetch `/projects/<N>.json`:
 * `<criterion>_status` and `<criterion>_justification` for every criterion,
 * plus a small block of project-level metadata (`name`, `homepage_url`, etc.).
 *
 * The markdown doc is the human-readable source of truth; this script regenerates
 * the JSON file whenever the doc changes. Run from the repo root:
 *
 *     node scripts/build-bestpractices-json.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'

const SRC = 'docs/scorecard/cii-best-practices-answers.md'
const DST = '.bestpractices.json'

const md = readFileSync(SRC, 'utf8')

// Match each ### block: heading line then Answer, optional URL/evidence, Notes.
// The URL/evidence line is absent on most N/A entries.
const blockRe = /^### \d+\. `([a-z_0-9]+)`:[^\n]*\n\n\*\*Answer:\*\* ([^.\n]+(?:\([^)]*\))?)\.\n(?:\*\*URL\/evidence:\*\* ([^\n]+)\n)?\*\*Notes:\*\* ([^\n]+(?:\n(?!### |## )[^\n]*)*)/gm

const out = {}
let count = 0
let m
while ((m = blockRe.exec(md)) !== null) {
  const [, id, answerRaw, urlEvidence, notes] = m
  const answer = answerRaw.trim()
  // bestpractices.dev accepts: Met, Unmet, N/A, ?
  // "Met (delegated)" is doc shorthand for Met where the obligation is
  // discharged via an upstream dependency; the form just sees Met.
  const statusMap = {
    'Met': 'Met',
    'Met (delegated)': 'Met',
    'Unmet': 'Unmet',
    'N/A': 'N/A',
  }
  const status = statusMap[answer]
  if (!status) {
    console.error(`! ${id}: unknown answer "${answer}", skipping`)
    continue
  }
  out[`${id}_status`] = status
  // Pack URL/evidence + notes into the single justification field.
  const tail = urlEvidence ? `\n\nEvidence: ${urlEvidence.trim()}` : ''
  out[`${id}_justification`] = `${notes.trim()}${tail}`
  count++
}

// Project-level metadata the form also reads.
out.name = 'Attaform'
out.description = 'Schema-driven Vue 3 / Nuxt forms library with Zod validation.'
out.homepage_url = 'https://github.com/attaform/Attaform'
out.repo_url = 'https://github.com/attaform/Attaform'
out.implementation_languages = 'TypeScript, Vue'
out.license = 'MIT'

writeFileSync(DST, JSON.stringify(out, null, 2) + '\n')
console.log(`Wrote ${DST}: ${count} criteria + project metadata`)
