import type { GateMarker, StepSlot } from '../types/types-wizard'

/**
 * Runtime brand for `GateMarker` instances. Backed by `Symbol.for` so
 * cross-bundle / SSR realms agree on identity. The matching phantom
 * brand on the `GateMarker` type lives in `types/types-wizard.ts`;
 * runtime identity is structural via `isGateMarker`.
 */
const GATE_BRAND = Symbol.for('attaform/wizard-gate')

/**
 * Wrap a step slot in `gate()` to make it a hard prerequisite: while the
 * gate is uncleared, every step positioned after it is inaccessible, and
 * the gate's own form is the only way past.
 *
 * A gate is safe by construction. It does not hand the consumer a
 * predicate to key on; it bakes the correct semantics in:
 *
 *  - **Confirmation, not intent.** The gate clears only when a member
 *    form submits clean, never when a value merely goes valid. Checking
 *    the box does nothing; submitting the consent step is what opens the
 *    rail. This is the whole reason `gate()` exists: a leading value
 *    signal lets a downstream step collect data before the prerequisite
 *    is confirmed.
 *  - **Linear-forward.** An uncleared gate seals every step after it.
 *    Order places it: put `gate(step)` immediately before what it
 *    guards. Everything downstream is both un-navigable and, through the
 *    `disabled` data freeze, un-fillable, so a deep link, the browser
 *    back button, or a stray `goTo` all redirect to the gate.
 *  - **Freeze-after-clear.** A cleared gate's own form freezes, so
 *    navigating back to it is a read-only review with no withdrawal
 *    path. There is no re-lock dance.
 *
 * Wrap any slot kind:
 *
 *   const wizard = useWizard({ steps: [gate(consent), shipping, payment] })
 *
 * A **form** gate (`gate(consentForm)`) clears when its form submits
 * clean, and is treated as pre-cleared on reload when its member form
 * rehydrates already valid (a persisted consent), so a seeded-valid gate
 * SSR-renders open. A bare-string **affordance** gate (`gate('terms')`)
 * clears on acknowledgment (advancing past it), and re-prompts each
 * session because that acknowledgment is ephemeral.
 *
 * Conditional gates come from composition, not an options bag:
 *
 *   () => (transfer.values.amount > 10_000 ? gate(kyc) : kyc)
 *
 * `gate()` composes with `lazy()` in either order:
 * `gate(lazy(fn))` and `lazy((ctx) => gate(fn(ctx)))` resolve
 * identically.
 *
 * The runtime brand returned by `gate()` is opaque. Use
 * {@link isGateMarker} to detect it.
 */
export function gate<const Inner extends StepSlot>(step: Inner): GateMarker<Inner> {
  return { [GATE_BRAND]: true, inner: step } as unknown as GateMarker<Inner>
}

/**
 * Type guard for the brand returned by {@link gate}. Used by the
 * wizard's slot compiler to detect a gated position while normalizing a
 * slot, so it can mark every step after the gate locked until the gate
 * clears.
 */
export function isGateMarker(value: unknown): value is GateMarker {
  return typeof value === 'object' && value !== null && GATE_BRAND in value
}
