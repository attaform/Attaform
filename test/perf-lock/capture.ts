/**
 * Normalizes a form handle's observable surface into a deterministic,
 * serializable snapshot for the behavior-lock harness.
 *
 * Volatile, mount-specific fields are redacted to placeholders so the
 * golden is stable across runs, WHILE their structural contracts are
 * preserved:
 *   - `updatedAt` (ISO timestamp) -> '<ts>' when set, `null` when never
 *     written (locks the "is there a timestamp" behavior, not the value).
 *   - `id` (opaque, instanceId+path-hash) -> '<id>'; `aria.*` is verified
 *     to derive as `${id}-error` / `${id}-description` then redacted,
 *     locking the derivation contract.
 *   - `instanceId` -> '<instance>'.
 *   - error MESSAGES are excluded entirely: they are zod-authored and
 *     differ across v3/v4 and zod versions, so they are NOT an Attaform
 *     behavior. We lock the normalized structure (code + path) only.
 */
import type { FieldState } from '../../src/runtime/types/types-api'

const REDACTED_ID = '<id>'
const REDACTED_TS = '<ts>'
const REDACTED_INSTANCE = '<instance>'

/**
 * Deep-snapshot an object/array value so a capture FREEZES it at this
 * checkpoint, instead of aliasing the live reactive tree (which would make
 * every checkpoint serialize the final state). Primitives pass through.
 */
function snapshot<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  return JSON.parse(JSON.stringify(value)) as T
}

/** Form-level meta is a FieldState of the whole form plus submit counters. */
export type FormMetaLike = Readonly<FieldState> & {
  submitting: boolean
  submissionAttempts: number
  departAttempts: number
  submitError: { message?: string } | null
  errorCount: number
  submitted: boolean
}

/** Minimal structural view of the form handle the capture reads. */
export type FormLike = {
  fields: unknown
  list: (path: string) => ReadonlyArray<Readonly<FieldState>>
  meta: FormMetaLike
  // `blankPaths` is a ComputedRef<BlankPathsView>; the view is on `.value`.
  blankPaths: { value: { values(): ReadonlyArray<ReadonlyArray<string | number>> } }
}

/** Walk the `fields` drill-down proxy to the FieldState at a dotted path. */
function readField(fieldsRoot: unknown, dotPath: string): Readonly<FieldState> {
  let node: unknown = fieldsRoot
  for (const segment of dotPath.split('.')) {
    // Numeric segments index into array nodes; pass them as numbers.
    const key = /^\d+$/.test(segment) ? Number(segment) : segment
    node = (node as Record<string | number, unknown>)[key]
  }
  return node as Readonly<FieldState>
}

function normalizeAria(ariaId: string, id: string, suffix: 'error' | 'description'): string {
  // Lock the derivation contract, then redact the volatile id portion. A
  // surprise (aria id NOT derived from id) surfaces loudly in the golden.
  return ariaId === `${id}-${suffix}` ? `${REDACTED_ID}-${suffix}` : `UNEXPECTED:${ariaId}`
}

/** Normalize one FieldState into a stable, serializable record. */
export function captureField(
  field: Readonly<FieldState>,
  normalizeKey: (key: string) => string = (k) => k
): Record<string, unknown> {
  const id = field.id
  return {
    value: snapshot(field.value),
    original: snapshot(field.original),
    pristine: field.pristine,
    dirty: field.dirty,
    focused: field.focused,
    blurred: field.blurred,
    touched: field.touched,
    interacted: field.interacted,
    blurredAfterInteraction: field.blurredAfterInteraction,
    connected: field.connected,
    updatedAt: field.updatedAt === null ? null : REDACTED_TS,
    errors: field.errors.map((e) => ({ code: e.code, path: snapshot(e.path) })),
    validating: field.validating,
    valid: field.valid,
    transforming: field.transforming,
    busy: field.busy,
    transformError: field.transformError === null ? null : String(field.transformError.message),
    displayState: field.displayState,
    showErrors: field.showErrors,
    showPending: field.showPending,
    showSuccess: field.showSuccess,
    showIdle: field.showIdle,
    firstError: field.firstError === undefined ? null : field.firstError.code,
    path: snapshot(field.path),
    id: REDACTED_ID,
    aria: {
      errorId: normalizeAria(field.aria.errorId, id, 'error'),
      descriptionId: normalizeAria(field.aria.descriptionId, id, 'description'),
    },
    key: field.key === '' ? '' : normalizeKey(field.key),
    blank: field.blank,
    label: field.label,
    description: field.description ?? null,
    placeholder: field.placeholder ?? null,
    meta: snapshot(field.meta),
  }
}

/** Normalize the form-level meta (FieldState-of-form + submit counters). */
export function captureFormMeta(meta: FormMetaLike): Record<string, unknown> {
  return {
    ...captureField(meta),
    submitting: meta.submitting,
    submissionAttempts: meta.submissionAttempts,
    departAttempts: meta.departAttempts,
    submitError: meta.submitError === null ? null : String(meta.submitError.message),
    errorCount: meta.errorCount,
    submitted: meta.submitted,
    instanceId: REDACTED_INSTANCE,
  }
}

/** First-appearance ordinal normalizer for opaque array-element keys. */
export function makeKeyNormalizer(): (key: string) => string {
  const seen = new Map<string, string>()
  return (key: string): string => {
    let ordinal = seen.get(key)
    if (ordinal === undefined) {
      ordinal = `<k${seen.size}>`
      seen.set(key, ordinal)
    }
    return ordinal
  }
}

/** Capture spec for a field array: the array path + leaf sub-paths per element. */
export type ArraySpec = { path: string; leaves: string[] }

/**
 * Capture a field array as an ordered list of per-element records. The element
 * `key` (opaque, mount-specific) is normalized to a first-appearance ordinal,
 * so the golden locks IDENTITY STABILITY across mutations (a row that keeps its
 * key through an insert/move keeps its ordinal), not the raw token.
 */
function captureList(
  form: FormLike,
  spec: ArraySpec,
  normalizeKey: (key: string) => string
): Array<Record<string, unknown>> {
  const elements = form.list(spec.path)
  return elements.map((element, index) => {
    const fields: Record<string, unknown> = {}
    for (const leaf of spec.leaves) {
      fields[leaf] = captureField(
        readField(form.fields, `${spec.path}.${index}.${leaf}`),
        normalizeKey
      )
    }
    return {
      key: element.key === '' ? '' : normalizeKey(element.key),
      element: captureField(element, normalizeKey),
      fields,
    }
  })
}

/**
 * Capture the full observable surface for a scenario: per-field state at each
 * declared path, the form-level meta, the blank-path set, and (when the
 * scenario declares arrays) the per-array list capture.
 */
export function captureForm(
  form: FormLike,
  fieldPaths: string[],
  arrays: ArraySpec[] = [],
  normalizeKey: (key: string) => string = (k) => k
): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const path of fieldPaths) {
    fields[path] = captureField(readField(form.fields, path), normalizeKey)
  }
  const capture: Record<string, unknown> = {
    fields,
    meta: captureFormMeta(form.meta),
    blankPaths: form.blankPaths.value
      .values()
      .map((segments) => segments.join('.'))
      .sort(),
  }
  if (arrays.length > 0) {
    const lists: Record<string, unknown> = {}
    for (const spec of arrays) lists[spec.path] = captureList(form, spec, normalizeKey)
    capture['lists'] = lists
  }
  return capture
}
