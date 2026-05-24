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
