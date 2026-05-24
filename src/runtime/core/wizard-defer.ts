import type { AnyForm, DeferMarker, WizardCtx } from '../types/types-wizard'

/**
 * Runtime brand for `DeferMarker` instances. Backed by `Symbol.for` so
 * cross-bundle / SSR realms agree on identity. The matching phantom
 * brand on the `DeferMarker` type lives in `types/types-wizard.ts`;
 * runtime identity is structural via `isDeferMarker`.
 */
const DEFER_BRAND = Symbol.for('attaform/wizard-defer')

/**
 * Wrap a function slot in `defer()` to opt that specific slot into
 * lazy-sticky resolution.
 *
 * Default function slots in `useWizard({ steps })` evaluate eagerly at
 * wizard construction and re-evaluate reactively when their reads
 * change. That keeps `wizard.steps`, `wizard.forms`, and the step rail
 * accurate from `t=0`, which is what SSR markup and deterministic
 * deep-link routing rely on.
 *
 * `defer()` reverses that for slots whose resolution is expensive,
 * async, or only meaningful once the user reaches the position:
 *
 *   const wizard = useWizard({
 *     steps: [
 *       account,
 *       defer((ctx) => loadShippingForm(ctx)),
 *       confirm,
 *     ],
 *   })
 *
 * Resolution semantics:
 *  - The wrapped slot stays unresolved until navigation lands on its
 *    position for the first time.
 *  - Once resolved, the result sticks. Subsequent departures and
 *    returns reuse the same form ref; the slot does not re-evaluate.
 *  - Resolving to `undefined` drops the slot from the compiled list
 *    at the resolution moment.
 *
 * The runtime brand returned by `defer()` is opaque. Use
 * {@link isDeferMarker} to detect it.
 */
export function defer<Ctx = WizardCtx>(
  resolve: (ctx: Ctx) => AnyForm | string | undefined
): DeferMarker<Ctx> {
  return { [DEFER_BRAND]: true, resolve } as unknown as DeferMarker<Ctx>
}

/**
 * Type guard for the brand returned by {@link defer}. Used by the
 * wizard's slot compiler to distinguish lazy-sticky slots from eager
 * function slots and from raw `AnyForm` / `string` slots.
 */
export function isDeferMarker(value: unknown): value is DeferMarker {
  return typeof value === 'object' && value !== null && DEFER_BRAND in value
}
