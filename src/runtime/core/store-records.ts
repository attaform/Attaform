import type { Path } from './paths'

// Per-path record shapes stored in a FormStore's keyed Maps. They live
// here, not in create-form-store, so the arrays engine can reference them
// without importing the store module back (which would form an import
// cycle).

/**
 * Per-path field status. Replaced wholesale (not mutated in place) on
 * every change. Five semantic groups:
 *
 *   - `connected` — is a DOM element registered for this path?
 *   - `focused` / `blurred` — DOM-state flags. `null` while no element
 *     is connected (no DOM means the concepts don't apply); plain
 *     booleans once connected, with the invariant `blurred === !focused`
 *     enforced by `markFocused`.
 *   - `touched` — focus/blur history, not DOM state. Always a plain
 *     boolean: `false` at registration, sticky `true` after first blur,
 *     cleared only by `form.reset()` / `form.resetField(path)`. Persists
 *     across disconnects so v-if'd-away fields don't lose their touched
 *     state on rehide (wizard "show review of touched fields" patterns
 *     rely on this).
 *   - `interacted` — value-mutation history, not DOM state. Plain
 *     boolean: `false` at registration, sticky `true` once the user
 *     issues a value edit through the directive's input listeners
 *     (never on hydration, default seeding, or programmatic setValue);
 *     cleared with `touched` by `form.reset()` / `form.resetField(path)`.
 *   - `blurredAfterInteraction` — the first blur that follows a value
 *     edit (the field has been edited and then left). Plain boolean,
 *     sticky `true`. A tab-through blur with no prior edit does NOT set
 *     it (`interacted` is still false at that blur). Composes
 *     `interacted` with the departure; drives the default display gate.
 */
export type FieldRecord = {
  readonly path: Path
  readonly updatedAt: string | null
  readonly connected: boolean
  readonly focused: boolean | null
  readonly blurred: boolean | null
  readonly touched: boolean
  readonly interacted: boolean
  readonly blurredAfterInteraction: boolean
}

/** Per-path DOM element tracking. Client-only. */
export type ElementRecord = {
  /**
   * Original Path captured at first registration. Stored alongside the
   * elements Set so the DOM-order sort cache can recover the structured
   * Path without round-tripping through `JSON.parse(pathKey)`.
   */
  readonly path: Path
  readonly elements: Set<HTMLElement>
}

/**
 * Per-path record stored in `originals`. Pairing `segments` with the tracked
 * value means `dirty` and `resetField`'s container loop don't have to
 * `JSON.parse(pathKey)` on every iteration — the canonical Path is already
 * sitting next to the value it belongs to. PathKey still keys the Map (the
 * stable string is the only collision-free identifier), but downstream
 * iteration reads `segments` directly.
 */
export type OriginalsRecord = {
  readonly segments: Path
  readonly value: unknown
}
