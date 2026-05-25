import type { AnyForm, LazyMarker, WizardCtx } from '../types/types-wizard'

/**
 * Runtime brand for `LazyMarker` instances. Backed by `Symbol.for` so
 * cross-bundle / SSR realms agree on identity. The matching phantom
 * brand on the `LazyMarker` type lives in `types/types-wizard.ts`;
 * runtime identity is structural via `isLazyMarker`.
 */
const LAZY_BRAND = Symbol.for('attaform/wizard-lazy')

/**
 * Wrap a function slot in `lazy()` to give that slot its own memoized
 * cache, distinct from the wizard-wide step compiler.
 *
 * Default function slots in `useWizard({ steps })` re-evaluate whenever
 * the compiled step list re-evaluates, including when an unrelated
 * slot's reactive deps change. That keeps the rail correct but can
 * trigger spurious work in a resolver that is expensive (a network
 * lookup, a heavy schema derivation, an async-derived factory).
 *
 * `lazy()` isolates each wrapped slot behind its own cache. The
 * resolver runs eagerly on the first compile pass; subsequent reads
 * reuse the cached form. The cache invalidates only when one of the
 * resolver's own tracked reactive dependencies changes (Vue's
 * `computed` semantics applied to a slot), or when `wizard.reset()`
 * triggers a global re-compile:
 *
 *   const wizard = useWizard({
 *     steps: [
 *       account,
 *       lazy((ctx) => loadShippingForm(ctx.forms.account.values.region)),
 *       confirm,
 *     ],
 *   })
 *
 * Resolution semantics:
 *  - Eager at construction so `wizard.steps` and SSR markup are honest
 *    from t=0.
 *  - Memoized: the resolver re-fires only when one of its own tracked
 *    reads changes. An unrelated slot re-evaluating does not re-fire
 *    this one.
 *  - `wizard.reset()` clears every lazy slot's cache so a reboot truly
 *    resolves from scratch.
 *  - Resolving to `undefined` drops the slot from the compiled list
 *    until the resolver next re-fires.
 *
 * The runtime brand returned by `lazy()` is opaque. Use
 * {@link isLazyMarker} to detect it.
 */
export function lazy<Ctx = WizardCtx>(
  resolve: (ctx: Ctx) => AnyForm | string | undefined
): LazyMarker<Ctx> {
  return { [LAZY_BRAND]: true, resolve } as unknown as LazyMarker<Ctx>
}

/**
 * Type guard for the brand returned by {@link lazy}. Used by the
 * wizard's slot compiler to distinguish lazy memoized slots from eager
 * function slots and from raw `AnyForm` / `string` slots.
 */
export function isLazyMarker(value: unknown): value is LazyMarker {
  return typeof value === 'object' && value !== null && LAZY_BRAND in value
}
