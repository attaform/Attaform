/**
 * Single source of truth for the set of HTML form-element tag names
 * Attaform treats as "interactive value-bearing": the elements whose
 * default behaviour produces a model-relevant `change`/`input` event
 * and whose `value` / `checked` / `selectedIndex` properties the
 * v-register directive and `useRegister` composable own end-to-end.
 *
 * Both `directive.ts` (gating the unsupported-tag dev-warn and the
 * static-fallback path) and `register-api.ts` (gating focus/blur listener
 * attachment in the composable) MUST read this one set. Two parallel sets
 * gating the same predicate is the silent-drift risk audit finding DIR-F2
 * named.
 *
 * Tag names are uppercase to match `element.tagName` (the HTML spec
 * uppercases element tag names on the DOM side regardless of the
 * source's casing). Membership checks therefore work against the
 * native `.tagName` property without case normalization.
 */
export const INTERACTIVE_TAG_NAMES: ReadonlySet<string> = new Set(['INPUT', 'SELECT', 'TEXTAREA'])
