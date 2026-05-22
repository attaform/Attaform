/**
 * SFC-level transform — injects `__ssrAccessed: true` into the
 * options bag of `useForm(...)` and `injectForm(...)` calls whose
 * binding the surrounding template references. Runs once per Vue
 * file during Vite's `transform(code, id)` hook (see `src/vite.ts`)
 * and is also pulled into Nuxt builds via `attaform/nuxt`.
 *
 * The injection lets the runtime registry enqueue the form on the
 * SSR prefetch queue BEFORE `onServerPrefetch` fires. Async
 * `defaultValues` factories then run inside the prefetch phase and
 * the resolved payload bakes into hydration transfer state — the
 * client never re-fetches.
 *
 * Coverage details and the form-handle / cross-module fallback list
 * live in the implementation plan and in `docs/multistep/ssr.md`.
 */
import { parse as parseSfc, babelParse } from '@vue/compiler-sfc'
import MagicString from 'magic-string'
import type { RootNode, TemplateChildNode } from '@vue/compiler-core'

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
  map: ReturnType<MagicString['generateMap']>
}

/**
 * Apply the transform to a single SFC source string. Returns `null`
 * when the file is unaffected (non-SFC id, no `<script setup>`, no
 * `<template>`, or no eligible binding references).
 */
export function transformSsrAccessed(code: string, id: string): SsrAccessedTransformResult | null {
  if (!id.endsWith('.vue')) return null

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
    // A script-setup section that the consumer's tooling can't parse
    // means the SFC will fail to compile anyway — bail and let the
    // downstream Vue compile path emit the real diagnostic.
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

  const magic = new MagicString(code)
  for (const name of referenced) {
    const entry = bindings.get(name)
    if (entry === undefined) continue
    injectMark(magic, entry.call, scriptOffset)
  }

  return {
    code: magic.toString(),
    map: magic.generateMap({ hires: true, source: id, includeContent: true }),
  }
}

/**
 * Walk top-level imports, recording the local names of `useForm` /
 * `injectForm` specifiers sourced from attaform-family packages.
 * Handles renamed imports (`import { useForm as makeForm }`) and
 * skips namespace + default imports (the runtime API surfaces both
 * functions as named exports).
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
 * Walk top-level `const`/`let`/`var` declarations and record bindings
 * whose initializer is a direct call to one of the tracked imports.
 * Destructured returns (`const { register } = useForm(...)`) carry
 * no handle name and are skipped per the form-handle discipline.
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
 * expression slot — interpolations, directive expressions, attribute
 * bindings. Word-boundary matching against the expression source is
 * MVP-grade; the same lookup feeds the inject pass that follows.
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
    if (node.type === 5 /* INTERPOLATION */) {
      collectFromExpression(node.content, candidates, referenced)
    } else if (node.type === 1 /* ELEMENT */ && Array.isArray(node.props)) {
      for (const prop of node.props) {
        if (prop.type === 7 /* DIRECTIVE */) {
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
  if (node.type === 4 /* SIMPLE_EXPRESSION */ && typeof node.content === 'string') {
    for (const name of candidates) {
      if (matchesIdentifier(node.content, name)) out.add(name)
    }
    return
  }
  if (node.type === 8 /* COMPOUND_EXPRESSION */ && Array.isArray(node.children)) {
    for (const child of node.children) collectFromExpression(child, candidates, out)
  }
}

function matchesIdentifier(source: string, name: string): boolean {
  // Word-boundary check against the expression's source. Covers
  // `form.values.email`, `form?.values`, `form()`, etc. without
  // false-matching `formData` or quoted-string occurrences in
  // unrelated subexpressions. False positives skew toward marking
  // forms that the template uses incidentally — acceptable because
  // marking enqueues SSR prefetch on a form the SFC already knows
  // about, not on any random form.
  const pattern = new RegExp(`(?<![\\w$])${escapeForRegExp(name)}(?![\\w$])`)
  return pattern.test(source)
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Inject `__ssrAccessed: true` into the call's options literal.
 * Three shapes, in order of frequency:
 *  - existing object literal arg → prepend the property after `{`
 *  - string-shortcut for injectForm → upgrade to `{ key: ..., __ssrAccessed: true }`
 *  - no args → insert a fresh `{ __ssrAccessed: true }`
 * Other shapes (spread, computed identifier, function call) bail —
 * the consumer's `form.activate()` escape hatch covers them.
 */
function injectMark(magic: MagicString, call: CallExpressionNode, scriptOffset: number): void {
  const args = call.arguments
  if (args.length === 0) {
    const calleeEnd = call.callee.end
    if (calleeEnd === null || calleeEnd === undefined) return
    // Find the absolute offset right after the `(` opening paren.
    const openParenAbs = findChar(magic.original, '(', scriptOffset + calleeEnd) + 1
    magic.appendRight(openParenAbs, '{ __ssrAccessed: true }')
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
    magic.appendRight(openBraceAbs, insertion)
    return
  }
  if (first.type === 'StringLiteral') {
    const lit = first as StringLiteralNode
    if (lit.start === null || lit.start === undefined) return
    if (lit.end === null || lit.end === undefined) return
    const startAbs = scriptOffset + lit.start
    const endAbs = scriptOffset + lit.end
    const original = magic.original.slice(startAbs, endAbs)
    magic.overwrite(startAbs, endAbs, `{ key: ${original}, __ssrAccessed: true }`)
    return
  }
  // Unsupported arg shape (spread, identifier, etc.) — caller falls
  // back to explicit `form.activate()`.
}

function findChar(source: string, target: string, from: number): number {
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === target) return i
  }
  return -1
}
