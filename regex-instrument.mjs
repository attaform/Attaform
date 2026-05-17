// Patch Vite's installed config.js so the transform-plugin loop logs
// each filter call against the 7.2 MB `@vue/repl/monaco-editor`
// prebundle. Goal: identify which plugin's `transform.filter.code`
// regex catastrophic-backtracks on monaco's dense minified content
// and fix that plugin (or its filter shape) at the source.
//
// Logs three families:
//   [filter-trace] THREW plugin=<name> ...  — filter call raised
//   [filter-trace] SLOW  plugin=<name> ...  — filter took >5ms on ANY id
//   [filter-trace] MONACO plugin=<name> ... — every filter call on a
//     monaco-prebundle id, regardless of timing (verbose readout that
//     captures the per-plugin chain on the suspect file even when no
//     individual call is slow enough to trigger the SLOW threshold)
//
// Also: log every entry into `pluginContainer.transform` where the id
// references the monaco prebundle. Tells us whether the loop is being
// reached at all (vs. served from `cachedTransformMiddleware` before
// the loop fires).
//
// The patch is idempotent (marker comment) and reversible via the
// `make clean` flow (named volumes reset).

import { readFileSync, writeFileSync } from 'node:fs'

const path =
  '/app/node_modules/.pnpm/vite@7.3.3_@types+node@25.7.0_jiti@2.7.0_lightningcss@1.32.0_terser@5.47.1_yaml@2.9.0/node_modules/vite/dist/node/chunks/config.js'

const MARKER = '/*@@ATTAFORM_FILTER_TRACE@@*/'

let src = readFileSync(path, 'utf8')

// If a previous version of this patch is already in place, restore the
// original two-line block first so we land the new wrapper cleanly.
// Recognise the old block by the marker + the line that starts with
// `if (filter$1) {` (the only patched form we've shipped so far).
const oldPatchStart = `\t\t\tconst filter$1 = getCachedFilterForPlugin(plugin, "transform"); ${MARKER}\n\t\t\tif (filter$1) {`
const oldPatchEnd = `\t\t\t\tif (!__ok) continue;\n\t\t\t}`
if (src.includes(oldPatchStart)) {
  const startIdx = src.indexOf(oldPatchStart)
  const endIdx = src.indexOf(oldPatchEnd, startIdx)
  if (endIdx === -1) {
    console.error('[regex-instrument] found old patch start but not end — aborting')
    process.exit(1)
  }
  const original = `\t\t\tconst filter$1 = getCachedFilterForPlugin(plugin, "transform");\n\t\t\tif (filter$1 && !filter$1(id, code)) continue;`
  src = src.slice(0, startIdx) + original + src.slice(endIdx + oldPatchEnd.length)
  console.error('[regex-instrument] reverted previous patch; re-applying new version')
}

// Also undo any prior transform-entry patch (re-applied below).
const oldEntryPatch = `\tasync transform(code, id, options$1) { ${MARKER}\n\t\tif (typeof id === 'string' && id.includes('@vue_repl_monaco-editor')) console.error('[transform-trace] ENTER pluginContainer.transform id=' + id.slice(-120) + ' code.len=' + (code?.length||0));\n\t\tlet ssr = this.environment.config.consumer === "server";`
const cleanEntry = `\tasync transform(code, id, options$1) {\n\t\tlet ssr = this.environment.config.consumer === "server";`
if (src.includes(oldEntryPatch)) {
  src = src.replace(oldEntryPatch, cleanEntry)
}

const filterFind = `\t\t\tconst filter$1 = getCachedFilterForPlugin(plugin, "transform");\n\t\t\tif (filter$1 && !filter$1(id, code)) continue;`

if (!src.includes(filterFind)) {
  console.error('[regex-instrument] target snippet not found — config.js shape changed')
  process.exit(1)
}

const filterReplace = `\t\t\tconst filter$1 = getCachedFilterForPlugin(plugin, "transform"); ${MARKER}\n\t\t\t{\n\t\t\t\tconst __isMonaco = typeof id === 'string' && id.includes('@vue_repl_monaco-editor');\n\t\t\t\tif (filter$1) {\n\t\t\t\t\tconst __t0 = Date.now();\n\t\t\t\t\tlet __ok;\n\t\t\t\t\ttry { __ok = filter$1(id, code); }\n\t\t\t\t\tcatch (e) { console.error('[filter-trace] THREW plugin=' + plugin.name + ' id=' + (typeof id === 'string' ? id.slice(-120) : id) + ' code.len=' + (code?.length||0) + ' err=' + e.message); throw e; }\n\t\t\t\t\tconst __ms = Date.now() - __t0;\n\t\t\t\t\tif (__ms > 5) console.error('[filter-trace] SLOW plugin=' + plugin.name + ' ms=' + __ms + ' id=' + (typeof id === 'string' ? id.slice(-120) : id) + ' code.len=' + (code?.length||0) + ' pass=' + __ok);\n\t\t\t\t\telse if (__isMonaco) console.error('[filter-trace] MONACO plugin=' + plugin.name + ' ms=' + __ms + ' code.len=' + (code?.length||0) + ' pass=' + __ok);\n\t\t\t\t\tif (!__ok) continue;\n\t\t\t\t} else if (__isMonaco) {\n\t\t\t\t\tconsole.error('[filter-trace] MONACO plugin=' + plugin.name + ' (no filter, runs unconditionally) code.len=' + (code?.length||0));\n\t\t\t\t}\n\t\t\t}`

let patched = src.replace(filterFind, filterReplace)

// Also wrap the entry point of pluginContainer.transform so we know
// whether the loop runs on monaco at all.
const txEntryFind = `\tasync transform(code, id, options$1) {\n\t\tlet ssr = this.environment.config.consumer === "server";`

if (patched.includes(txEntryFind)) {
  const txEntryReplace = `\tasync transform(code, id, options$1) { ${MARKER}\n\t\tif (typeof id === 'string' && id.includes('@vue_repl_monaco-editor')) console.error('[transform-trace] ENTER pluginContainer.transform id=' + id.slice(-120) + ' code.len=' + (code?.length||0));\n\t\tlet ssr = this.environment.config.consumer === "server";`
  patched = patched.replace(txEntryFind, txEntryReplace)
}

writeFileSync(path, patched, 'utf8')
console.error('[regex-instrument] patched ' + path)
