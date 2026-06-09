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
  meta: FormMetaLike
  // `blankPaths` is a ComputedRef<BlankPathsView>; the view is on `.value`.
  blankPaths: { value: { values(): ReadonlyArray<ReadonlyArray<string | number>> } }
}

/** Walk the `fields` drill-down proxy to the FieldState at a dotted path. */
function readField(fieldsRoot: unknown, dotPath: string): Readonly<FieldState> {
  let node: unknown = fieldsRoot
  for (const segment of dotPath.split('.')) {
    node = (node as Record<string, unknown>)[segment]
  }
  return node as Readonly<FieldState>
}

function normalizeAria(ariaId: string, id: string, suffix: 'error' | 'description'): string {
  // Lock the derivation contract, then redact the volatile id portion. A
  // surprise (aria id NOT derived from id) surfaces loudly in the golden.
  return ariaId === `${id}-${suffix}` ? `${REDACTED_ID}-${suffix}` : `UNEXPECTED:${ariaId}`
}

/** Normalize one FieldState into a stable, serializable record. */
export function captureField(field: Readonly<FieldState>): Record<string, unknown> {
  const id = field.id
  return {
    value: field.value,
    original: field.original,
    pristine: field.pristine,
    dirty: field.dirty,
    focused: field.focused,
    blurred: field.blurred,
    touched: field.touched,
    interacted: field.interacted,
    blurredAfterInteraction: field.blurredAfterInteraction,
    connected: field.connected,
    updatedAt: field.updatedAt === null ? null : REDACTED_TS,
    errors: field.errors.map((e) => ({ code: e.code, path: e.path })),
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
    path: field.path,
    id: REDACTED_ID,
    aria: {
      errorId: normalizeAria(field.aria.errorId, id, 'error'),
      descriptionId: normalizeAria(field.aria.descriptionId, id, 'description'),
    },
    key: field.key,
    blank: field.blank,
    label: field.label,
    description: field.description ?? null,
    placeholder: field.placeholder ?? null,
    meta: field.meta,
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

/**
 * Capture the full observable surface for a scenario: per-field state at
 * each declared path, the form-level meta, and the blank-path set.
 */
export function captureForm(form: FormLike, fieldPaths: string[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const path of fieldPaths) fields[path] = captureField(readField(form.fields, path))
  return {
    fields,
    meta: captureFormMeta(form.meta),
    blankPaths: form.blankPaths.value
      .values()
      .map((segments) => segments.join('.'))
      .sort(),
  }
}
