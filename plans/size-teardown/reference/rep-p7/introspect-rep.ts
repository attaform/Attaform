// P7 rep sketch: introspect diet. Same export surface as
// src/runtime/adapters/zod-v4/introspect.ts; kindOf switch replaced by
// an alias table + known-kind set, walkSchemaTree descent data-driven.
// LEAN-semantics sketch for byte measurement only.
import type { z } from 'zod'

export type ZodKind =
  | 'object'
  | 'array'
  | 'set'
  | 'record'
  | 'tuple'
  | 'union'
  | 'discriminated-union'
  | 'string'
  | 'number'
  | 'boolean'
  | 'bigint'
  | 'date'
  | 'enum'
  | 'literal'
  | 'null'
  | 'undefined'
  | 'any'
  | 'unknown'
  | 'optional'
  | 'nullable'
  | 'default'
  | 'pipe'
  | 'readonly'
  | 'nan'
  | 'void'
  | 'never'
  | 'lazy'
  | 'intersection'
  | 'catch'
  | 'promise'
  | 'custom'
  | 'template-literal'
  | 'transform'
  | 'file'
  | 'map'
  | 'symbol'
  | 'function'

interface ZodInternalShape {
  def?: {
    type?: string
    element?: unknown
    innerType?: unknown
    options?: readonly unknown[]
    shape?: Record<string, unknown>
    keyType?: unknown
    valueType?: unknown
    items?: readonly unknown[]
    values?: readonly unknown[]
    entries?: Record<string, unknown>
    discriminator?: string
    defaultValue?: unknown
    in?: unknown
    out?: unknown
    checks?: readonly unknown[]
    getter?: () => unknown
    left?: unknown
    right?: unknown
    catchValue?: (ctx: { error: unknown; input: unknown }) => unknown
    parts?: readonly unknown[]
    transform?: unknown
    coerce?: boolean
  }
}

function readDef(schema: unknown): ZodInternalShape['def'] | undefined {
  if (schema === null || typeof schema !== 'object') return undefined
  return (schema as ZodInternalShape).def
}

const KIND_ALIAS: Record<string, ZodKind> = {
  discriminated_union: 'discriminated-union',
  discriminatedUnion: 'discriminated-union',
  prefault: 'default',
  template_literal: 'template-literal',
  templateLiteral: 'template-literal',
}

const KNOWN_KINDS = new Set<string>([
  'object',
  'array',
  'set',
  'record',
  'tuple',
  'string',
  'number',
  'boolean',
  'bigint',
  'date',
  'enum',
  'literal',
  'null',
  'undefined',
  'any',
  'unknown',
  'optional',
  'nullable',
  'default',
  'pipe',
  'readonly',
  'nan',
  'void',
  'never',
  'lazy',
  'intersection',
  'catch',
  'promise',
  'custom',
  'transform',
  'file',
  'map',
  'symbol',
  'function',
])

export function kindOf(schema: unknown): ZodKind {
  const def = readDef(schema)
  const rawType = def?.type
  if (rawType === undefined) return 'unknown'
  if (rawType === 'union') {
    return def?.discriminator !== undefined ? 'discriminated-union' : 'union'
  }
  const alias = KIND_ALIAS[rawType]
  if (alias !== undefined) return alias
  return KNOWN_KINDS.has(rawType) ? (rawType as ZodKind) : 'unknown'
}

export function getObjectShape(schema: z.ZodObject): Record<string, z.ZodType> {
  const s = schema as unknown as { shape: Record<string, z.ZodType> }
  return s.shape
}

export function getArrayElement(schema: z.ZodArray): z.ZodType {
  return readDef(schema)?.element as z.ZodType
}

export function getSetValueType(schema: z.ZodType): z.ZodType {
  return readDef(schema)?.valueType as z.ZodType
}

export function getRecordKeyType(schema: z.ZodType): z.ZodType {
  return readDef(schema)?.keyType as z.ZodType
}

export function getRecordValueType(schema: z.ZodType): z.ZodType {
  return readDef(schema)?.valueType as z.ZodType
}

export function getTupleItems(schema: z.ZodType): readonly z.ZodType[] {
  return (readDef(schema)?.items as readonly z.ZodType[] | undefined) ?? []
}

export function getUnionOptions(schema: z.ZodType): readonly z.ZodType[] {
  return (readDef(schema)?.options as readonly z.ZodType[] | undefined) ?? []
}

export function getLiteralValues(schema: z.ZodType): readonly unknown[] {
  return readDef(schema)?.values ?? []
}

export function getEnumValues(schema: z.ZodType): readonly (string | number)[] {
  const entries = readDef(schema)?.entries
  if (entries === undefined) return []
  return Object.values(entries) as (string | number)[]
}

export function unwrapInner(schema: z.ZodType): z.ZodType | undefined {
  return readDef(schema)?.innerType as z.ZodType | undefined
}

export function unwrapPipe(schema: z.ZodType): z.ZodType | undefined {
  const def = readDef(schema)
  return (def?.in as z.ZodType | undefined) ?? (def?.out as z.ZodType | undefined)
}

export function unwrapPipeIn(schema: z.ZodType): z.ZodType | undefined {
  return readDef(schema)?.in as z.ZodType | undefined
}

export function isCoercePrimitive(schema: z.ZodType): boolean {
  return readDef(schema)?.coerce === true
}

export function isPreprocessNode(schema: z.ZodType): boolean {
  if (kindOf(schema) !== 'pipe') return false
  const pipeIn = unwrapPipeIn(schema)
  return pipeIn !== undefined && kindOf(pipeIn) === 'transform'
}

export function unwrapPipeOut(schema: z.ZodType): z.ZodType | undefined {
  return readDef(schema)?.out as z.ZodType | undefined
}

export function unwrapLazy(schema: z.ZodType): z.ZodType | undefined {
  const getter = readDef(schema)?.getter
  if (typeof getter !== 'function') return undefined
  return getter() as z.ZodType
}

export function getLazyGetter(schema: z.ZodType): (() => unknown) | undefined {
  const getter = readDef(schema)?.getter
  return typeof getter === 'function' ? getter : undefined
}

export function getIntersectionLeft(schema: z.ZodType): z.ZodType | undefined {
  return readDef(schema)?.left as z.ZodType | undefined
}

export function getIntersectionRight(schema: z.ZodType): z.ZodType | undefined {
  return readDef(schema)?.right as z.ZodType | undefined
}

export function getCatchDefault(schema: z.ZodType): unknown {
  const cv = readDef(schema)?.catchValue
  if (typeof cv !== 'function') return undefined
  try {
    return cv({ error: new Error('atta:default-values'), input: undefined })
  } catch {
    return undefined
  }
}

export function hasCatchValue(schema: z.ZodType): boolean {
  return typeof readDef(schema)?.catchValue === 'function'
}

export function getDefaultValue(schema: z.ZodType): unknown {
  return readDef(schema)?.defaultValue
}

export function getNativeEnumValues(_schema: z.ZodType): Record<string, unknown> | undefined {
  return undefined
}

export function unwrapEffectsSource(_schema: z.ZodType): z.ZodType | undefined {
  return undefined
}

export function unwrapBranded(_schema: z.ZodType): z.ZodType | undefined {
  return undefined
}

export function hasChecks(schema: z.ZodType): boolean {
  const checks = readDef(schema)?.checks
  return Array.isArray(checks) && checks.length > 0
}

export function getChecks(schema: z.ZodType): readonly unknown[] {
  const checks = readDef(schema)?.checks
  return Array.isArray(checks) ? (checks as readonly unknown[]) : []
}

export function getDiscriminator(schema: z.ZodType): string | undefined {
  return readDef(schema)?.discriminator
}

export function getDiscriminatedOptions(schema: z.ZodType): readonly z.ZodObject[] {
  const options = readDef(schema)?.options
  return Array.isArray(options) ? (options as readonly z.ZodObject[]) : []
}

export function assertZodVersion(schema: unknown): void {
  const def = readDef(schema)
  if (def?.type === undefined) {
    throw new Error(
      '[attaform/zod-v4] Schema is not a Zod v4 schema. The `attaform/zod-v4` adapter requires ' +
        'zod@^4. Either: (a) install zod@^4 in your project; (b) import from `attaform/zod`, ' +
        'which auto-detects the Zod version (and tree-shakes to a single adapter when the ' +
        '`attaform/vite` plugin is active); or (c) import from `attaform/zod-v3` if you are ' +
        'staying on Zod v3.'
    )
  }
}

const DESCEND_SINGLE = [
  'innerType',
  'element',
  'in',
  'out',
  'left',
  'right',
  'keyType',
  'valueType',
] as const
const DESCEND_RECORD = ['shape', 'entries'] as const
const DESCEND_LIST = ['options', 'items'] as const

export function walkSchemaTree(
  schema: z.ZodType,
  visit: (node: z.ZodType) => boolean,
  seen?: WeakSet<object>
): boolean {
  const visited = seen ?? new WeakSet<object>()
  const candidate = schema as unknown
  if (typeof candidate !== 'object' || candidate === null) return false
  if (visited.has(candidate)) return false
  visited.add(candidate)

  if (visit(schema)) return true

  const def = readDef(schema)
  if (def === undefined) return false
  const d = def as Record<string, unknown>

  for (const key of DESCEND_SINGLE) {
    const child = d[key]
    if (child !== undefined && walkSchemaTree(child as z.ZodType, visit, visited)) return true
  }
  for (const key of DESCEND_RECORD) {
    const rec = d[key]
    if (rec !== undefined) {
      for (const sub of Object.values(rec as Record<string, unknown>)) {
        if (walkSchemaTree(sub as z.ZodType, visit, visited)) return true
      }
    }
  }
  for (const key of DESCEND_LIST) {
    const list = d[key]
    if (list !== undefined) {
      for (const sub of list as readonly unknown[]) {
        if (walkSchemaTree(sub as z.ZodType, visit, visited)) return true
      }
    }
  }
  if (typeof d.getter === 'function') {
    try {
      const inner = (d.getter as () => unknown)() as z.ZodType
      if (walkSchemaTree(inner, visit, visited)) return true
    } catch {
      // Lazy resolution can throw pre-construction; no match, continue.
    }
  }
  return false
}

export function containsDiscriminatedUnion(schema: z.ZodType, seen?: WeakSet<object>): boolean {
  return walkSchemaTree(schema, (node) => kindOf(node) === 'discriminated-union', seen)
}

export function containsAsyncRefine(schema: z.ZodType, seen?: WeakSet<object>): boolean {
  return walkSchemaTree(
    schema,
    (node) => {
      for (const check of getChecks(node)) {
        if (isAsyncCheck(check)) return true
      }
      return false
    },
    seen
  )
}

const CONTAINER_KEYS = [
  'shape',
  'entries',
  'element',
  'options',
  'items',
  'keyType',
  'valueType',
  'left',
  'right',
] as const

export function hasContainerOrRootRefine(schema: z.ZodType, seen?: WeakSet<object>): boolean {
  return walkSchemaTree(
    schema,
    (node) => {
      const def = readDef(node)
      if (def === undefined) return false
      const d = def as Record<string, unknown>
      if (!CONTAINER_KEYS.some((k) => d[k] !== undefined)) return false
      return getChecks(node).length > 0
    },
    seen
  )
}

export function containsAsyncTransform(schema: z.ZodType, seen?: WeakSet<object>): boolean {
  return walkSchemaTree(
    schema,
    (node) => {
      const fn = readDef(node)?.transform
      if (typeof fn !== 'function') return false
      return (fn as { constructor: { name: string } }).constructor.name === 'AsyncFunction'
    },
    seen
  )
}

interface ZodCheckInternals {
  _def?: { fn?: unknown }
  def?: { fn?: unknown }
  _zod?: { def?: { fn?: unknown } }
}

export function isAsyncCheck(check: unknown): boolean {
  if (typeof check !== 'object' || check === null) return false
  const c = check as ZodCheckInternals
  const fn = c._def?.fn ?? c.def?.fn ?? c._zod?.def?.fn
  if (typeof fn !== 'function') return false
  return fn.constructor.name === 'AsyncFunction'
}
