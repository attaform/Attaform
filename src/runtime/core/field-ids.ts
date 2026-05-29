import { ANONYMOUS_FORM_KEY_PREFIX } from './defaults'
import { hashStableString } from './hash'
import type { PathKey } from './paths'

// Fixed stem substituted for anonymous forms (synthetic `__atta:anon:*`
// keys) and for keys that sanitize to empty. Keeps the reserved
// internal prefix out of the DOM and gives every id a readable lead.
const ANON_STEM = 'atta'

// Length of the path token appended after the readable stem. Seven
// base36 chars is ~36 bits, ample to keep distinct paths within one
// form distinct, while staying short enough to read in devtools.
const TOKEN_LENGTH = 7

/**
 * Readable, id-safe lead for a field id, derived from the form's key.
 * Anonymous forms (and keys that sanitize to nothing) collapse to a
 * fixed stem so the synthetic `__atta:anon:*` key never reaches the
 * DOM. Any character outside `[A-Za-z0-9_-]` is replaced, since
 * whitespace in an id would tokenize an `aria-describedby` reference
 * and silently resolve to nothing.
 */
export function readableFormKeyStem(formKey: string): string {
  if (formKey === '' || formKey.startsWith(ANONYMOUS_FORM_KEY_PREFIX)) return ANON_STEM
  // The trailing-trim branch uses a negative lookbehind so it can only
  // start matching at the boundary BEFORE a run of hyphens. The naive
  // `-+$` shape (CodeQL js/polynomial-redos) tries to start matching at
  // every position in a long internal hyphen run and walks to `$` from
  // each, giving O(n²) worst-case on inputs like `a---…---b`.
  const sanitized = formKey.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|(?<!-)-+$/g, '')
  return sanitized === '' ? ANON_STEM : sanitized
}

/**
 * Deterministic short token for one field, folding the form's
 * per-mount instance id together with the field's canonical path key.
 *
 * Folding the instance id is load-bearing: two live mounts of the same
 * keyed form produce different ids, which is what keeps a shared
 * `aria-describedby` from resolving to the first matching id in tree
 * order (the silent duplicate-id failure mode). Folding the path key
 * keeps distinct fields within one mount distinct.
 */
export function fieldIdToken(formInstanceId: string, pathKey: PathKey): string {
  return hashStableString(`${formInstanceId}:${pathKey}`).slice(-TOKEN_LENGTH)
}

/**
 * The id surface for one field: its own `id` plus the satellite ids a
 * consumer wires to error and description elements. Pure function of
 * `(formInstanceId, formKey, pathKey)` — stable for a path across a
 * form's lifetime, structurally unique across mounts.
 */
export type FieldIdentity = {
  readonly id: string
  readonly aria: {
    readonly errorId: string
    readonly descriptionId: string
  }
}

/**
 * Build the {@link FieldIdentity} for a path. The `id` is
 * `<readable-stem>-<token>`; the satellite ids suffix it so they read
 * as obviously belonging to the same field (`signup-a3f9c2k`,
 * `signup-a3f9c2k-error`, `signup-a3f9c2k-description`).
 */
export function computeFieldIdentity(
  formInstanceId: string,
  formKey: string,
  pathKey: PathKey
): FieldIdentity {
  const id = `${readableFormKeyStem(formKey)}-${fieldIdToken(formInstanceId, pathKey)}`
  return {
    id,
    aria: Object.freeze({ errorId: `${id}-error`, descriptionId: `${id}-description` }),
  }
}
