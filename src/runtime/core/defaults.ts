/**
 * Library-level default constants. Every consumer-facing fallback
 * (`debounceMs`, `history.max`) resolves to one of these, so the JSDoc on
 * a public option type and the runtime fallback behind it stay in
 * lockstep and there is one file to scan when tuning a default.
 *
 * Per-form `useForm({ ... })` options always win over these.
 */

import { __DEV__ } from './dev'

/**
 * Validation debounce (`useForm({ debounceMs })`): ms to wait after the
 * LAST input event before running validation. Default `0`, debounce
 * disabled, so every committed write fires a validation pass
 * synchronously with no `setTimeout`. That matches the obvious mental
 * model and avoids the "why is my error 125 ms behind my keystroke?"
 * footgun. Opt into coalescing with `debounceMs: 200` when an adapter is
 * genuinely expensive.
 *
 * This is purely the VALIDATION debounce. Storage (`form.values`) commits
 * on every write the directive forwards, and `setValueWithInternalPath`
 * writes immediately and schedules validation. WHEN the directive
 * forwards a write is a separate concern owned by the input modifiers:
 * `<input v-register>` commits on every keystroke (`input`), while
 * `<input v-register.lazy>` defers to `change` and so commits on blur.
 * The debounce counts ms since the last committed write either way.
 */
export const DEFAULT_FIELD_VALIDATION_DEBOUNCE_MS = 0

/**
 * Undo/redo stack ceiling (`history.max`). 128 covers an extended editing
 * session (long-form text, a multi-page wizard, heavy iteration on a
 * complex form) without unbounded growth on a long-lived form. History is
 * one base snapshot plus per-mutation forward deltas, and a delta
 * normally carries only the leaves that changed, so the per-mutation cost
 * is `O(changed-leaf-count)` rather than `O(form-leaf-count)`. The cap is
 * there for predictability more than for memory pressure.
 */
export const DEFAULT_HISTORY_MAX_SNAPSHOTS = 128

/**
 * Reserved namespace for Attaform's internal synthetic keys. At
 * construction `useAbstractForm` throws `ReservedFormKeyError` on any
 * consumer key carrying this prefix, so a collision with the synthetic
 * namespace is impossible. The double-underscore convention reads as
 * "internal" everywhere, so a consumer is unlikely to reach for it.
 */
export const RESERVED_KEY_PREFIX = '__atta:'

/**
 * Synthetic-key prefix for `useForm()` calls without an explicit `key`.
 * Inside the reserved `__atta:` namespace, so `resolveFormKey`'s
 * entry-level reject covers it; see `RESERVED_KEY_PREFIX`.
 */
export const ANONYMOUS_FORM_KEY_PREFIX = `${RESERVED_KEY_PREFIX}anon:`

/**
 * Synthetic-key prefix for `useWizard()` calls without an explicit `key`.
 * Kept separate from `ANONYMOUS_FORM_KEY_PREFIX` so a `wizard.forms[key]`
 * lookup cannot collide with a synthetic wizard key even when a consumer
 * iterates both spaces. Same `__atta:` namespace, same enforcement.
 */
export const ANONYMOUS_WIZARD_KEY_PREFIX = `${RESERVED_KEY_PREFIX}anon-wizard:`

/**
 * Recursion ceiling for schema walks that descend a recursive schema
 * (Zod's `z.lazy(...)`, and whatever a future adapter's equivalent is).
 * Every adapter walk that crosses a recursive boundary (default
 * derivation, slim-primitive type gates, path resolution, refinement
 * stripping) tracks its descent depth and bails with a permissive
 * fallback once `depth > maxRecursionDepth`.
 *
 * Fixed at `64`, and not a consumer option: deep enough that no realistic
 * recursive form reaches it, shallow enough that a schema with no
 * structural terminator hits the cap instead of the JS call stack.
 *
 * "Permissive fallback" means the gate stops type-checking past the cap.
 * Storage accepts the consumer's value and runtime validation still runs
 * against the real schema, so a tree deeper than the cap still works; its
 * deeper writes just skip the slim-primitive type gate.
 */
export const DEFAULT_MAX_RECURSION_DEPTH = 64

/**
 * Normalise a consumer-supplied numeric option (`debounceMs` and
 * `history.max`) before it reaches runtime logic. An unsanitised value
 * fails silently rather than loudly:
 *
 *   - `NaN`: comparison gates (`>=`, `>`) are `false` against it, so a
 *     cap never trips and a pathological input runs unbounded, and
 *     `setTimeout(fn, NaN)` fires synchronously, defeating the debounce.
 *   - Negative: comparison gates trip too eagerly, and the visible value
 *     does not match what the consumer meant.
 *   - Non-integer: `>=` against `5.7` works but is imprecise.
 *   - Non-number (a JS caller defying TS): undefined behaviour at every
 *     comparison and arithmetic site.
 *
 * So `Infinity` / `NaN` / `-Infinity` / non-numbers fall back to
 * `defaultValue` with a dev-warn naming the source, negative finite
 * numbers clamp to `min`, and non-integer positives floor. The fallback
 * never throws: a bad option is not worth a fatal construction, and the
 * dev-warn surfaces the misuse without breaking production.
 */
export interface NormalizeNumericOptionConfig {
  /** The consumer-supplied value to validate. */
  value: number
  /**
   * Identifier for the dev warning, formatted like `useForm.debounceMs`
   * so the warning names the option that carried the bad value.
   */
  source: string
  /** Lower bound applied via `Math.max(min, ...)` after `Math.floor`. */
  min: number
  /**
   * Library default returned when the input is invalid (`NaN`,
   * `±Infinity`, or a non-number).
   */
  defaultValue: number
}

export function normalizeNumericOption(config: NormalizeNumericOptionConfig): number {
  const { value, source, min, defaultValue } = config
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    if (__DEV__) {
      console.warn(
        `[attaform] ${source} must be a non-negative finite integer; ` +
          `got ${String(value)}. Falling back to ${String(defaultValue)}.`
      )
    }
    return defaultValue
  }
  return Math.max(min, Math.floor(value))
}

/**
 * Copy of `bag` with every `undefined`-valued key dropped. Under
 * `exactOptionalPropertyTypes` an omitted optional property and an
 * explicit `undefined` are different types, so an option bag is assembled
 * by resolving each candidate and keeping only the defined ones.
 */
export function pickDefined<T extends Record<string, unknown>>(
  bag: T
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(bag)) {
    if (bag[key] !== undefined) out[key] = bag[key]
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> }
}
