import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ALLOWED_GLOBALS,
  FLOOR,
  KNOWN_PAST_FLOOR,
  LATE_METHODS,
  REGEX_FEATURES,
  SYNTAX_FEATURES,
  allowlistViolations,
  checkSource,
  pastFloor,
  reachableChunks,
  runtimeEntries,
} from '../../scripts/check-browser-floor.mjs'

/**
 * `scripts/check-browser-floor.mjs` stands between a regex lookbehind
 * and every iOS before 16.4 (#704). Nothing else in the repo runs code on
 * an old engine, so a gate that cannot fail would let the next one ship
 * the same way. Each check is pinned in both directions: the construct is
 * reported, and its safe neighbour is not.
 */
const features = (code: string): string[] => checkSource(code).map((f) => f.feature)

describe('check-browser-floor: syntax no bundler lowers', () => {
  it('reports a lookbehind in a regex literal, with file, line and versions', () => {
    const code = [
      'export function stem(key) {',
      '  const sanitized = key.trim()',
      "  return sanitized.replace(/^-+|(?<!-)-+$/g, '')",
      '}',
    ].join('\n')
    expect(checkSource(code, 'dist/shared/chunk.mjs')).toEqual([
      {
        file: 'dist/shared/chunk.mjs',
        line: 3,
        feature: 'regex lookbehind',
        since: 'Safari 16.4, Firefox 78',
      },
    ])
    expect(features('export const re = /(?<=a)b/')).toEqual(['regex lookbehind'])
  })

  it('reports a lookbehind in the string handed to RegExp(...)', () => {
    expect(features("export const re = new RegExp('(?<!x)')")).toEqual(['regex lookbehind'])
    expect(features("export const re = RegExp('(?<=x)', 'g')")).toEqual(['regex lookbehind'])
    expect(features('export const make = (name) => new RegExp(`(?<![\\\\w$])${name}`)')).toEqual([
      'regex lookbehind',
    ])
  })

  it('reports the v and d flags, in a literal and in RegExp flags', () => {
    expect(features('export const re = /x/v')).toEqual(['regex v (unicodeSets) flag'])
    expect(features('export const re = /x/d')).toEqual(['regex d (hasIndices) flag'])
    expect(features("export const re = new RegExp('x', 'gv')")).toEqual([
      'regex v (unicodeSets) flag',
    ])
  })

  it('reports the other regex syntax Firefox 69 cannot parse', () => {
    expect(features('export const re = /(?<year>\\d{4})/')).toEqual(['regex named capture group'])
    expect(features('export const re = /\\p{L}/u')).toEqual(['regex Unicode property escape'])
    expect(features('export const re = /a.b/s')).toEqual(['regex s (dotAll) flag'])
    expect(features('export const re = /(?i:a)b/')).toEqual(['regex modifiers group'])
  })

  it('reads past look-alikes: classes, escapes, groups and lookaheads', () => {
    expect(features('export const re = /[(?<!]/')).toEqual([])
    expect(features('export const re = /\\(?<!x/')).toEqual([])
    expect(features('export const re = /(?:a)(?=b)(?!c)/gimuy')).toEqual([])
    expect(features('export const re = /\\p{L}/')).toEqual([])
    expect(features("export const trim = (s) => s.replace(/^-+|([^-])-+$/g, '$1')")).toEqual([])
  })

  it('reports top-level await, and only at the top level', () => {
    expect(features('const load = async () => 1\nexport const data = await load()')).toEqual([
      'top-level await',
    ])
    expect(features('const xs = []\nfor await (const x of xs) void x')).toEqual(['top-level await'])
    expect(
      features(
        'export async function f(load) {\n  for await (const x of load) void x\n  return await load\n}'
      )
    ).toEqual([])
  })

  it('reports a BigInt literal', () => {
    expect(checkSource('export const big = 10n')).toEqual([
      { file: 'chunk.mjs', line: 1, feature: 'BigInt literal', since: 'Safari 14' },
    ])
  })
})

describe('check-browser-floor: globals', () => {
  it('reports a static past the floor with its versions', () => {
    expect(checkSource('export const g = (items, f) => Object.groupBy(items, f)')).toEqual([
      {
        file: 'chunk.mjs',
        line: 1,
        feature: 'Object.groupBy',
        since: 'Safari 17.4, Chrome 117, Firefox 119, Edge 117',
      },
    ])
    expect(features('export const own = (o, k) => Object.hasOwn(o, k)')).toEqual(['Object.hasOwn'])
  })

  it('reports an unknown global as unclassified', () => {
    expect(checkSource('export const x = () => someGlobalNobodyClassified()')).toEqual([
      {
        file: 'chunk.mjs',
        line: 1,
        feature: 'someGlobalNobodyClassified',
        since: 'unclassified: not on the allowlist',
      },
    ])
    expect(features('export const ns = () => Intl.DateTimeFormat')).toEqual(['Intl'])
    expect(features('export const m = () => Math.sumPrecise([])')).toEqual(['Math.sumPrecise'])
  })

  it('checks a read through globalThis, window or self as the bare global', () => {
    expect(features('export const c = (v) => globalThis.structuredClone(v)')).toEqual([
      'structuredClone',
    ])
    expect(features('export const c = (v) => window.structuredClone(v)')).toEqual([
      'structuredClone',
    ])
    expect(features('export const q = (f) => self.queueMicrotask(f)')).toEqual([])
  })

  it('resolves names through the binder: a local shadow is not the global', () => {
    const code = [
      'const Object = { groupBy: () => 1 }',
      'export function f(structuredClone) { return structuredClone(Object.groupBy()) }',
      'export const g = ({ BigInt }) => BigInt(0)',
    ].join('\n')
    expect(features(code)).toEqual([])
    expect(features('export const s = { structuredClone }')).toEqual(['structuredClone'])
  })

  it('passes a bare typeof, which never throws', () => {
    expect(features("export const ok = typeof structuredClone === 'function'")).toEqual([])
    expect(features("export const ok = typeof Object.hasOwn === 'function'")).toEqual([])
  })

  it('passes a use that a typeof check proves present', () => {
    const code = [
      "export const zero = () => (typeof BigInt === 'function' ? BigInt(0) : undefined)",
      "export function copy(v) { if (typeof structuredClone !== 'undefined') return structuredClone(v) }",
      "export const ref = (t) => typeof WeakRef === 'function' && new WeakRef(t)",
      "export const own = (o, k) => typeof Object.hasOwn === 'function' && Object.hasOwn(o, k)",
    ].join('\n')
    expect(features(code)).toEqual([])
  })

  it('reports a use the guard does not cover', () => {
    expect(features('export const zero = () => BigInt(0)')).toEqual(['BigInt'])
    expect(
      features("export const z = () => (typeof BigInt === 'undefined' ? BigInt(0) : 0)")
    ).toEqual(['BigInt'])
    expect(
      features("export const z = () => (typeof BigInt === 'function' ? 0 : BigInt(0))")
    ).toEqual(['BigInt'])
    expect(features("export const z = () => typeof BigInt === 'function' || BigInt(0)")).toEqual([
      'BigInt',
    ])
    expect(
      features("export const z = () => typeof Object === 'function' && Object.hasOwn({}, 'a')")
    ).toEqual(['Object.hasOwn'])
  })

  it('passes what the dist reads within the floor', () => {
    expect(features('export const signal = () => new AbortController().signal')).toEqual([])
    expect(features('export const tick = (f) => queueMicrotask(f)')).toEqual([])
  })
})

describe('check-browser-floor: late prototype methods', () => {
  it('reports an instance method newer than the floor, by name', () => {
    expect(checkSource('export const last = (xs) => xs.findLast((x) => x > 1)')).toEqual([
      {
        file: 'chunk.mjs',
        line: 1,
        feature: '.findLast()',
        since: 'Safari 15.4, Chrome 97, Firefox 104, Edge 97',
      },
    ])
    expect(features("export const first = (xs) => xs['at'](0)")).toEqual(['.at()'])
    expect(features("export const r = (s) => s.replaceAll('a', 'b')")).toEqual(['.replaceAll()'])
  })
})

describe('check-browser-floor: a clean chunk', () => {
  it('reports nothing for ordinary code within the floor', () => {
    const code = [
      "import { ref } from 'vue'",
      "import { a as b } from './shared/chunk.mjs'",
      "export { b as c } from './shared/other.mjs'",
      'const isServer = import.meta.server',
      'class Store {',
      '  #items = new Map()',
      '  static of(...xs) { return new Store(xs) }',
      '  constructor(xs) { for (const [k, v] of Object.entries(xs ?? {})) this.#items.set(k, v) }',
      '  get size() { return this.#items.size }',
      '}',
      'export async function load(source, { key: renamed = 1 } = {}) {',
      '  const value = await source?.read?.()',
      '  outer: for (const k of Object.keys(value)) { if (Array.isArray(k)) break outer }',
      '  queueMicrotask(() => ref(renamed))',
      '  return { value, renamed, isServer, args: arguments.length, n: Number.isFinite(1) }',
      '}',
      "export const isBrowser = () => typeof window !== 'undefined' && typeof document !== 'undefined'",
      'export const it = (o) => o[Symbol.iterator]',
      "export const pattern = (name) => new RegExp('^' + name + '$')",
      "export const trim = (s) => s.replace(/^-+|([^-])-+$/g, '$1')",
      'export const store = Store.of(1, 2)',
      'export const stamp = () => Date.now()',
      'export const g = globalThis',
    ].join('\n')
    expect(checkSource(code)).toEqual([])
  })
})

describe('check-browser-floor: the tables', () => {
  it('holds no allowlist entry the gate would refuse', () => {
    expect(allowlistViolations()).toEqual([])
  })

  it('keeps every allowlisted row within the floor, and every other row past it', () => {
    for (const [name, row] of Object.entries(ALLOWED_GLOBALS)) {
      expect(pastFloor(row), name).toBe('')
    }
    const late = { ...KNOWN_PAST_FLOOR, ...LATE_METHODS, ...REGEX_FEATURES, ...SYNTAX_FEATURES }
    for (const [name, row] of Object.entries(late)) {
      expect(pastFloor(row), name).not.toBe('')
    }
  })

  it('declares the floor the docs promise', () => {
    expect(FLOOR).toEqual({ safari: '12.1', chrome: '71', firefox: '69', edge: '79' })
    expect(ALLOWED_GLOBALS['AbortController']).toEqual({
      chrome: '66',
      edge: '16',
      firefox: '57',
      safari: '12.1',
    })
    expect(Object.keys(ALLOWED_GLOBALS)).not.toContain('Object.hasOwn')
  })
})

describe('check-browser-floor: reachability', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const fixture = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'browser-floor-'))
    dirs.push(dir)
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      writeFileSync(join(dir, rel), text)
    }
    return dir
  }

  it('reads the runtime entries from build.config.ts, tooling left out', () => {
    const entries = runtimeEntries()
    expect(entries).toContain('src/index')
    expect(entries).toContain('src/zod-v4')
    expect(entries).toContain('src/runtime/plugins/attaform')
    expect(entries).not.toContain('src/vite')
    expect(entries).not.toContain('src/nuxt')
  })

  it('follows static, re-export and dynamic relative imports, and only those', () => {
    const dir = fixture({
      'index.mjs': "import { a } from './shared/a.mjs'\nimport { ref } from 'vue'\n",
      'shared/a.mjs':
        "export * from './b.mjs'\nexport const a = () => import('../chunks/lazy.mjs')\n",
      'shared/b.mjs': 'export const b = 1\n',
      'chunks/lazy.mjs': 'export const lazy = 1\n',
      'shared/orphan.mjs': 'export const orphan = 1\n',
    })
    expect(reachableChunks(dir, ['src/index'])).toEqual(
      ['chunks/lazy.mjs', 'index.mjs', 'shared/a.mjs', 'shared/b.mjs'].map((rel) => join(dir, rel))
    )
  })

  it('throws when an entry or an import target is missing, rather than checking less', () => {
    const dir = fixture({ 'index.mjs': "import './shared/gone.mjs'\n" })
    expect(() => reachableChunks(dir, ['src/index'])).toThrow(/gone\.mjs is missing/)
    expect(() => reachableChunks(dir, ['src/absent'])).toThrow(/absent\.mjs is missing/)
  })
})
