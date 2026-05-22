/**
 * Public types for `useWizard` — the multistep-form orchestrator.
 *
 * The wizard composes existing `useForm` instances. Each step is a
 * form with its own schema, key, validation, and persistence; the
 * wizard layers navigation, status aggregation, and activation
 * lifecycle on top.
 *
 * Discriminated `current` is the load-bearing type. Threading the
 * literal `K` through `useForm` (see `UseFormReturnType<..., K>`)
 * means `wizard.current` resolves to the union of participating
 * keys, and `goTo(key)` autocompletes that union.
 */

import type { FormKey } from './types-api'

/**
 * Minimum structural shape the wizard requires from a participating
 * form. Constraining to the full `UseFormReturnType` would force
 * contravariant unification of the storage / read shapes across all
 * steps; the wizard does not care about those — it routes by `key`
 * at runtime and exposes the original form objects untouched.
 *
 * `UseFormReturnType<...>` satisfies this shape because its `key`
 * field is `readonly key: K extends FormKey`.
 */
export type AnyForm = { readonly key: FormKey }

/**
 * Extracts the literal key from a single keyed form's return type.
 * Lets the wizard discriminate `wizard.current` on the form
 * that owns the active step.
 */
export type FormKeyOf<F extends AnyForm> = F['key']

/**
 * Union of keys across an array of forms. With three forms keyed
 * `'a' | 'b' | 'c'`, `KeysOf<typeof forms>` is `'a' | 'b' | 'c'`.
 */
export type KeysOf<Forms extends readonly AnyForm[]> = Forms[number]['key']

/**
 * Branching shape of `useForm({ next })`. The `forms` tuple lists every
 * downstream form reachable from this step; `pick(parsed)` chooses one
 * of them at navigation / submission time from the form's parsed
 * output, or returns `undefined` to signal a dynamic terminal.
 *
 * Declare `forms` as a tuple (`[a, b] as const`) so TypeScript narrows
 * `pick`'s return type to the literal union. Without `as const`, the
 * tuple widens to `AnyForm[]` and narrowing collapses to `AnyForm`.
 *
 * `pick` is consulted only when the current form is valid; the walker
 * may invoke it multiple times across navigation and submission, so
 * the callback should be free of side effects.
 */
export type NextBranching<Parsed, Forms extends readonly AnyForm[]> = {
  readonly pick: (parsed: Parsed) => Forms[number] | undefined
  readonly forms: Forms
}

/**
 * Public `useForm({ next })` option. Two shapes:
 *
 *  - `AnyForm` — identity reference; the form's runtime successor is
 *    always the named form (linear flow).
 *  - `NextBranching` — declared list of possible successors with a
 *    `pick` selector that fires against the form's parsed output.
 *
 * `Parsed` is the schema's `z.output` shape (what `handleSubmit`
 * receives). `Forms` is the literal tuple of declared successors when
 * the consumer used `as const`, falling back to `AnyForm[]` otherwise.
 */
export type NextOption<Parsed = unknown, Forms extends readonly AnyForm[] = readonly AnyForm[]> =
  | AnyForm
  | NextBranching<Parsed, Forms>

/**
 * Internal normalized shape stored on `FormStore.next`. Identity refs
 * are lifted into the `{ pick, forms }` shape so the wizard graph
 * walker reads one uniform contract. `undefined` for terminal forms
 * (no `next` option supplied).
 */
export type NormalizedNext = {
  readonly pick: (parsed: unknown) => AnyForm | undefined
  readonly forms: readonly AnyForm[]
}

/**
 * Per-call navigation options. `replace` reserved for PR 4 (browser
 * history); included now so the call shape is stable across wizard
 * versions.
 */
export type WizardNavOptions = {
  readonly replace?: boolean
}

/**
 * Per-form summary surface — what `wizard.statuses[key]` exposes
 * (and what `defaultStatuses` seeds). Distinct from `form.meta`:
 * `FormStatus` is the cross-step rollup optimized for template
 * ergonomics (`{{ wizard.statuses.cargo.valid }}`), while
 * `form.meta` carries the full per-form lifecycle surface.
 *
 * Field semantics:
 *  - `valid` — `form.meta.valid`. `false` while errors exist or
 *    while the first-validation-done gate has not flipped.
 *  - `dirty` — `form.meta.dirty`. `true` once any value differs
 *    from the original defaults.
 *  - `submitted` — `form.meta.submitted`. `true` once a
 *    `handleSubmit` callback has resolved without throwing. A failed
 *    submit (validation or callback rejection) leaves this `false`;
 *    `submissionAttempts > 0` is the "user has tried" signal.
 *  - `errorCount` — `form.meta.errorCount`. Count of active
 *    validation errors (zero when valid).
 */
export type FormStatus = {
  readonly valid: boolean
  readonly dirty: boolean
  readonly submitted: boolean
  readonly errorCount: number
}

/**
 * `defaultStatuses` and `wizard.statuses` both use this shape — a
 * record keyed by each form's key, with a `FormStatus` payload per
 * key. The mapped type preserves the literal union from
 * `KeysOf<Forms>`, so template autocomplete works without manual
 * type annotations.
 */
export type Statuses<Forms extends readonly AnyForm[]> = {
  readonly [K in KeysOf<Forms>]: FormStatus
}

/**
 * Flat error shape returned by `wizard.allErrors`. Cross-step
 * aggregations need a stable identity per error — `formKey` + `path`
 * — so consumers can render a wizard-wide error summary that links
 * back to the offending field.
 *
 * Sort order: wizard's `forms` order, then each form's internal
 * error order.
 */
export type AggregateError = {
  readonly formKey: FormKey
  readonly path: ReadonlyArray<string | number>
  readonly message: string
  readonly code?: string
}

/**
 * Mirror of `form.values`' call-or-read pattern, one level deep.
 * Drillable as `wizard.statuses.cargo.valid` (readable), as
 * `wizard.statuses('cargo')` (callable single-key), or as
 * `wizard.statuses()` (callable no-arg returns the whole record).
 *
 * `Readonly<S>` provides the readable surface; the call signatures
 * shadow it for `wizard.statuses(key)` and `wizard.statuses()`.
 */
export type WizardStatusesProxy<S extends Record<string, FormStatus>> = ((
  key?: keyof S
) => FormStatus | S) &
  Readonly<S>

/**
 * Browser-history config. `history: true` (the default when the
 * option is omitted) enables `?step=<key>` round-tripping via
 * `window.history.pushState` / `replaceState` / `popstate`.
 * `history: false` disables the integration entirely — useful for
 * embedded wizards where step state lives in component state.
 * `history: { param: 'wiz' }` customises the URL search param.
 */
export type WizardHistoryConfig = {
  readonly enabled?: boolean
  readonly param?: string
}

/**
 * `useWizard(forms, options)` — options is positional-required per
 * the "required internal params" doctrine. PR 3 adds
 * `defaultStatuses`; PR 4 adds `history` + `getServerActiveStep`.
 */
export type WizardOptions<Forms extends readonly AnyForm[] = readonly AnyForm[]> = {
  /**
   * Seed status payload used while a form is pre-resolved (async
   * `defaultValues` in flight, or wizard-deferred non-current).
   * Mirrors `defaultValues`' trichotomy: plain object, sync factory,
   * or async factory.
   *
   * Status resolution priority per form:
   *   1. `store.defaultsResolved === true` → derive from `form.meta`
   *   2. else seed value for this key → frozen seed
   *   3. else → pending sentinel
   *
   * Unknown keys in the seed object throw at construction (typo
   * safety).
   */
  readonly defaultStatuses?:
    | Statuses<Forms>
    | (() => Statuses<Forms>)
    | (() => Promise<Statuses<Forms>>)
  /**
   * Fires whenever a participating form's status (`valid`,
   * `dirty`, `submitted`, or `errorCount`) materially changes —
   * one of those four scalars actually moved. The handler receives
   * the new status and the form whose status changed.
   *
   * Fire-and-forget: a returned promise is NOT awaited. Use a
   * separate \`onBeforeLeave\` (future) for nav-blocking guards.
   *
   * No debounce. The handler fires immediately on Vue's next watch
   * flush after the underlying meta changes — chatter is naturally
   * dampened by the material-change check (identical writes don't
   * re-fire).
   */
  readonly onStatusChange?: (status: FormStatus, form: Forms[number]) => void | Promise<void>
  /**
   * Optional progress override. When omitted, the wizard exposes
   * \`progress\` as \`valid_form_count / count\` (normalised to
   * \`[0, 1]\`). When provided, the returned number is used as-is —
   * the consumer is responsible for any normalisation (\`[0, 1]\`
   * vs raw count vs percentage).
   *
   * The override is invoked inside a Vue \`computed\` so it must be
   * synchronous and may only read reactive sources (form values,
   * form.meta, wizard.statuses, etc.).
   */
  readonly progress?: (forms: Forms) => number
  /**
   * Browser-history integration. Default behaviour (option omitted
   * or `true`) is to record each navigation in `window.history` so
   * back/forward buttons walk steps and reload preserves the active
   * step via `?step=<key>`. `false` disables the integration.
   * An object form lets the consumer rename the URL param.
   *
   * SSR-safe regardless of value: when `window` is undefined the
   * underlying primitive is a no-op.
   */
  readonly history?: boolean | WizardHistoryConfig
  /**
   * Framework-agnostic SSR active-step source. The library does not
   * import `useRoute()` or any router — the consumer reads route
   * state from whichever framework they use and returns the active
   * step key. The wizard consults this BEFORE form-store settle
   * microtasks fire so the active step's `onServerPrefetch` runs
   * server-side and non-active steps stay deferred.
   *
   * The getter runs on both server and client (the consumer's route
   * source must be available on both); returning `undefined` falls
   * through to URL `?step=<key>` and finally to `forms[0]`.
   */
  readonly getServerActiveStep?: () => KeysOf<Forms> | undefined
}

/**
 * Cross-form value aggregate. Each form's `values` proxy is exposed
 * under its key — drillable as `wizard.allValues.cargo.weight`.
 * Useful for review screens and final-submit aggregation.
 */
export type AllValues<Forms extends readonly AnyForm[]> = {
  readonly [K in KeysOf<Forms>]: unknown
}

/**
 * Return shape of `useWizard`. Every reactive read is a plain getter
 * (no `.value`) — `wizard.current`, `wizard.progress`, `wizard.allErrors`
 * track inside `computed`/template effects directly. This matches the
 * rest of the library (form.values, form.meta, etc.) and keeps the
 * consumer surface free of `.value` plumbing.
 *
 *   - `current`     — the active step's key (or `undefined` for an
 *                     empty / degenerate wizard).
 *   - `activeForm`  — the active step's form handle, identity-equal
 *                     to the matching entry in `forms`. `undefined`
 *                     when `current` is `undefined`.
 *   - `activeIndex` — 0-based index of the active step; `-1` when
 *                     `current` is `undefined`.
 *   - `forms`       — original tuple, so consumers can index by key.
 *   - `count`       — static step count.
 *   - `statuses`    — callable readonly proxy over `Statuses<Forms>` —
 *                     readable as `wizard.statuses.cargo.valid`,
 *                     callable as `wizard.statuses('cargo')` or
 *                     `wizard.statuses()`. Each entry derives from
 *                     the matching form's `meta`.
 *   - `allValues`   — each form's `values` proxy under its key, for
 *                     cross-step review screens.
 *   - `allErrors`   — flat error list across resolved forms, ordered
 *                     by `forms` then per-form order. Dormant
 *                     (unactivated) forms contribute nothing.
 *   - `progress`    — normalised `valid_form_count / count` (or the
 *                     consumer's `progress` override).
 */
export type UseWizardReturnType<Forms extends readonly AnyForm[]> = {
  readonly current: KeysOf<Forms> | undefined
  readonly activeForm: Forms[number] | undefined
  readonly activeIndex: number
  readonly forms: Forms
  readonly count: number
  readonly statuses: WizardStatusesProxy<Statuses<Forms>>
  readonly allValues: AllValues<Forms>
  readonly allErrors: readonly AggregateError[]
  readonly progress: number
  readonly next: (options?: WizardNavOptions) => void
  readonly back: (options?: WizardNavOptions) => void
  readonly goTo: (key: KeysOf<Forms>, options?: WizardNavOptions) => void
}
