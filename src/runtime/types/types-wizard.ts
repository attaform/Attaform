/**
 * Public types for `useWizard` — the multistep-form orchestrator.
 *
 * Forms self-describe their downstream neighbor(s) via `useForm({ next })`,
 * and `useWizard(entryForm)` walks the declared graph from the entry form
 * to discover every reachable step. Navigation, status aggregation, and
 * activation lifecycle layer on top of that graph view.
 *
 * The wizard surface is loosely keyed (`Record<string, FormStatus>` /
 * `Record<string, unknown>`). Cross-component graphs threaded through
 * `injectWizard` lose lexical key knowledge anyway, so the public read
 * surface is a string-keyed proxy. Typed per-form access flows back
 * through the original form refs (and through `wizard.handleSubmit`'s
 * `ctx.get(formRef)` accessor — Phase 4).
 */

import type { FormKey } from './types-api'

/**
 * Minimum structural shape the wizard requires from a participating
 * form. Constraining to the full `UseFormReturnType` would force
 * contravariant unification of the storage / read shapes across all
 * steps; the wizard does not care about those — it routes by `key`
 * at runtime and exposes the original form objects untouched.
 *
 * `next` is the graph-position declaration (see `useForm({ next })`).
 * Forms self-describe their successor(s), and `useWizard(entryForm)`
 * walks the graph from there. The field is optional: a form without
 * `next` is a terminal.
 *
 * `UseFormReturnType<...>` satisfies this shape because its `key`
 * field is `readonly key: K extends FormKey` and its `next` field is
 * `readonly next: NormalizedNext | undefined`.
 */
export type AnyForm = {
  readonly key: FormKey
  readonly next?: NormalizedNext | undefined
}

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
 * Per-call navigation options. `replace` controls whether the change
 * pushes a new history entry or overwrites the current one.
 */
export type WizardNavOptions = {
  readonly replace?: boolean
}

/**
 * Recursive leaf type for `WizardSubmitContext.values`. Covers the
 * realistic outputs a Zod-parsed form yields:
 *
 *  - primitives — `string`, `number`, `boolean`, `bigint`, `null`,
 *    `undefined` (covers `z.string`, `z.number`, `z.boolean`,
 *    `z.bigint`, `z.null`, `z.undefined`, `z.optional`, enums,
 *    literals)
 *  - host objects — `Date`, `File`, `Blob`, `URL` (covers `z.date`,
 *    `z.file`, `z.instanceof(Blob)`, `z.url` when emitted as the URL
 *    object form)
 *  - collections — readonly arrays / `Set` / `Map` of the same
 *    (covers `z.array`, `z.set`, `z.map`)
 *  - records — string-keyed objects of the same (covers `z.object`,
 *    `z.record`, `z.discriminatedUnion`, intersections)
 *
 * Schemas that yield custom classes, `Promise`, `Symbol`, or `RegExp`
 * sit outside this union — reach for `ctx.get(form)` for the exact
 * per-form output in those cases.
 */
export type WizardValue =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | Date
  | File
  | Blob
  | URL
  | readonly WizardValue[]
  | ReadonlySet<WizardValue>
  | ReadonlyMap<WizardValue, WizardValue>
  | { readonly [key: string]: WizardValue }

/**
 * Context object passed to the `onSubmit` callback registered via
 * `wizard.handleSubmit(onSubmit, onError?)`. Composes three views of the
 * walked runtime path so consumers can route submission data however
 * suits the integration:
 *
 *  - `values` — loose-keyed aggregate of each walked form's parsed
 *    output. The default for "POST everything to the backend" wiring.
 *  - `get(form)` — typed accessor that reads the parsed output for a
 *    specific form. Works with `injectForm`-resolved refs in
 *    cross-component graphs, since the form ref carries its own
 *    schema info regardless of where it came from.
 *  - `path` — the ordered runtime path from entry to terminal, with
 *    branching `pick(parsed)` callbacks resolved against the current
 *    parsed values. Iterate this when a per-form callback (audit
 *    log, sequential POST, etc.) needs the runtime order.
 */
export type WizardSubmitContext = {
  readonly values: Readonly<Record<string, WizardValue>>
  readonly get: <F extends AnyForm>(form: F) => F extends { readonly values: infer V } ? V : unknown
  readonly path: readonly AnyForm[]
}

/**
 * `onSubmit` callback registered via
 * `wizard.handleSubmit(onSubmit, onError?)`. Fires once every form on
 * the runtime path has parsed successfully. Sync or async; the
 * returned promise gates `wizard.submitting`.
 */
export type WizardOnSubmit = (ctx: WizardSubmitContext) => void | Promise<void>

/**
 * Optional `onError` callback registered via
 * `wizard.handleSubmit(onSubmit, onError?)`. Receives the aggregate
 * error list — entries originate from per-form validation, activation
 * failures (`atta:activation-failed`), and out-of-list `pick` returns.
 * Sync or async; the returned promise gates `wizard.submitting`.
 */
export type WizardOnError = (errors: readonly AggregateError[]) => void | Promise<void>

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
 * Flat error shape returned by `wizard.allErrors`. Cross-step
 * aggregations need a stable identity per error — `formKey` + `path`
 * — so consumers can render a wizard-wide error summary that links
 * back to the offending field.
 *
 * Sort order: BFS-order from the wizard's entry form, then each
 * form's internal error order.
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
 * Options for `useWizard(entryForm, options)`. Loosely keyed because
 * the wizard's reachable graph is discovered at construction from the
 * entry form's `next` declarations; the option types are framework-
 * facing and cannot pre-commit to the literal-union of reachable keys.
 */
export type WizardOptions = {
  /**
   * Identifier used to register the wizard handle in the per-app
   * registry. Descendant components call `injectWizard(key)` to reach
   * the same wizard handle without prop-threading. Anonymous wizards
   * (option omitted) skip the registry entirely and are reachable only
   * via ambient `injectWizard()` from descendants of the parent that
   * called `useWizard`.
   *
   * Duplicate-key registration is first-wins-silently (dev-warn on the
   * second registration) to mirror `useForm`'s shared-key behavior. If
   * two `useWizard({ key: 'foo' })` calls race in the same scope, the
   * second is dropped and the first's handle stays canonical for the
   * lifetime of the app.
   */
  readonly key?: string
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
   * Unknown keys in the seed object are dropped with a dev-warn so a
   * stale resume payload cannot crash construction.
   */
  readonly defaultStatuses?:
    | Record<string, FormStatus>
    | (() => Record<string, FormStatus>)
    | (() => Promise<Record<string, FormStatus>>)
  /**
   * Fires whenever a participating form's status (`valid`,
   * `dirty`, `submitted`, or `errorCount`) materially changes —
   * one of those four scalars actually moved. The handler receives
   * the new status and the form whose status changed.
   *
   * Fire-and-forget: a returned promise is NOT awaited.
   */
  readonly onStatusChange?: (status: FormStatus, form: AnyForm) => void | Promise<void>
  /**
   * Optional progress override. When omitted, the wizard exposes
   * `progress` as `valid_form_count / count` (normalised to
   * `[0, 1]`). When provided, the returned number is used as-is —
   * the consumer is responsible for any normalisation.
   *
   * The override is invoked inside a Vue `computed` so it must be
   * synchronous and may only read reactive sources (form values,
   * form.meta, wizard.statuses, etc.).
   */
  readonly progress?: (forms: readonly AnyForm[]) => number
  /**
   * Browser-history integration. Default behaviour (option omitted
   * or `true`) is to record each navigation in `window.history` so
   * back/forward buttons walk steps and reload preserves the active
   * step via `?step=<key>`. `false` disables the integration.
   * An object form lets the consumer rename the URL param.
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
   * The getter runs on both server and client; returning `undefined`
   * falls through to URL `?step=<key>` and finally to the entry form's
   * `key`.
   */
  readonly getServerActiveStep?: () => string | undefined
  /**
   * When `wizard.handleSubmit` finds errors, automatically
   * `wizard.goTo(firstFailedKey)` and then call that form's
   * `applyInvalidSubmitPolicy()` (focus / scroll per the form's own
   * `onInvalidSubmit` configuration). Default `true`; pass `false`
   * to keep the active step where the user left it and handle
   * navigation manually in the `onError` callback.
   *
   * The first failed key is the BFS-ordered first form (from the
   * wizard's reachable set) with a non-empty error list after the
   * walk completes. Aggregation order matches `wizard.allForms`.
   */
  readonly navigateToFirstError?: boolean
}

/**
 * Recursive key-only tree describing the wizard's static graph
 * reachable from its entry. Returned from `wizard.flow.tree` and
 * suitable for sitemap rendering via a recursive Vue component.
 *
 * Convergent paths (two upstream forms both pointing at the same
 * downstream form) produce duplicated subtrees — the structure is the
 * DAG flattened to a tree, not a deduped DAG. Use `wizard.flow.allForms`
 * for the BFS-ordered deduped list.
 */
export type WizardTreeNode = {
  readonly key: FormKey
  readonly next: readonly WizardTreeNode[]
}

/**
 * Kinds of static / runtime graph anomaly surfaced via the wizard's
 * `diagnose()` channel.
 *
 *  - `cycle` — a form's chain leads back to itself. Hard error at
 *    `useWizard(entryForm)` construction (thrown, not warned).
 *  - `missing-terminal` — every path from entry should reach a terminal
 *    (`next` omitted, or empty branching). In a finite acyclic graph
 *    this is equivalent to `cycle`; surfaced for completeness.
 *  - `unreachable` — a form constructed in scope but no chain from
 *    entry reaches it. Dev-warn.
 *  - `empty-forms` — a branching `next: { pick, forms: [] }`. Treated
 *    as a terminal but probably a typo. Dev-warn.
 *  - `out-of-forms-pick` — `pick(parsed)` returned a form not declared
 *    in `forms`. Runtime check (the normalized-next layer throws).
 *  - `single-step` — entry form has no `next`. Valid but degenerate.
 */
export type WizardWarningKind =
  | 'cycle'
  | 'missing-terminal'
  | 'unreachable'
  | 'empty-forms'
  | 'out-of-forms-pick'
  | 'single-step'

export type WizardWarning = {
  readonly kind: WizardWarningKind
  readonly severity: 'warn' | 'error'
  readonly message: string
  readonly key?: FormKey
}

/**
 * Static + runtime introspection surface returned by `wizard.flow`.
 * Composes three views of the wizard's reachable graph and one reactive
 * runtime tracker, so consumers can render sitemaps, breadcrumb trails,
 * diagnostic panels, and step-counter UIs from one cohesive namespace.
 *
 *  - `entryForm` — the form passed to `useWizard(entryForm)`. Identity-
 *                  equal to that argument; immutable for the wizard's
 *                  lifetime.
 *  - `tree`      — recursive `WizardTreeNode` view rooted at the entry
 *                  form. Suitable for sitemap rendering via a recursive
 *                  Vue component; convergent paths duplicate by design.
 *  - `allForms`  — BFS-ordered, deduped list of reachable forms. The
 *                  same list exposed at `wizard.allForms`; mirrored
 *                  here so `wizard.flow` is the single hand-off when a
 *                  caller wants the full picture.
 *  - `visited`   — reactive runtime history. Push order matches the
 *                  user's navigation sequence; `back()` does not pop the
 *                  trail (it records the move forward into the
 *                  previous step), so the array is the audit log, not
 *                  the back-stack.
 *  - `diagnose()` — frozen snapshot of construction-time graph
 *                  warnings. Cycles throw at construction so they do
 *                  not appear in this list; `empty-forms` and
 *                  `single-step` do. Cheap call; consumers can hook
 *                  the result into a dev-only warning panel.
 */
export type WizardFlow = {
  readonly entryForm: AnyForm
  readonly tree: WizardTreeNode
  readonly allForms: readonly AnyForm[]
  readonly visited: readonly FormKey[]
  readonly diagnose: () => readonly WizardWarning[]
}

/**
 * Return shape of `useWizard(entryForm, options)`. Every reactive read
 * is a plain getter (no `.value`) — `wizard.current`, `wizard.progress`,
 * `wizard.allErrors` track inside `computed` / template effects
 * directly. This matches the rest of Attaform (form.values, form.meta,
 * etc.) and keeps the consumer surface free of `.value` plumbing.
 *
 *   - `current`     — the active step's key (or `undefined` for a
 *                     degenerate wizard).
 *   - `activeForm`  — the active step's form handle, identity-equal
 *                     to its matching entry in the reachable set.
 *                     `undefined` when `current` is `undefined`.
 *   - `activeIndex` — 0-based BFS-ordered index of the active step;
 *                     `-1` when `current` is `undefined`.
 *   - `entryForm`   — the entry form, identity-equal to the argument
 *                     passed to `useWizard(entryForm)`.
 *   - `allForms`    — BFS-ordered, deduped list of forms reachable
 *                     from the entry. Use this for sitemaps, step
 *                     counters, and "step N of M" displays.
 *   - `count`       — `allForms.length`.
 *   - `statuses`    — callable readonly proxy over the per-key
 *                     `FormStatus` record — readable as
 *                     `wizard.statuses.cargo.valid`, callable as
 *                     `wizard.statuses('cargo')` or
 *                     `wizard.statuses()`. Each entry derives from
 *                     the matching form's `meta`.
 *   - `allValues`   — each form's `values` proxy under its key, for
 *                     cross-step review screens.
 *   - `allErrors`   — flat error list across resolved forms, ordered
 *                     by BFS then per-form order. Dormant
 *                     (unactivated) forms contribute nothing.
 *   - `progress`    — normalised `valid_form_count / count` (or the
 *                     consumer's `progress` override).
 *   - `canAdvance`  — `true` when the active form has a non-empty
 *                     `next` declaration. Graph-structural; does not
 *                     consult `pick(parsed)`, so dynamic terminals
 *                     read as `canAdvance: true` until the runtime
 *                     walker resolves the branch at submission.
 *   - `canGoBack`   — `true` when `activeIndex > 0` (a prior step
 *                     exists in BFS order). Mirrors the navigation
 *                     surface `back()` operates over.
 *   - `complete`    — `true` once `wizard.handleSubmit`'s `onSubmit`
 *                     callback resolves without throwing. Flips back
 *                     to `false` the first time any walked-path form
 *                     becomes `meta.dirty` again (dirty-driven, not
 *                     snapshot-driven). Cleared by `wizard.reset()`.
 *   - `submitting`  — `true` while a `wizard.handleSubmit` call is in
 *                     flight (covers the path walk AND the
 *                     `onSubmit` / `onError` callback execution).
 *                     Distinct from per-form `meta.submitting`, which
 *                     stays `false` during the wizard walk because the
 *                     wizard calls `form.process()` directly rather
 *                     than each form's `handleSubmit`.
 *   - `submissionAttempts` — count of `wizard.handleSubmit` invocations
 *                     (success or failure). Useful for "show errors
 *                     after first wizard attempt" UX gates.
 *   - `handleSubmit` — wraps the consumer's submit logic with the
 *                     full path-walk validation pipeline. Returns a
 *                     submit handler suitable for
 *                     `<form @submit.prevent="handler">` or imperative
 *                     calls. See `WizardSubmitContext` for the
 *                     `onSubmit` callback's argument shape.
 *   - `reset`       — zeros wizard lifecycle (`complete`,
 *                     `submitting`, `submissionAttempts`) and calls
 *                     `form.reset()` on every reachable form. Returns
 *                     the wizard to its construction state.
 *   - `flow`        — introspection namespace bundling the static graph
 *                     (`entryForm`, `tree`, `allForms`), runtime
 *                     navigation history (`visited`), and the diagnostic
 *                     warnings channel (`diagnose()`). The same data
 *                     backs the top-level `entryForm` / `allForms`
 *                     aliases — the namespace is the structured hand-off
 *                     for sitemap and diagnostic UIs.
 */
export type UseWizardReturnType = {
  /**
   * The wizard's identifier in the per-app registry, or `undefined` if
   * the consumer didn't pass `options.key`. Mirrors `form.key` so the
   * wizard surface is symmetric with the form surface.
   */
  readonly key: string | undefined
  readonly current: string | undefined
  readonly activeForm: AnyForm | undefined
  readonly activeIndex: number
  readonly entryForm: AnyForm
  readonly allForms: readonly AnyForm[]
  readonly count: number
  readonly statuses: WizardStatusesProxy<Record<string, FormStatus>>
  readonly allValues: Record<string, unknown>
  readonly allErrors: readonly AggregateError[]
  readonly progress: number
  readonly canAdvance: boolean
  readonly canGoBack: boolean
  readonly complete: boolean
  readonly submitting: boolean
  readonly submissionAttempts: number
  readonly next: (options?: WizardNavOptions) => Promise<void>
  readonly back: (options?: WizardNavOptions) => void
  readonly goTo: (key: string, options?: WizardNavOptions) => void
  readonly handleSubmit: (
    onSubmit: WizardOnSubmit,
    onError?: WizardOnError
  ) => (event?: Event) => Promise<void>
  readonly reset: () => void
  readonly flow: WizardFlow
}

// ============================================================================
// v2 types — list-based steps with eager function-slot evaluation.
//
// These types live alongside the v1 surface during the parallel-implementation
// phase. Unit 5 of the v2 refactor renames the `V2`-suffixed types to drop the
// suffix and deletes the v1 forms above. Until then, `useWizardV2` (parallel
// implementation) consumes these types directly.
// ============================================================================

/**
 * One compiled position in the wizard's flow. The wizard surface exposes
 * an ordered array of these as `wizard.steps`, plus a `wizard.forms`
 * record keyed by `step.key` for direct lookup.
 *
 * String slots in the source `steps` array desugar to noop forms
 * (`useForm({ schema: z.object({}), key })`) before compilation, so every
 * compiled step carries a `form` regardless of source kind.
 */
export type CompiledStep = {
  readonly key: FormKey
  readonly form: AnyForm
}

/**
 * Shape of a participating form as seen from inside a function slot's
 * `ctx.forms[key]` lookup. Adds `values` to the structural `AnyForm`
 * minimum so routing decisions can read live form state.
 *
 * Values are typed loose because the wizard does not generically thread
 * each step's schema through `ctx.forms`. For typed access inside slot
 * bodies, close over the original form ref instead of routing through
 * `ctx.forms`.
 */
export type WizardCtxForm = AnyForm & {
  readonly values: Readonly<Record<string, unknown>>
}

/**
 * Context object passed to function slots in the `steps` array. The
 * `forms` record holds every form resolved so far (eager pass), the
 * `currentKey` reflects the live wizard step, and `activeIndex` is the
 * 0-based position of the active step in the compiled list.
 *
 * Function slots re-evaluate reactively when their reads change.
 * Effectful slot bodies should be avoided; routing decisions live here.
 */
export type WizardCtx = {
  readonly forms: Readonly<Record<FormKey, WizardCtxForm>>
  readonly currentKey: FormKey | undefined
  readonly activeIndex: number
}

/**
 * Internal phantom brand for `DeferMarker`. The runtime brand symbol
 * lives in `core/wizard-defer.ts`; this declaration keeps the marker
 * type unforgeable without circular module imports.
 */
declare const _deferBrand: unique symbol

/**
 * Brand-typed marker returned by `defer((ctx) => …)`. Wrapping a function
 * slot in `defer()` opts that specific slot into lazy-sticky resolution:
 * the slot stays unresolved until navigation lands on its position for
 * the first time, then its resolution sticks across subsequent
 * departures and returns.
 *
 * Construct via the `defer()` helper exported from the same entry as
 * `useWizard`. The marker is opaque at the type level; consumers do not
 * assemble it directly.
 */
export type DeferMarker<Ctx = WizardCtx> = {
  readonly [_deferBrand]: true
  readonly resolve: (ctx: Ctx) => AnyForm | string | undefined
}

/**
 * One position in the source `useWizard({ steps })` array. Each slot
 * resolves to a compiled `{ key, form }` step at construction (or on
 * first navigation-land for `defer()`-wrapped slots).
 *
 *  - `AnyForm`         — a form declared via `useForm`. Surfaced
 *                        as-is. The wizard does not own its lifecycle.
 *  - `string`          — bare key; the wizard generates a noop form
 *                        (`z.object({})`) under the hood so the external
 *                        surface stays uniform. Used for affordance steps
 *                        (intros, T&C, congratulations, review surfaces).
 *  - function          — eager slot, re-evaluates reactively. Returns
 *                        one of the above, or `undefined` to drop the
 *                        slot from the compiled list.
 *  - `DeferMarker`     — lazy-sticky function slot (see `defer`).
 */
export type StepSlot<Ctx = WizardCtx> =
  | AnyForm
  | string
  | ((ctx: Ctx) => AnyForm | string | undefined)
  | DeferMarker<Ctx>

/**
 * Shape returned by the `restore` callback. Currently only carries the
 * active step's key; intentionally open-ended (object form) so future
 * additions land without a callback-signature break.
 */
export type WizardRestoreState = {
  readonly step?: FormKey
}

/**
 * `restore` callback signature. Invoked at construction and watched
 * reactively via `watchEffect` so external state changes (browser
 * back/forward, cross-tab events, route changes) re-apply through the
 * wizard. Returning `undefined` falls through to the first step.
 */
export type WizardRestoreFn = () => WizardRestoreState | undefined

/**
 * `persist` callback signature. Invoked whenever `wizard.currentStep`
 * changes (and diffs against the last persisted value to break the
 * restore-persist loop).
 */
export type WizardPersistFn = (state: WizardRestoreState) => void

/**
 * Submit context passed to the `onSubmit` callback registered via
 * `wizard.handleSubmit(onSubmit, onError?)`. Same shape on every step;
 * `isFinal` distinguishes intermediate vs final calls.
 *
 *  - `values` — namespaced aggregate keyed by form key, mirroring
 *               `wizard.allValues`. Reflects parsed output for every
 *               form whose validation has settled; noops contribute
 *               an empty record.
 *  - `get(form)` — typed accessor that reads the parsed output for a
 *               specific form ref. Works across cross-component graphs
 *               (the form ref carries its schema info).
 *  - `currentKey` — key of the step that fired this submission.
 *  - `isFinal`   — `true` when `currentKey` is the last position in
 *               `wizard.steps`. Intermediate calls validate the active
 *               form only and advance; final calls validate every form
 *               and stay on the terminal step.
 */
export type WizardSubmitContextV2 = {
  readonly values: Readonly<Record<FormKey, unknown>>
  readonly get: <F extends AnyForm>(form: F) => F extends { readonly values: infer V } ? V : unknown
  readonly currentKey: FormKey
  readonly isFinal: boolean
}

/**
 * `onSubmit` callback registered via the v2 `wizard.handleSubmit`. Sync
 * or async; the returned promise gates `wizard.submitting`.
 */
export type WizardOnSubmitV2 = (ctx: WizardSubmitContextV2) => void | Promise<void>

/**
 * Options for `useWizard({ steps, … })`. Steps are the only required
 * field; the rest mirror v1 behavior where preserved, or are new
 * additions for the list-based design.
 */
export type WizardOptionsV2 = {
  /**
   * Ordered list of slots that compile into the wizard's positional
   * step list. See `StepSlot` for the per-slot shape contract.
   */
  readonly steps: ReadonlyArray<StepSlot>
  /**
   * Identifier used to register the wizard handle in the per-app
   * registry. Descendant components call `injectWizard(key)` to reach
   * the same wizard without prop-threading. Anonymous wizards (option
   * omitted) skip the registry and are reachable only via ambient
   * `injectWizard()` from descendants of the parent that called
   * `useWizard`.
   *
   * Duplicate-key registration is first-wins-silently (dev-warn on the
   * second registration) to mirror `useForm`'s shared-key behavior.
   */
  readonly key?: string
  /**
   * Seed status payload used while a form is pre-resolved (async
   * `defaultValues` in flight, or wizard-deferred non-current). Mirrors
   * `defaultValues`' trichotomy: plain object, sync factory, or async
   * factory.
   *
   * Status resolution priority per form:
   *   1. `store.defaultsResolved === true` → derive from `form.meta`
   *   2. else seed value for this key → frozen seed
   *   3. else → pending sentinel
   *
   * Unknown keys in the seed object are dropped with a dev-warn so a
   * stale resume payload cannot crash construction. Noop forms use a
   * built-in always-valid default.
   */
  readonly defaultStatuses?:
    | Record<string, FormStatus>
    | (() => Record<string, FormStatus>)
    | (() => Promise<Record<string, FormStatus>>)
  /**
   * Optional progress override. When omitted, the wizard exposes
   * `progress` as `valid_step_count / count` (normalised to `[0, 1]`).
   * When provided, the returned number is used as-is — the consumer is
   * responsible for any normalisation.
   *
   * The override is invoked inside a Vue `computed` so it must be
   * synchronous and may only read reactive sources.
   */
  readonly progress?: (steps: ReadonlyArray<CompiledStep>) => number
  /**
   * When `wizard.handleSubmit` finds errors, automatically focus the
   * first failing form (`wizard.goTo(firstFailedKey)` and then call
   * that form's `applyInvalidSubmitPolicy()` per its own
   * `onInvalidSubmit` configuration). Default `true`; pass `false` to
   * keep the active step where the user left it and handle navigation
   * manually in the `onError` callback.
   *
   * Renamed from v1's `navigateToFirstError` to match the useForm-level
   * method of the same name.
   */
  readonly focusFirstError?: boolean
  /**
   * Source of truth for the active step. Invoked at construction and
   * re-evaluated reactively via `watchEffect`. Default callback reads
   * `?step=<key>` via `useRoute()`; pass `false` to disable URL sync,
   * or provide a custom callback for non-router persistence
   * (localStorage, broadcast channel, etc.).
   */
  readonly restore?: WizardRestoreFn | false
  /**
   * Destination for the active step. Invoked whenever `currentStep`
   * changes, with a diff check to break the restore-persist loop.
   * Default callback writes `?step=<key>` via `useRouter().replace`;
   * pass `false` to disable persistence, or provide a custom callback
   * to scope the param name or write to alternate storage.
   */
  readonly persist?: WizardPersistFn | false
}

/**
 * Return shape of `useWizard({ steps, … })`. Every reactive read is a
 * plain getter (no `.value`) — `wizard.currentStep`, `wizard.progress`,
 * `wizard.allValues` track inside `computed` / template effects
 * directly.
 *
 *  - `currentStep` — key of the active step. Always defined (the steps
 *                    array is non-empty by construction).
 *  - `activeForm`  — the active step's form handle. Always defined
 *                    (noop forms cover string slots).
 *  - `activeIndex` — 0-based position of the active step.
 *  - `isFinalStep` — `true` when `currentStep === steps[count - 1].key`.
 *  - `steps`       — ordered list of compiled `{ key, form }` slots.
 *  - `forms`       — record indexable by step key; the value is the
 *                    full form handle resolved for that slot (the
 *                    consumer's own form for slot forms, the wizard's
 *                    generated noop for string slots).
 *  - `count`       — `steps.length`.
 *  - `statuses`    — callable readonly proxy over the per-key
 *                    `FormStatus` record. Noop-form keys always read
 *                    as default-valid.
 *  - `allValues`   — namespaced aggregate of each form's values, keyed
 *                    by step key.
 *  - `allErrors`   — namespaced aggregate of each form's validation
 *                    errors, keyed by step key. Noop forms map to an
 *                    empty list.
 *  - `progress`    — normalised step-validity ratio (or the consumer's
 *                    `progress` override). Forward-looking: noops count
 *                    as always-valid.
 *  - `canAdvance`  — `true` when `activeIndex < count - 1`. Pure
 *                    positional check; navigation never gates on
 *                    validity.
 *  - `canGoBack`   — `true` when `activeIndex > 0`.
 *  - `complete`    — `isFinalStep && every step's form is valid`.
 *                    Forward-looking; no dirty tracking under eager
 *                    activation.
 *  - `submitting`  — `true` while a `wizard.handleSubmit` call is in
 *                    flight. Global re-entrance guard: every
 *                    navigation method also refuses while this is on.
 *  - `submissionAttempts` — count of `wizard.handleSubmit` invocations
 *                    (success or failure). Always bumps, including on
 *                    noop-form steps.
 *  - `visited`     — append-only breadcrumb of navigated step keys.
 *                    `back()` does not pop; the trail is the audit log,
 *                    not the back-stack.
 *  - `next/back/goTo` — pure navigation. Refuses while `submitting`.
 *  - `handleSubmit(onSubmit, onError?)` — universal across all steps.
 *                    Intermediate calls validate the active form; final
 *                    calls validate every form. Returns an event
 *                    handler suitable for `<form @submit>` or
 *                    imperative use.
 *  - `reset()`     — zeros wizard lifecycle (`complete`, `submitting`,
 *                    `submissionAttempts`, `visited`), resets every
 *                    form, returns `currentStep` to `steps[0].key`, and
 *                    invokes `persist` with the cleared state.
 */
export type UseWizardReturnTypeV2 = {
  readonly key: string | undefined
  readonly currentStep: FormKey
  readonly activeForm: AnyForm
  readonly activeIndex: number
  readonly isFinalStep: boolean
  readonly steps: ReadonlyArray<CompiledStep>
  readonly forms: Readonly<Record<FormKey, AnyForm>>
  readonly count: number
  readonly statuses: WizardStatusesProxy<Record<string, FormStatus>>
  readonly allValues: Readonly<Record<FormKey, unknown>>
  readonly allErrors: Readonly<Record<FormKey, readonly AggregateError[]>>
  readonly progress: number
  readonly canAdvance: boolean
  readonly canGoBack: boolean
  readonly complete: boolean
  readonly submitting: boolean
  readonly submissionAttempts: number
  readonly visited: readonly FormKey[]
  readonly next: (options?: WizardNavOptions) => Promise<void>
  readonly back: (options?: WizardNavOptions) => void
  readonly goTo: (key: string, options?: WizardNavOptions) => void
  readonly handleSubmit: (
    onSubmit: WizardOnSubmitV2,
    onError?: WizardOnError
  ) => (event?: Event) => Promise<void>
  readonly reset: () => void
}
