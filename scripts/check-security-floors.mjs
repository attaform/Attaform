#!/usr/bin/env node
/**
 * Security-floor enforcement gate. Every `overrides` entry in
 * pnpm-workspace.yaml that is a caret floor (`^x.y.z`) exists to hold a
 * transitive dependency at or above the first patched version for an
 * advisory. This script walks what pnpm actually installed and fails if
 * any copy sits below its declared floor.
 *
 * Why this is not redundant with the override itself: an override is a
 * request, not a guarantee. A package that declares the same name in
 * BOTH `dependencies` and `peerDependencies` (@nuxt/ui does this for the
 * @tiptap cluster) can end up with the override rewriting the recorded
 * peer range in pnpm-lock.yaml while the already-locked snapshot keeps
 * resolving the vulnerable version. `pnpm install` then reports
 * "Already up to date" and the lockfile looks correct in review: the
 * overrides block lists the floor, and only the snapshot section
 * disagrees. The 2026-09 sweep hit exactly that and it took a disk-level
 * check to see it. This gate is that disk-level check, standing.
 *
 * Usage:
 *   pnpm check:security-floors
 *
 * Reads only the filesystem. No network, no install, no side effects.
 */
import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

/**
 * Pull the flat `overrides:` map out of pnpm-workspace.yaml. Hand-rolled
 * rather than pulling a YAML parser in: the block is a flat map of
 * scalars, comments are line-oriented, and the repo keeps its dependency
 * surface deliberately thin.
 */
function readOverrides() {
  const text = readFileSync(resolve(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l === 'overrides:')
  if (start === -1) throw new Error('pnpm-workspace.yaml has no `overrides:` block')
  const out = new Map()
  for (const line of lines.slice(start + 1)) {
    // A non-indented, non-blank line ends the block.
    if (line.trim() !== '' && !line.startsWith('  ')) break
    const m = /^ {2}(?!#)('([^']+)'|"([^"]+)"|[^:\s#][^:]*)\s*:\s*(.+?)\s*$/.exec(line)
    if (m === null) continue
    const key = m[2] ?? m[3] ?? m[1]
    out.set(key, m[4].replace(/^['"]|['"]$/g, ''))
  }
  return out
}

/**
 * Numeric version tuple. Prerelease tags are dropped (a floor is a
 * floor) and missing parts default to 0, so this also parses the
 * partial versions that appear in key selectors: `brace-expansion@^5`
 * carries the range `^5`, not `^5.0.0`.
 */
function parseVersion(v) {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v)
  return m === null ? null : [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/**
 * Caret semantics, including the 0.x rules npm uses: `^1.2.3` allows
 * <2.0.0, `^0.2.3` allows <0.3.0, `^0.0.3` allows only 0.0.3. The
 * upper bound matters here because a floor is scoped to its own major /
 * 0.x line, so a DIFFERENT major legitimately present in the tree must
 * not be judged against it.
 */
function caretRange(spec) {
  const base = parseVersion(spec)
  if (base === null) return null
  const [maj, min, pat] = base
  // A partial spec widens the window: `^5` is <6.0.0 and `^0.2` is
  // <0.3.0, regardless of what the omitted parts would have implied.
  const parts = (/^\d+(?:\.\d+)?(?:\.\d+)?/.exec(spec)?.[0] ?? '').split('.').length
  if (maj > 0) return { lower: base, upper: [maj + 1, 0, 0] }
  if (parts === 1) return { lower: base, upper: [1, 0, 0] }
  if (min > 0 || parts === 2) return { lower: base, upper: [0, min + 1, 0] }
  return { lower: base, upper: [0, 0, pat + 1] }
}

/**
 * Every REACHABLE installed copy, as name -> version -> Set(dependent).
 *
 * Reachability, not directory enumeration. `node_modules/.pnpm` keeps
 * orphaned stores around after a branch switch or a lockfile swap, and
 * `pnpm prune` does not reliably clear them, so enumerating that
 * directory reports versions nothing can actually resolve. The walk
 * below starts at the workspace importers and follows the symlink graph,
 * which is exactly the set of copies a running build or test can load.
 */
function readInstalled() {
  const pnpmDir = resolve(repoRoot, 'node_modules/.pnpm')
  if (!existsSync(pnpmDir)) {
    throw new Error('node_modules/.pnpm is missing. Run `pnpm install` first.')
  }

  const found = new Map()
  const record = (name, version, dependent) => {
    if (!found.has(name)) found.set(name, new Map())
    const copies = found.get(name)
    if (!copies.has(version)) copies.set(version, new Set())
    copies.get(version).add(dependent)
  }

  // Entry points: the workspace root plus every workspace package. Their
  // node_modules hold the direct links; everything else hangs off those.
  const roots = [resolve(repoRoot, 'node_modules')]
  const appsDir = resolve(repoRoot, 'apps')
  if (existsSync(appsDir)) {
    for (const app of readdirSync(appsDir)) {
      const nm = join(appsDir, app, 'node_modules')
      if (existsSync(nm)) roots.push(nm)
    }
  }

  const seen = new Set()
  const queue = roots.map((dir) => ({ dir, dependent: 'workspace' }))

  while (queue.length > 0) {
    const { dir, dependent } = queue.pop()
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const scopeOrName of entries) {
      if (scopeOrName === '.pnpm' || scopeOrName === '.bin') continue
      let names
      if (scopeOrName.startsWith('@')) {
        try {
          names = readdirSync(join(dir, scopeOrName)).map((n) => `${scopeOrName}/${n}`)
        } catch {
          continue
        }
      } else {
        names = [scopeOrName]
      }
      for (const name of names) {
        const pkgDir = join(dir, name)
        const pkgJson = join(pkgDir, 'package.json')
        if (!existsSync(pkgJson)) continue
        let pkg
        try {
          pkg = JSON.parse(readFileSync(pkgJson, 'utf8'))
        } catch {
          // An unreadable or partial package.json is an install artifact,
          // not a floor violation. The install gate owns that failure.
          continue
        }
        if (pkg.name !== name || typeof pkg.version !== 'string') continue

        // Identify the copy by its real store directory so the same
        // physical package reached by two paths is walked once.
        let realDir
        try {
          realDir = realpathSync(pkgDir)
        } catch {
          continue
        }
        record(name, pkg.version, dependent)
        if (seen.has(realDir)) continue
        seen.add(realDir)

        // The store layout is .pnpm/<id>/node_modules/<name>; a copy's own
        // dependencies are siblings under that same node_modules. Follow
        // that sibling directory ONLY inside the store: a workspace link
        // resolves to a real source directory, and stepping up from one
        // walks out of the repository (apps/bench-arena links `attaform`
        // to the repo root, whose parent holds unrelated sibling
        // projects). Every pushed directory is bounded to the repo.
        const inRepo = (p) => p === repoRoot || p.startsWith(repoRoot + '/')
        const store = resolve(realDir, name.startsWith('@') ? '../..' : '..')
        const inStore = store.startsWith(pnpmDir + '/')
        const label = inStore ? store.slice(pnpmDir.length + 1).replace(/\/node_modules$/, '') : 'workspace'
        const nested = join(realDir, 'node_modules')
        if (inRepo(nested) && existsSync(nested)) queue.push({ dir: nested, dependent: label })
        if (inStore && store !== realDir && existsSync(store)) {
          queue.push({ dir: store, dependent: label })
        }
      }
    }
  }
  return found
}

const overrides = readOverrides()
const installed = readInstalled()

const violations = []
const checked = []
const unenforceable = []

for (const [rawKey, spec] of overrides) {
  // Only caret floors are advisory floors. Exact pins ('@nuxt/devtools':
  // 3.4.1), alias values ($nuxt) and path-scoped keys (devframe>h3) are
  // compatibility pins with their own rationale, enforced by resolution
  // rather than by a minimum.
  if (rawKey.includes('>')) continue
  if (!spec.startsWith('^')) continue

  // A key may carry its own range selector: `brace-expansion@^2` floors
  // only the v2 line, because the v5 line has a separate patch.
  const at = rawKey.lastIndexOf('@')
  const hasSelector = at > 0
  const name = hasSelector ? rawKey.slice(0, at) : rawKey
  const selector = hasSelector ? caretRange(rawKey.slice(at + 1).replace(/^\^/, '')) : null

  const floor = caretRange(spec.slice(1))
  if (floor === null) {
    unenforceable.push(`${rawKey}: ${spec} (unparseable version)`)
    continue
  }

  const copies = installed.get(name)
  if (copies === undefined) {
    // The source dep floated past the range and the override is now a
    // no-op, or the package left the tree. Either way nothing vulnerable
    // is installed; the workspace comment says to revisit these.
    checked.push({ name: rawKey, spec, versions: [], stale: true })
    continue
  }

  const relevant = []
  for (const [version, where] of copies) {
    const parsed = parseVersion(version)
    if (parsed === null) continue
    // Scope to the line this floor governs: its own caret window, further
    // narrowed by an explicit key selector when present.
    if (compare(parsed, floor.upper) >= 0) continue
    if (selector !== null) {
      if (compare(parsed, selector.lower) < 0 || compare(parsed, selector.upper) >= 0) continue
    }
    relevant.push({ version, parsed, where })
  }

  for (const copy of relevant) {
    if (compare(copy.parsed, floor.lower) < 0) {
      // Drop the package's own .pnpm directory from the trace: it names
      // the offending copy, which the line above already reports. What
      // is worth printing is who pulled it in.
      const self = `${name.replace('/', '+')}@${copy.version}`
      const dependents = [...copy.where].filter((w) => !w.startsWith(self)).sort()
      violations.push({ name, version: copy.version, spec, where: dependents })
    }
  }
  checked.push({
    name: rawKey,
    spec,
    versions: relevant.map((c) => c.version).sort(),
    stale: relevant.length === 0,
  })
}

const label = (e) =>
  `  ${e.name.padEnd(22)} ${e.spec.padEnd(10)} ${
    e.stale ? 'no copy in range (override is a no-op)' : e.versions.join(', ')
  }`

console.log('Security floors declared in pnpm-workspace.yaml overrides:\n')
for (const entry of checked) console.log(label(entry))

if (unenforceable.length > 0) {
  console.log('\nNot enforceable by this gate:')
  for (const line of unenforceable) console.log(`  ${line}`)
}

if (violations.length > 0) {
  console.error(`\nFAIL: ${violations.length} installed package(s) sit below a declared floor.\n`)
  for (const v of violations) {
    console.error(`  ${v.name}@${v.version} violates floor ${v.spec}`)
    for (const w of v.where.slice(0, 6)) console.error(`      via ${w}`)
    if (v.where.length > 6) console.error(`      ... and ${v.where.length - 6} more`)
  }
  console.error(
    '\nAn override in pnpm-workspace.yaml is not taking effect. This happens when a\n' +
      'dependent declares the package in both `dependencies` and `peerDependencies`:\n' +
      'pnpm rewrites the recorded range but keeps the locked snapshot, and reports\n' +
      '"Already up to date". `pnpm install --force` does not shift it either.\n\n' +
      'To fix, force the cluster to re-resolve, then relax the pin:\n' +
      '  1. set the override to the EXACT patched version, e.g.\n' +
      "       '@tiptap/core': 3.31.3\n" +
      '  2. pnpm install\n' +
      '  3. set it back to the caret floor (^3.30.4) and pnpm install again\n' +
      '  4. re-run this gate\n'
  )
  process.exit(1)
}

console.log(`\nPASS: ${checked.length} floor(s) honoured by the installed tree.`)
