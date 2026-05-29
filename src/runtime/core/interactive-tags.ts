/**
 * Single source of truth for the set of HTML form-element tag names
 * Attaform treats as "interactive value-bearing" — the elements whose
 * default behaviour produces a model-relevant `change`/`input` event
 * and whose `value` / `checked` / `selectedIndex` properties the
 * v-register directive and `useRegister` composable own end-to-end.
 *
 * Both `directive.ts` (gate the unsupported-tag dev-warn + the
 * static-fallback path) and `register-api.ts` (gate focus/blur
 * listener attachment in the composable) read this same set. Pre-
 * dedup each file declared its own copy in a different order, with
 * nothing tying them together — the audit DIR-F2 flagged the silent-
 * drift risk that comes with two parallel sets gating the same
 * predicate.
 *
 * Tag names are uppercase to match `element.tagName` (the HTML spec
 * uppercases element tag names on the DOM side regardless of the
 * source's casing). Membership checks therefore work against the
 * native `.tagName` property without case normalization.
 */
export const INTERACTIVE_TAG_NAMES: ReadonlySet<string> = new Set(['INPUT', 'SELECT', 'TEXTAREA'])
