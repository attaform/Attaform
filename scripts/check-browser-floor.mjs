#!/usr/bin/env node
/**
 * Browser-floor gate. Proves every chunk a browser can load from the
 * published package parses and runs on the declared floor with no
 * polyfills: Safari 12.1 (iOS 12.2), Chrome 71, Firefox 69, Edge 79.
 *
 * Why a floor needs a gate: syntax lowering belongs to the app's bundler
 * (Vite or Nuxt `build.target`), but a bundler only lowers syntax it
 * knows how to rewrite. A regex lookbehind has no rewrite, so one in
 * `readableFormKeyStem` was an early `SyntaxError` on every iOS before
 * 16.4 and took every form on the page down with its module (#704). A
 * BigInt literal is the same failure before Safari 14, and esbuild
 * refuses to build one for an older target at all. Built-ins are the
 * other half: no bundler adds `Object.hasOwn` for the app. The test
 * suite sees none of this, since it runs on a current Node.
 *
 * Scope: the runtime entries `build.config.ts` lists in
 * `RUNTIME_ENTRIES`, in both flavors (`dist/` and `dist/dev/`), plus
 * every chunk reachable from them through a relative static or dynamic
 * import. The Node-only tooling entries (vite, nuxt, transforms, ...)
 * never reach a browser and stay out.
 *
 * Each chunk is parsed with the TypeScript parser (`ScriptKind.JS`) and
 * checked three ways.
 *
 * 1. SYNTAX NO BUNDLER LOWERS. Regex syntax past the floor, in a literal
 *    or in the string handed to `RegExp(...)`: a lookbehind, a named
 *    group, a Unicode property escape, a modifiers group, the `s`, `d` or
 *    `v` flag. esbuild rewrites none of these; at most it moves the
 *    literal into a `new RegExp()` call, which trades the parse error for
 *    a throw at evaluation. Also top-level await and a BigInt literal.
 *
 * 2. GLOBALS ON AN ALLOWLIST. Every free identifier (resolved through
 *    TypeScript's binder, so a local `Map` shadowing the global is not
 *    one) and every static member read off one (`Object.keys`) must be
 *    an entry of `ALLOWED_GLOBALS`, which carries MDN's `version_added`
 *    for each floor browser. New usage cannot slip in unclassified: an
 *    unknown name fails the gate until someone looks it up.
 *
 *    Two reads are safe on any engine and pass without an entry. A bare
 *    `typeof X` never throws. A use inside a branch that `typeof X`
 *    proves present (`typeof BigInt === 'function' ? BigInt(0) : ...`,
 *    the same shape in an `if` or on the right of `&&`) cannot run where
 *    `X` is missing. The guard is read from the AST, never trusted.
 *
 * 3. LATE PROTOTYPE METHODS. Without types, `arr.findLast(...)` is a
 *    property read like any other, so a curated list of instance methods
 *    newer than the floor (`LATE_METHODS`) is matched by name.
 *
 * The allowlist is itself checked: an entry past the floor fails the
 * gate, so the list cannot be used to wave a late API through.
 *
 * Usage:
 *   pnpm check:browser-floor            gate (exits non-zero on a finding)
 *   pnpm check:browser-floor --list     every global and static in use
 *
 * Side effects: builds `dist/` when it is missing, stubbed, or behind
 * `src/` (`ensureFreshDist`, shared with the other dist-reading gates).
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { argv } from 'node:process'
import { dirname, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensureFreshDist } from './dist-bundle.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ts = createRequire(join(ROOT, 'package.json'))('typescript')

const LABEL = 'check-browser-floor'

/** The declared floor. iOS 12.2 ships Safari 12.1's engine. */
export const FLOOR = { safari: '12.1', chrome: '71', firefox: '69', edge: '79' }

const BROWSER_NAMES = { safari: 'Safari', chrome: 'Chrome', firefox: 'Firefox', edge: 'Edge' }

/** The two dist flavors a browser can load, relative to the repo root. */
const FLAVORS = ['dist', 'dist/dev']

/**
 * One support row, in MDN browser-compat-data's `version_added` terms and
 * MDN's column order: `s(chrome, edge, firefox, safari)`. `false` is
 * "not supported".
 */
const s = (chrome, edge, firefox, safari) => ({ chrome, edge, firefox, safari })

/** The row MDN gives every ES1 built-in and the original DOM. */
const ES1 = s('1', '12', '1', '1')

/**
 * Every global, and every static member of one, that the browser-reachable
 * dist reads today, with MDN's `version_added` for full support
 * (browser-compat-data 8.1.6). Keyed by `Name` or `Name.member`. A static
 * is checked on its own entry, so `Object` being here says nothing about
 * `Object.groupBy`. Reads through `globalThis.`, `window.` or `self.` are
 * checked as the bare name they reach.
 *
 * Web API rows are the interface's (`api.Document`), statics the member's
 * (`api.Document.visibilityState`). `window.addEventListener` and friends
 * resolve through `globalThis`, so they carry `EventTarget`'s rows.
 */
export const ALLOWED_GLOBALS = {
  // Safari 12.1 is full support; 11.1 shipped an AbortController that did
  // not abort fetch. Built lazily for a validator's `ctx.signal`.
  AbortController: s('66', '16', '57', '12.1'),
  Array: ES1,
  'Array.from': s('45', '12', '32', '9'),
  'Array.isArray': s('4', '12', '4', '5'),
  'Array.prototype': ES1,
  Boolean: ES1,
  Date: ES1,
  'Date.now': s('1', '12', '1', '4'),
  Document: ES1,
  Error: ES1,
  Event: ES1,
  File: s('13', '12', '7', '4'),
  FileList: s('2', '12', '3', '4'),
  Function: ES1,
  'Function.prototype': ES1,
  HTMLInputElement: ES1,
  HTMLTextAreaElement: ES1,
  JSON: s('3', '12', '3.5', '4'),
  'JSON.parse': s('3', '12', '3.5', '4'),
  'JSON.stringify': s('3', '12', '3.5', '4'),
  Map: s('38', '12', '13', '8'),
  Math: ES1,
  'Math.floor': ES1,
  'Math.imul': s('28', '12', '20', '7'),
  'Math.max': ES1,
  'Math.min': ES1,
  MutationObserver: s('26', '12', '14', '7'),
  NaN: ES1,
  Node: ES1,
  // MDN tracks the constant with `compareDocumentPosition`, its one consumer.
  'Node.DOCUMENT_POSITION_FOLLOWING': s('2', '12', '1', '4'),
  Number: ES1,
  'Number.isFinite': s('19', '12', '16', '9'),
  'Number.isInteger': s('34', '12', '16', '9'),
  Object: ES1,
  'Object.create': s('5', '12', '4', '5'),
  'Object.defineProperty': s('5', '12', '4', '5.1'),
  'Object.entries': s('54', '14', '47', '10.1'),
  'Object.freeze': s('6', '12', '4', '5.1'),
  'Object.getOwnPropertyDescriptor': s('5', '12', '4', '5'),
  'Object.getOwnPropertyNames': s('5', '12', '4', '5'),
  'Object.getOwnPropertySymbols': s('38', '12', '36', '9'),
  'Object.getPrototypeOf': s('5', '12', '3.5', '5'),
  'Object.is': s('19', '12', '22', '9'),
  'Object.isExtensible': s('6', '12', '4', '5.1'),
  'Object.isFrozen': s('6', '12', '4', '5.1'),
  'Object.keys': s('5', '12', '4', '5'),
  'Object.prototype': ES1,
  'Object.values': s('54', '14', '47', '10.1'),
  Promise: s('32', '12', '29', '8'),
  'Promise.all': s('32', '12', '29', '8'),
  'Promise.resolve': s('32', '12', '29', '8'),
  Proxy: s('49', '12', '18', '10'),
  Reflect: s('49', '12', '42', '10'),
  'Reflect.apply': s('49', '12', '42', '10'),
  'Reflect.get': s('49', '12', '42', '10'),
  'Reflect.getOwnPropertyDescriptor': s('49', '12', '42', '10'),
  'Reflect.has': s('49', '12', '42', '10'),
  'Reflect.ownKeys': s('49', '12', '42', '10'),
  RegExp: ES1,
  Set: s('38', '12', '13', '8'),
  ShadowRoot: s('53', '79', '63', '10'),
  String: ES1,
  Symbol: s('38', '12', '36', '9'),
  'Symbol.for': s('40', '12', '36', '9'),
  'Symbol.iterator': s('43', '12', '36', '10'),
  'Symbol.toPrimitive': s('47', '15', '44', '10'),
  // The interface's row. MDN dates full support for the constructor to
  // Safari 14.1 because earlier releases throw on an `undefined` second
  // argument (webkit.org/b/216841). Every call here passes one argument.
  URL: s('32', '12', '19', '7'),
  WeakMap: s('36', '12', '6', '8'),
  WeakSet: s('36', '12', '34', '9'),
  addEventListener: ES1,
  clearTimeout: s('1', '12', '1', '4'),
  console: s('1', '12', '4', '3'),
  'console.error': s('1', '12', '4', '3'),
  'console.warn': s('1', '12', '4', '3'),
  document: ES1,
  'document.addEventListener': ES1,
  'document.removeEventListener': ES1,
  'document.visibilityState': s('33', '12', '18', '7'),
  // On the floor exactly: Chrome 71 and Safari 12.1 are where it lands.
  globalThis: s('71', '79', '65', '12.1'),
  history: ES1,
  'history.pushState': s('5', '12', '4', '5'),
  'history.replaceState': s('5', '12', '4', '5'),
  isNaN: ES1,
  location: ES1,
  'location.href': ES1,
  'location.pathname': ES1,
  parseFloat: ES1,
  // On the floor exactly: it sets Chrome 71, Firefox 69 and Safari 12.1.
  queueMicrotask: s('71', '79', '69', '12.1'),
  removeEventListener: ES1,
  setTimeout: ES1,
  window: ES1,
}

/**
 * Globals and statics past the floor that are worth naming in a report,
 * with the release each first shipped in. A name off both lists still
 * fails, as unclassified; one here fails with the versions it needs.
 */
export const KNOWN_PAST_FLOOR = {
  AggregateError: s('85', '85', '79', '14'),
  'AbortSignal.any': s('116', '116', '124', '17.4'),
  'AbortSignal.timeout': s('103', '103', '100', '16'),
  'Array.fromAsync': s('121', '121', '115', '16.4'),
  BigInt: s('67', '79', '68', '14'),
  FinalizationRegistry: s('84', '84', '79', '14.1'),
  'Intl.Segmenter': s('87', '87', '125', '14.1'),
  'Map.groupBy': s('117', '117', '119', '17.4'),
  'Object.fromEntries': s('73', '79', '63', '12.1'),
  'Object.groupBy': s('117', '117', '119', '17.4'),
  'Object.hasOwn': s('93', '93', '92', '15.4'),
  'Promise.allSettled': s('76', '79', '71', '13'),
  'Promise.any': s('85', '85', '79', '14'),
  'Promise.withResolvers': s('119', '119', '121', '17.4'),
  WeakRef: s('84', '84', '79', '14.1'),
  requestIdleCallback: s('47', '79', '55', false),
  structuredClone: s('98', '98', '94', '15.4'),
}

/**
 * Instance methods newer than the floor, matched by property name since a
 * chunk carries no types. Names short enough to collide with an ordinary
 * property (`at`, `with`) are still listed: a false positive here costs a
 * rename, a false negative costs a dead page.
 */
export const LATE_METHODS = {
  at: s('92', '92', '90', '15.4'),
  difference: s('122', '122', '127', '17'),
  findLast: s('97', '97', '104', '15.4'),
  findLastIndex: s('97', '97', '104', '15.4'),
  intersection: s('122', '122', '127', '17'),
  isDisjointFrom: s('122', '122', '127', '17'),
  isSubsetOf: s('122', '122', '127', '17'),
  isSupersetOf: s('122', '122', '127', '17'),
  isWellFormed: s('111', '111', '119', '16.4'),
  matchAll: s('73', '79', '67', '13'),
  replaceAll: s('85', '85', '77', '13.1'),
  replaceChildren: s('86', '86', '78', '14'),
  requestSubmit: s('76', '79', '75', '16'),
  symmetricDifference: s('122', '122', '127', '17'),
  toReversed: s('110', '110', '115', '16'),
  toSorted: s('110', '110', '115', '16'),
  toSpliced: s('110', '110', '115', '16'),
  toWellFormed: s('111', '111', '119', '16.4'),
  union: s('122', '122', '127', '17'),
  with: s('110', '110', '115', '16'),
}

/** Regex syntax no bundler lowers, with the release that first parses it. */
export const REGEX_FEATURES = {
  'regex lookbehind': s('62', '79', '78', '16.4'),
  'regex named capture group': s('64', '79', '78', '11.1'),
  'regex Unicode property escape': s('64', '79', '78', '11.1'),
  'regex modifiers group': s('125', '125', '132', '26'),
  'regex s (dotAll) flag': s('62', '79', '78', '11.1'),
  'regex d (hasIndices) flag': s('90', '90', '88', '15'),
  'regex v (unicodeSets) flag': s('112', '112', '116', '17'),
}

/** Syntax outside regexes that no transpiler lowers. */
export const SYNTAX_FEATURES = {
  'top-level await': s('89', '89', '89', '15'),
  'BigInt literal': s('67', '79', '68', '14'),
}

/** Global objects whose members are themselves globals. */
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self'])

/**
 * Names that resolve to no declaration yet are not a global to classify:
 * `arguments` is a function's own binding, and `undefined` is an ES1
 * constant that esbuild prints as `void 0` in every chunk anyway.
 */
const INTRINSIC_BINDINGS = new Set(['arguments', 'undefined'])

const has = (table, key) => Object.prototype.hasOwnProperty.call(table, key)

function parseVersion(v) {
  return String(v)
    .split('.')
    .map((part) => Number.parseInt(part, 10))
}

function versionGreater(a, b) {
  const [pa, pb] = [parseVersion(a), parseVersion(b)]
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const [x, y] = [pa[i] ?? 0, pb[i] ?? 0]
    if (x !== y) return x > y
  }
  return false
}

/**
 * The floor browsers a support row leaves out, as `Safari 15.4, Chrome 93`.
 * Empty when the feature is within the floor everywhere.
 */
export function pastFloor(support) {
  const out = []
  for (const [browser, floor] of Object.entries(FLOOR)) {
    const added = support[browser]
    if (added === false) out.push(`${BROWSER_NAMES[browser]} none`)
    else if (versionGreater(added, floor)) out.push(`${BROWSER_NAMES[browser]} ${added}`)
  }
  return out.join(', ')
}

/** Allowlist entries the gate refuses: past the floor, or on both lists. */
export function allowlistViolations() {
  const out = []
  for (const [name, support] of Object.entries(ALLOWED_GLOBALS)) {
    const late = pastFloor(support)
    if (late !== '') out.push(`${name} (${late})`)
    if (has(KNOWN_PAST_FLOOR, name)) out.push(`${name} is on ALLOWED_GLOBALS and KNOWN_PAST_FLOOR`)
  }
  return out
}

/**
 * Walk a regex body and name every past-floor construct in it. Character
 * classes are skipped (a `(?<` inside `[...]` is literal text), and every
 * escape consumes the character after it.
 */
export function regexFeatures(pattern, flags) {
  const found = new Set()
  if (flags.includes('s')) found.add('regex s (dotAll) flag')
  if (flags.includes('d')) found.add('regex d (hasIndices) flag')
  if (flags.includes('v')) found.add('regex v (unicodeSets) flag')
  const unicode = flags.includes('u') || flags.includes('v')
  let inClass = false
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '\\') {
      const next = pattern[i + 1]
      if (unicode && (next === 'p' || next === 'P') && pattern[i + 2] === '{') {
        found.add('regex Unicode property escape')
      }
      i += 1
      continue
    }
    if (inClass) {
      if (ch === ']') inClass = false
      continue
    }
    if (ch === '[') {
      inClass = true
      continue
    }
    if (ch !== '(' || pattern[i + 1] !== '?') continue
    const rest = pattern.slice(i + 2)
    if (rest.startsWith('<=') || rest.startsWith('<!')) found.add('regex lookbehind')
    else if (rest.startsWith('<')) found.add('regex named capture group')
    else if (/^[ims]*-?[ims]*:/.test(rest) && !rest.startsWith(':')) {
      found.add('regex modifiers group')
    }
  }
  return [...found]
}

/**
 * The static text of a string argument: a string literal, a plain
 * template, or a template whose substitutions are replaced by a neutral
 * character. `undefined` for anything computed.
 */
function staticString(node) {
  if (node === undefined) return undefined
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => `x${span.literal.text}`).join('')
  }
  return undefined
}

function createChecker(sourceFile) {
  const fileName = sourceFile.fileName
  const host = {
    getSourceFile: (name) => (name === fileName ? sourceFile : undefined),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === fileName,
    readFile: () => undefined,
  }
  // `noLib` leaves every global undeclared, so the binder's answer to
  // "what does this name resolve to" is `undefined` exactly for a global.
  const options = {
    allowJs: true,
    noLib: true,
    noResolve: true,
    types: [],
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
  }
  return ts.createProgram({ rootNames: [fileName], options, host }).getTypeChecker()
}

/**
 * Identifier positions that name something other than a binding in
 * scope: a property after a dot, an object key in a destructuring
 * pattern, a label, `import.meta`'s `meta`, and import/export specifier
 * names, which refer to another module.
 */
function isReferencePosition(id) {
  const parent = id.parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false
  if (ts.isBindingElement(parent) && parent.propertyName === id) return false
  if (ts.isLabeledStatement(parent) && parent.label === id) return false
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === id) {
    return false
  }
  if (ts.isMetaProperty(parent)) return false
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false
  if (ts.isImportAttribute(parent)) return false
  return true
}

/** The name a property read reaches, for `.x` and `['x']`; else `undefined`. */
function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node)) return staticString(node.argumentExpression)
  return undefined
}

function isFunctionBoundary(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassStaticBlockDeclaration(node) ||
    ts.isPropertyDeclaration(node)
  )
}

/**
 * The global a `typeof` operand names, as `Name` or `Name.member`, with a
 * `globalThis.` / `window.` / `self.` prefix dropped. `undefined` for any
 * other operand.
 */
function operandKey(node) {
  const parts = []
  let cursor = node
  while (ts.isPropertyAccessExpression(cursor)) {
    parts.unshift(cursor.name.text)
    cursor = cursor.expression
  }
  if (!ts.isIdentifier(cursor)) return undefined
  parts.unshift(cursor.text)
  if (parts.length > 1 && GLOBAL_OBJECTS.has(parts[0])) parts.shift()
  return parts.length <= 2 ? parts.join('.') : undefined
}

const EQ = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken])
const NE = new Set([
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
])

/**
 * Globals a condition proves present: each `&&` conjunct of the form
 * `typeof X === '<anything but undefined>'` or `typeof X !== 'undefined'`.
 */
function provenPresent(condition) {
  const keys = new Set()
  const visit = (node) => {
    if (ts.isParenthesizedExpression(node)) return visit(node.expression)
    if (!ts.isBinaryExpression(node)) return
    const op = node.operatorToken.kind
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      visit(node.left)
      visit(node.right)
      return
    }
    if (!EQ.has(op) && !NE.has(op)) return
    const [probe, literal] = ts.isTypeOfExpression(node.left)
      ? [node.left, node.right]
      : [node.right, node.left]
    if (!ts.isTypeOfExpression(probe) || !ts.isStringLiteral(literal)) return
    const present = EQ.has(op) ? literal.text !== 'undefined' : literal.text === 'undefined'
    const key = operandKey(probe.expression)
    if (present && key !== undefined) keys.add(key)
  }
  visit(condition)
  return keys
}

/** Whether `node` only runs inside a branch a `typeof key` check proves. */
function isFeatureDetected(node, key) {
  let child = node
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isConditionalExpression(parent) && parent.whenTrue === child) {
      if (provenPresent(parent.condition).has(key)) return true
    } else if (ts.isIfStatement(parent) && parent.thenStatement === child) {
      if (provenPresent(parent.expression).has(key)) return true
    } else if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      parent.right === child
    ) {
      if (provenPresent(parent.left).has(key)) return true
    }
    child = parent
  }
  return false
}

/**
 * Check one chunk's text. Returns every finding as
 * `{ file, line, feature, since }`, where `since` names the floor
 * browsers the feature leaves out, or says it is unclassified. Pass a
 * `uses` map to also collect every global and static the chunk reads,
 * each marked `'direct'` or, when every read is guarded, `'detected'`.
 */
export function checkSource(text, file = 'chunk.mjs', uses = undefined) {
  const sourceFile = ts.createSourceFile(
    `/${file.replace(/^\/+/, '')}`,
    text,
    {
      languageVersion: ts.ScriptTarget.Latest,
      impliedNodeFormat: ts.ModuleKind.ESNext,
      // Every chunk is an ES module, so a top-level `await` must parse as
      // one even in a snippet with no import or export.
      setExternalModuleIndicator: (sf) => {
        sf.externalModuleIndicator = true
      },
    },
    true,
    ts.ScriptKind.JS
  )
  const checker = createChecker(sourceFile)
  const findings = []
  const lineOf = (node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  const report = (node, feature, support) => {
    const late = support === undefined ? '' : pastFloor(support)
    if (support !== undefined && late === '') return
    findings.push({
      file,
      line: lineOf(node),
      feature,
      since: support === undefined ? 'unclassified: not on the allowlist' : late,
    })
  }
  const recordUse = (key, detected) => {
    if (uses === undefined) return
    if (!detected) uses.set(key, 'direct')
    else if (!uses.has(key)) uses.set(key, 'detected')
  }

  const isGlobalReference = (id) => {
    if (INTRINSIC_BINDINGS.has(id.text)) return false
    const parent = id.parent
    const symbol =
      ts.isShorthandPropertyAssignment(parent) && parent.name === id
        ? checker.getShorthandAssignmentValueSymbol(parent)
        : checker.getSymbolAtLocation(id)
    // No symbol, or one the checker synthesizes with no declaration
    // (`undefined`, `globalThis`): either way, nothing in the chunk binds it.
    return symbol === undefined || (symbol.declarations ?? []).length === 0
  }

  const checkGlobal = (id) => {
    // `typeof X` is the one read of an undeclared name that never throws.
    if (ts.isTypeOfExpression(id.parent)) return
    let name = id.text
    let node = id
    let member = memberName(node.parent)
    if (GLOBAL_OBJECTS.has(name) && member !== undefined && node.parent.expression === node) {
      name = member
      node = node.parent
      if (ts.isTypeOfExpression(node.parent)) return
      member = memberName(node.parent)
    }
    // `typeof X.member` reads a property of a present `X`, which cannot throw.
    const isStatic =
      member !== undefined &&
      node.parent.expression === node &&
      !ts.isTypeOfExpression(node.parent.parent)
    const keys = isStatic ? [name, `${name}.${member}`] : [name]
    for (const key of keys) {
      const detected = isFeatureDetected(id, key)
      recordUse(key, detected)
      if (has(ALLOWED_GLOBALS, key) || detected) continue
      report(id, key, has(KNOWN_PAST_FLOOR, key) ? KNOWN_PAST_FLOOR[key] : undefined)
      return
    }
  }

  const checkRegex = (node, pattern, flags) => {
    for (const feature of regexFeatures(pattern, flags)) {
      report(node, feature, REGEX_FEATURES[feature])
    }
  }

  const visit = (node, functionDepth) => {
    const depth = isFunctionBoundary(node) ? functionDepth + 1 : functionDepth

    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const literal = node.text
      const close = literal.lastIndexOf('/')
      checkRegex(node, literal.slice(1, close), literal.slice(close + 1))
    } else if (node.kind === ts.SyntaxKind.BigIntLiteral) {
      report(node, 'BigInt literal', SYNTAX_FEATURES['BigInt literal'])
    } else if (ts.isAwaitExpression(node) && depth === 0) {
      report(node, 'top-level await', SYNTAX_FEATURES['top-level await'])
    } else if (ts.isForOfStatement(node) && node.awaitModifier !== undefined && depth === 0) {
      report(node, 'top-level await', SYNTAX_FEATURES['top-level await'])
    } else if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'RegExp'
    ) {
      const pattern = staticString(node.arguments?.[0])
      if (pattern !== undefined) checkRegex(node, pattern, staticString(node.arguments?.[1]) ?? '')
    }

    const member = memberName(node)
    if (member !== undefined && has(LATE_METHODS, member)) {
      const receiver = node.expression
      // A static on a global (`Array.at`) is the allowlist's business.
      if (!(ts.isIdentifier(receiver) && isGlobalReference(receiver))) {
        report(node, `.${member}()`, LATE_METHODS[member])
      }
    }

    if (ts.isIdentifier(node) && isReferencePosition(node) && isGlobalReference(node)) {
      checkGlobal(node)
    }

    ts.forEachChild(node, (child) => visit(child, depth))
  }
  visit(sourceFile, 0)
  return findings
}

/** `RUNTIME_ENTRIES` from `build.config.ts`, read from the source. */
export function runtimeEntries() {
  const configPath = join(ROOT, 'build.config.ts')
  const sourceFile = ts.createSourceFile(
    configPath,
    readFileSync(configPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  let entries
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'RUNTIME_ENTRIES' &&
      node.initializer !== undefined &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      entries = node.initializer.elements.filter(ts.isStringLiteral).map((el) => el.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (entries === undefined || entries.length === 0) {
    throw new Error(`[${LABEL}] no RUNTIME_ENTRIES array found in build.config.ts`)
  }
  return entries
}

/** Relative module specifiers a chunk imports, statically or dynamically. */
function relativeImports(text, file) {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const out = []
  const visit = (node) => {
    let specifier
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      specifier = node.moduleSpecifier
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      specifier = node.arguments[0]
    }
    const target = specifier === undefined ? undefined : staticString(specifier)
    if (target !== undefined && target.startsWith('.')) out.push(target)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return out
}

/**
 * Every chunk of one flavor reachable from the runtime entries, as sorted
 * absolute paths. An entry or import target missing on disk throws: a
 * gate that silently checks less than it claims is worse than none.
 */
export function reachableChunks(distDir, entries) {
  const seen = new Set()
  const queue = entries.map((entry) => resolve(distDir, `${entry.replace(/^src\//, '')}.mjs`))
  while (queue.length > 0) {
    const file = queue.shift()
    if (seen.has(file)) continue
    if (!existsSync(file)) {
      throw new Error(`[${LABEL}] ${relative(ROOT, file)} is missing from the build`)
    }
    seen.add(file)
    for (const specifier of relativeImports(readFileSync(file, 'utf8'), file)) {
      queue.push(resolve(dirname(file), specifier))
    }
  }
  return [...seen].sort()
}

/** Run every check over both flavors of the built dist. */
export function checkBrowserFloor() {
  const entries = runtimeEntries()
  const chunks = []
  const findings = []
  const uses = new Map()
  for (const flavor of FLAVORS) {
    for (const file of reachableChunks(join(ROOT, flavor), entries)) {
      const rel = relative(ROOT, file)
      chunks.push(rel)
      findings.push(...checkSource(readFileSync(file, 'utf8'), rel, uses))
    }
  }
  return { chunks, findings, uses }
}

const isMain = import.meta.url === pathToFileURL(realpathSync(argv[1])).href
if (isMain) {
  ensureFreshDist(LABEL)
  const { chunks, findings, uses } = checkBrowserFloor()
  if (argv.includes('--list')) {
    for (const [name, how] of [...uses].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const row = ALLOWED_GLOBALS[name] ?? KNOWN_PAST_FLOOR[name]
      const late = row === undefined ? 'unclassified' : pastFloor(row) || 'within the floor'
      console.log(`${name}  ${late}${how === 'detected' ? ', feature-detected' : ''}`)
    }
    process.exit(0)
  }
  const floor = Object.entries(FLOOR)
    .map(([browser, version]) => `${BROWSER_NAMES[browser]} ${version}`)
    .join(', ')
  console.log(`[${LABEL}] floor: ${floor}, no polyfills`)
  console.log(`[${LABEL}] ${chunks.length} browser-reachable chunk(s) across ${FLAVORS.join(', ')}`)
  const bad = allowlistViolations()
  if (bad.length > 0) {
    console.error(`\n[${LABEL}] FAILED: allowlist entries the gate refuses:`)
    for (const line of bad) console.error(`  - ${line}`)
  }
  if (findings.length > 0) {
    console.error(`\n[${LABEL}] FAILED: ${findings.length} finding(s) past the floor:`)
    for (const f of findings) console.error(`  - ${f.file}:${f.line}  ${f.feature}  (${f.since})`)
  }
  if (bad.length > 0 || findings.length > 0) process.exit(1)
  const unused = Object.keys(ALLOWED_GLOBALS).filter((name) => !uses.has(name))
  if (unused.length > 0) {
    console.log(`[${LABEL}] allowlist entries no chunk reads (safe to drop): ${unused.join(', ')}`)
  }
  console.log(`[${LABEL}] ok, every browser-reachable chunk is within the floor`)
}
