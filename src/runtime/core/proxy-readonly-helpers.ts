import { __DEV__ } from './dev'

/**
 * Warn-and-noop trap helper shared by every readonly proxy in the
 * surface layer (`form.values`, `form.errors`, `form.fields`,
 * `wizard.statuses`). Returning `true` from the calling `set` /
 * `deleteProperty` / `defineProperty` trap keeps strict-mode callers
 * from throwing — the readonly contract is enforced by the absence
 * of any actual mutation, not by tripping a host-level `TypeError`.
 * Aligns with PASS2-4 + PASS2-12 from the audit.
 *
 * `surface` is the human-readable surface name that appears in the
 * dev warning (e.g. `'form.values'`, `'wizard.statuses'`). `action`
 * picks the verb (`write` for `set`, `delete` for `deleteProperty`,
 * `define` for `defineProperty`). `key` is forwarded as-is and
 * stringified at the call site so consumers see the offending member.
 */
export function warnReadOnly(
  surface: string,
  action: 'write' | 'delete' | 'define',
  key: PropertyKey
): void {
  if (!__DEV__) return
  const phrase = action === 'write' ? `write to "${String(key)}"` : `${action} of "${String(key)}"`
  console.warn(
    `[attaform] ${surface} is read-only — ${phrase} was ignored. Mutate the form via setValue / the directive / field-array helpers instead.`
  )
}

/**
 * The four primitive-coercion handlers every callable readonly proxy
 * needs: `toString` (JSON), `valueOf` (identity), `toJSON` (snapshot),
 * and `Symbol.toPrimitive` (NaN for `'number'`, JSON otherwise).
 *
 * The triplet was hand-rolled across five proxy files
 * (`values-proxy`, `wizard-statuses-proxy`, `surface-proxy`'s
 * container + leaf-view branches, `field-state-proxy`'s call-form
 * terminal). The helper consolidates the shape so each surface only
 * supplies its own `snapshot` getter and the four coercion behaviors
 * stay byte-equivalent across the lot.
 *
 * Reactivity contract: every coercion call reads `snapshot()` fresh,
 * so reactive deps the snapshot touches re-track inside the
 * consumer's active effect on every stringify / template-coercion
 * pass — the helper itself caches nothing.
 *
 * `valueOf` returns the receiver (the proxy itself, via dynamic
 * `this`). Returning a non-primitive keeps OrdinaryToPrimitive's
 * `valueOf` → `toString` fallback well-formed for any code path that
 * bypasses the `Symbol.toPrimitive` shortcut.
 */
export interface ReadonlyCoercion<T> {
  toString: () => string
  valueOf: (this: unknown) => unknown
  toJSON: () => T
  toPrimitive: (hint: string) => string | number
}

export function makeReadonlyCoercion<T>(snapshot: () => T): ReadonlyCoercion<T> {
  const toString = (): string => JSON.stringify(snapshot())
  return {
    toString,
    valueOf(this: unknown): unknown {
      return this
    },
    toJSON: snapshot,
    toPrimitive: (hint: string): string | number => (hint === 'number' ? NaN : toString()),
  }
}
