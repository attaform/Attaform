/**
 * SFC-level transform that injects `__ssrAccessed: true` into the options
 * bag of a `useForm(...)` or `injectForm(...)` call whose binding the
 * surrounding template references. It runs once per Vue file inside
 * Vite's `transform(code, id)` hook (see `src/vite.ts`), and
 * `attaform/nuxt` pulls it into Nuxt builds.
 *
 * The injection lets the registry enqueue the form on the SSR prefetch
 * queue BEFORE `onServerPrefetch` fires. An async `defaultValues`
 * factory then runs inside the prefetch phase and its resolved payload
 * bakes into hydration transfer state, so the client never re-fetches.
 *
 * `docs/multistep/ssr.md` carries the coverage details and the
 * form-handle and cross-module fallback list.
 */
import { parse as parseSfc, babelParse } from '@vue/compiler-sfc'
import { NodeTypes, type RootNode, type TemplateChildNode } from '@vue/compiler-core'

interface BabelNode {
  readonly type: string
  readonly start?: number | null
  readonly end?: number | null
}
interface ImportSpecifierNode extends BabelNode {
  readonly type: 'ImportSpecifier'
  readonly imported: {
    readonly type: 'Identifier' | 'StringLiteral'
    readonly name?: string
    readonly value?: string
  }
  readonly local: { readonly name: string }
}
interface ImportDeclarationNode extends BabelNode {
  readonly type: 'ImportDeclaration'
  readonly source: { readonly value: string }
  readonly specifiers: readonly { readonly type: string }[]
}
interface IdentifierNode extends BabelNode {
  readonly type: 'Identifier'
  readonly name: string
}
interface CallExpressionNode extends BabelNode {
  readonly type: 'CallExpression'
  readonly callee: BabelNode
  readonly arguments: readonly BabelNode[]
}
interface ObjectExpressionNode extends BabelNode {
  readonly type: 'ObjectExpression'
  readonly properties: readonly unknown[]
}
interface VariableDeclarationNode extends BabelNode {
  readonly type: 'VariableDeclaration'
  readonly declarations: readonly {
    readonly id: BabelNode
    readonly init: BabelNode | null
  }[]
}
interface StringLiteralNode extends BabelNode {
  readonly type: 'StringLiteral'
  readonly value: string
}

const TARGET_PACKAGES = new Set(['attaform', 'attaform/zod', 'attaform/zod-v3', 'attaform/zod-v4'])
const TARGET_FUNCTIONS = new Set(['useForm', 'injectForm'])

interface BindingEntry {
  readonly callee: 'useForm' | 'injectForm'
  readonly call: CallExpressionNode
}

export interface SsrAccessedTransformResult {
  code: string
  map: null
}

// Edits get applied right-to-left so earlier-position offsets stay valid.
class SourceEditor {
  readonly original: string
  private edits: { start: number; end: number; replacement: string }[] = []

  constructor(original: string) {
    this.original = original
  }

  appendRight(offset: number, text: string): void {
    this.edits.push({ start: offset, end: offset, replacement: text })
  }

  overwrite(start: number, end: number, text: string): void {
    this.edits.push({ start, end, replacement: text })
  }

  toString(): string {
    let out = this.original
    for (const e of [...this.edits].sort((a, b) => b.start - a.start)) {
      out = out.slice(0, e.start) + e.replacement + out.slice(e.end)
    }
    return out
  }
}

/**
 * Cheap rejection before either parser runs, and the reason this pre-pass
 * is affordable on a large project.
 *
 * `collectImports` only ever matches an import whose source is in
 * `TARGET_PACKAGES` and whose imported name is in `TARGET_FUNCTIONS`.
 * Every one of those spellings is a literal in the `<script setup>`
 * source, so a file holding neither substring can produce no binding, no
 * template reference, and no rewrite. Rejecting it here skips a full SFC
 * parse plus a Babel parse of the script block.
 *
 * Measured over this repo's 130 `.vue` files it skips 41% of them and
 * runs the pass 35% faster; over the 6,529 `.vue` sources inside
 * `node_modules` it skips every one, which is where the cost of parsing
 * third-party SFCs went. It is a CONTENT test rather than a
 * `/node_modules/` path bail on purpose: a component library that
 * genuinely builds on Attaform still gets its forms marked for prefetch.
 *
 * Known boundary: Babel decodes escapes and this does not, so an
 * imported name or package specifier spelled with a unicode escape reads
 * as absent. It joins the shapes `injectMark` already declines, with the
 * same `form.activate()` remedy, pinned in
 * `test/transforms/ssr-accessed-injection.test.ts`.
 */
function canPossiblyInject(code: string): boolean {
  if (!code.includes('attaform')) return false
  return code.includes('useForm') || code.includes('injectForm')
}

/**
 * Apply the transform to a single SFC source string. Returns `null`
 * when the file is unaffected (non-SFC id, no attaform form primitive
 * in the source, no `<script setup>`, no `<template>`, or no eligible
 * binding references).
 */
export function transformSsrAccessed(code: string, id: string): SsrAccessedTransformResult | null {
  if (!id.endsWith('.vue')) return null
  if (!canPossiblyInject(code)) return null

  const { descriptor } = parseSfc(code, { filename: id })
  if (descriptor.scriptSetup === null || descriptor.template === null) return null

  const scriptSource = descriptor.scriptSetup.content
  const scriptOffset = descriptor.scriptSetup.loc.start.offset

  let scriptAst: BabelNode
  try {
    scriptAst = babelParse(scriptSource, {
      sourceType: 'module',
      plugins: ['typescript'],
    })
  } catch {
    // A script-setup section the consumer's tooling cannot parse means
    // the SFC will fail to compile anyway, so bail and let the downstream
    // Vue compile path emit the real diagnostic.
    return null
  }

  const program = (scriptAst as { program?: BabelNode }).program ?? scriptAst
  const body = (program as { body?: BabelNode[] }).body ?? []

  const localImports = collectImports(body)
  if (localImports.size === 0) return null

  const bindings = collectBindings(body, localImports)
  if (bindings.size === 0) return null

  const referenced = collectTemplateReferences(descriptor.template.ast, bindings)
  if (referenced.size === 0) return null

  const editor = new SourceEditor(code)
  for (const name of referenced) {
    const entry = bindings.get(name)
    if (entry === undefined) continue
    injectMark(editor, entry.call, scriptOffset)
  }

  return {
    code: editor.toString(),
    map: null,
  }
}

/**
 * Walk the top-level imports, recording the local names of `useForm` and
 * `injectForm` specifiers sourced from an attaform-family package. A
 * renamed import works; a namespace or default import is skipped, the
 * runtime surfacing both functions as named exports.
 */
function collectImports(body: readonly BabelNode[]): Map<string, 'useForm' | 'injectForm'> {
  const locals = new Map<string, 'useForm' | 'injectForm'>()
  for (const node of body) {
    if (node.type !== 'ImportDeclaration') continue
    const decl = node as ImportDeclarationNode
    const source = decl.source.value
    if (!TARGET_PACKAGES.has(source)) continue
    for (const specifier of decl.specifiers) {
      if (specifier.type !== 'ImportSpecifier') continue
      const spec = specifier as ImportSpecifierNode
      const imported = spec.imported
      const importedName = imported.type === 'Identifier' ? imported.name : imported.value
      if (importedName === undefined || !TARGET_FUNCTIONS.has(importedName)) continue
      locals.set(spec.local.name, importedName as 'useForm' | 'injectForm')
    }
  }
  return locals
}

/**
 * Walk the top-level `const` / `let` / `var` declarations, recording a
 * binding whose initializer is a direct call to a tracked import. A
 * destructured return carries no handle name and is skipped, matching
 * the form-handle discipline.
 */
function collectBindings(
  body: readonly BabelNode[],
  localImports: Map<string, 'useForm' | 'injectForm'>
): Map<string, BindingEntry> {
  const bindings = new Map<string, BindingEntry>()
  for (const node of body) {
    if (node.type !== 'VariableDeclaration') continue
    const decl = node as VariableDeclarationNode
    for (const declarator of decl.declarations) {
      const id = declarator.id
      if (id.type !== 'Identifier') continue
      const idNode = id as IdentifierNode
      const init = declarator.init
      if (init === null || init === undefined || init.type !== 'CallExpression') continue
      const call = init as CallExpressionNode
      if (call.callee.type !== 'Identifier') continue
      const callName = (call.callee as IdentifierNode).name
      const tracked = localImports.get(callName)
      if (tracked === undefined) continue
      bindings.set(idNode.name, { callee: tracked, call })
    }
  }
  return bindings
}

/**
 * Walk the template AST collecting binding names referenced from any
 * expression slot: interpolations, directive expressions, attribute
 * bindings. The matching is word-boundary against the expression source,
 * and the same lookup feeds the inject pass that follows.
 */
function collectTemplateReferences(
  root: RootNode | undefined,
  bindings: Map<string, BindingEntry>
): Set<string> {
  const referenced = new Set<string>()
  if (root === undefined) return referenced
  const candidates = new Set(bindings.keys())
  if (candidates.size === 0) return referenced

  const visit = (node: TemplateChildNode | RootNode): void => {
    if ('children' in node && Array.isArray(node.children)) {
      for (const child of node.children as TemplateChildNode[]) visit(child)
    }
    if (node.type === NodeTypes.INTERPOLATION) {
      collectFromExpression(node.content, candidates, referenced)
    } else if (node.type === NodeTypes.ELEMENT && Array.isArray(node.props)) {
      for (const prop of node.props) {
        if (prop.type === NodeTypes.DIRECTIVE) {
          if (prop.exp !== undefined && prop.exp !== null) {
            collectFromExpression(prop.exp, candidates, referenced)
          }
          if (prop.arg !== undefined && prop.arg !== null) {
            collectFromExpression(prop.arg, candidates, referenced)
          }
        }
      }
    }
  }
  visit(root)
  return referenced
}

interface ExpressionLike {
  readonly type: number
  readonly content?: unknown
  readonly children?: readonly unknown[]
}

function collectFromExpression(
  expr: ExpressionLike | unknown,
  candidates: Set<string>,
  out: Set<string>
): void {
  if (expr === null || expr === undefined) return
  if (typeof expr !== 'object') return
  const node = expr as ExpressionLike
  if (node.type === NodeTypes.SIMPLE_EXPRESSION && typeof node.content === 'string') {
    for (const name of candidates) {
      if (matchesIdentifier(node.content, name)) out.add(name)
    }
    return
  }
  if (node.type === NodeTypes.COMPOUND_EXPRESSION && Array.isArray(node.children)) {
    for (const child of node.children) collectFromExpression(child, candidates, out)
  }
}

function matchesIdentifier(source: string, name: string): boolean {
  // A word-boundary check against the expression's source, so
  // `form.values.email`, `form?.values` and `form()` all match while
  // `formData` and a quoted-string occurrence in an unrelated
  // subexpression do not. What false positives there are skew toward
  // marking a form the template uses incidentally, which is acceptable:
  // marking enqueues prefetch on a form the SFC already knows about,
  // never on a random one.
  const pattern = new RegExp(`(?<![\\w$])${escapeForRegExp(name)}(?![\\w$])`)
  return pattern.test(source)
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Inject `__ssrAccessed: true` into the call's options literal. Three
 * shapes, in order of frequency: an existing object literal arg gets the
 * property prepended after `{`; `injectForm`'s string shortcut is
 * upgraded to `{ key: ..., __ssrAccessed: true }`; and no args at all
 * gets a fresh `{ __ssrAccessed: true }`. Anything else, a spread, a
 * computed identifier, a function call, bails to the consumer's
 * `form.activate()` escape hatch.
 */
function injectMark(editor: SourceEditor, call: CallExpressionNode, scriptOffset: number): void {
  const args = call.arguments
  if (args.length === 0) {
    const calleeEnd = call.callee.end
    if (calleeEnd === null || calleeEnd === undefined) return
    // Find the absolute offset right after the `(` opening paren.
    const openParenAbs = findChar(editor.original, '(', scriptOffset + calleeEnd) + 1
    editor.appendRight(openParenAbs, '{ __ssrAccessed: true }')
    return
  }
  const first = args[0]
  if (first === undefined) return
  if (first.type === 'ObjectExpression') {
    const obj = first as ObjectExpressionNode
    if (obj.start === null || obj.start === undefined) return
    const openBraceAbs = scriptOffset + obj.start + 1
    const insertion =
      obj.properties.length === 0 ? ' __ssrAccessed: true ' : ' __ssrAccessed: true,'
    editor.appendRight(openBraceAbs, insertion)
    return
  }
  if (first.type === 'StringLiteral') {
    const lit = first as StringLiteralNode
    if (lit.start === null || lit.start === undefined) return
    if (lit.end === null || lit.end === undefined) return
    const startAbs = scriptOffset + lit.start
    const endAbs = scriptOffset + lit.end
    const original = editor.original.slice(startAbs, endAbs)
    editor.overwrite(startAbs, endAbs, `{ key: ${original}, __ssrAccessed: true }`)
    return
  }
  // An unsupported arg shape; the caller falls back to an explicit
  // `form.activate()`.
}

function findChar(source: string, target: string, from: number): number {
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === target) return i
  }
  return -1
}
