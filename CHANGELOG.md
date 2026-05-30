# Changelog

## Unreleased

_No unreleased changes yet._

## v0.20.0
A seventeen-phase codebase audit closes out, with prototype-pollution
defense flipped from input rejection to prototype-less storage so
legitimate schema fields named `prototype` / `constructor` /
`__proto__` round-trip end-to-end. The v3 adapter reaches parity with
v4 across union / tuple / intersection / lazy / catch descent, default
seeding, async validation, and typed-config field surface. The
validation lifecycle gets concurrent-validation epoch guards and
subtree-scoped revalidation; array mutations preserve per-element
state and identity. CodeQL SAST runs on every push, every PR, and a
weekly cron; GitHub Releases now carry SLSA build-provenance
attestations alongside npm's `--provenance`.

### Breaking

- **`SensitivePersistFieldError` / `REDACTED` / `redactSensitiveLeaves`
  removed.** A `useForm` with `persist: true` and unacknowledged
  sensitive paths now warns and skips persistence opt-in (was: threw
  `SensitivePersistFieldError` on mount). Nested sensitive leaves
  inside opt-in containers are scrubbed from persisted payloads rather
  than throwing. Acknowledge with `acknowledgeSensitive` to opt in
  explicitly. The three exports above are gone; if you imported them
  to assert against the throw, drop the catch.

- **`WizardAggregateError` renames `AggregateError`.** The wizard's
  aggregate-throw class no longer shadows the JS built-in. Import
  `WizardAggregateError` from `attaform` instead of the prior
  `AggregateError`. `instanceof` checks against `globalThis.AggregateError`
  now resolve to the JS built-in, as they should.

- **`componentBridgeTransform` renames `selectNodeTransform`.** The
  build-time transform that bridges schema-driven controls keeps the
  same shape and surface, but the name reflects what it does rather
  than the specific control it started with. Update any direct import
  to use the new name.

- **`NestedType` / `NestedReadType` signatures simplified.** The
  recursive walker types drop their internal accumulator parameters
  (`PartialFlatPath`, `StorageLeaf`, etc. inferred internally). If you
  reached for these generics directly, the call site collapses to the
  schema-and-key form; the inference-first DX surface is unchanged.

- **v3 `useForm` generic signature collapses to `<Schema, K>`.**
  Matching v4's shape so a single inference flow covers both adapters.
  Runtime config (`getDisplayState`, `maxRecursionDepth`,
  `sensitiveNames`, `multiTab`, `autoAria`) was already forwarded at
  runtime; the v3 type now accepts them too. If you fully expanded the
  prior generic-arg list explicitly, trim it.

- **Multi-tab snapshot replies are rate-limited (500 ms per sender).**
  A flood of `request-snapshot` messages from a single tab no longer
  produces a corresponding flood of replies. The reply is best-effort
  per sender; the next request from the same sender after the window
  is honoured normally. Inbound message handling is tightened (invalid
  shapes are dropped silently rather than thrown).

### Added

- **v3 `needsAsyncValidation` method.** v3's `AbstractSchema` exposes
  the same memoised async-detection method v4 has. Strict-mode
  default-value seeding now parses the real schema (seeded from
  container + leaf checks) rather than synthesising an empty record.
  User-validator throws inside `validateAtPath` are wrapped as
  `atta:validator-threw` errors, matching v4's error contract.

- **`AbstractSchema.hasContainerOrRootRefine?(): boolean`.** Optional
  adapter hook that lets per-keystroke validation scope to the edited
  subtree when a schema has no container or root refines. Defaults
  conservatively (whole-form) when the hook is absent. Implemented on
  both v3 and v4 with their own introspect chokepoints. Custom adapter
  authors can opt in for a measurable keystroke-validation throughput
  win on schemas without container refines.

- **CodeQL SAST workflow.** `.github/workflows/codeql.yml` runs the
  `security-extended` query suite for JavaScript / TypeScript on every
  push to `main`, every PR, and a weekly Tuesday cron. SARIF lands in
  the repo's Security tab; PR runs annotate diffs inline.

- **SLSA build-provenance attestations on GitHub Releases.** Each
  release tag now ships with a Sigstore-backed `.intoto.jsonl` bundle
  as a release asset, alongside npm's existing `--provenance`
  attestation. Verify with
  `gh attestation verify ./attaform-X.Y.Z.tgz --repo attaform/Attaform`
  or `npm audit signatures`. Govt-customer / supply-chain-policy
  auditors get both verification paths against a single OIDC trust
  root.

### Fixed

- **Concurrent async validations no longer clobber by resolution
  order.** A form-level epoch counter advances on every new validation
  pass; in-flight pass results from a stale epoch are dropped. The
  per-path snapshot map plus subtree-scoped blur dedup eliminates the
  spurious whole-form revalidation that fired on every sibling edit;
  `reset()` clears the snapshot map and epoch counters cleanly. Async
  probes don't re-fire when the user refocuses without editing.

- **`setValue('container', value)` resolves descendant blank-marks.**
  A write to a container path now correctly clears blank-marks on
  every descendant the new value covers, so required-field validation
  fires consistently for the newly-populated leaves. `form.clear(path)`
  also marks the path blank so required validation isn't silenced after
  a clear. `insert(arr, idx, v)` records the correct post-splice index
  in the path mapping.

- **Per-element state stays with the element across nested arrays.**
  Nested `v-for :key="row.key"` is stable across `move`, `swap`,
  `insert`, `remove`, and `replace` at any depth. Per-element value,
  baseline, dirty / touched, errors, and blank state all relocate with
  the element rather than staying behind on the slot index.

- **v3 path-walker descends through union / tuple / intersection /
  lazy / catch.** `validateAtPath`, `getDefaultAtPath`,
  `getEmptyValueAtPath`, `arrayShapeAtPath`, `isRequiredAtPath`, and
  `getFieldMetaAtPath` on the v3 adapter now match v4's behaviour at
  every combinator. Earlier paths into a `z.union([z.object({...}),
  z.object({...})])` returned the empty default and skipped
  validation; they now resolve through the matching branch correctly.

- **v3 default values match v4 across edge cases.** `z.nan()` now
  defaults to `NaN` (was `null`). `z.void()`, `z.any()`, `z.unknown()`,
  and `z.never()` default to `undefined`. `z.preprocess` and `z.coerce`
  leave default ownership to the consumer rather than inventing one.
  `z.void()` is no longer marked required. A union is required when
  *any* branch is required (was: first-branch-only). The discriminated
  union resolver descends through `z.catch` and `z.intersection`.
  Multi-value discriminators (`z.literal([...])`) are recognised.
  Shared sub-schemas at multiple paths disambiguate via fingerprint
  (set / branded / nativeEnum / pipeline are distinguished). On v4,
  `Optional(Default('x'))` now returns `'x'` (was `undefined`);
  `z.map`, `z.symbol`, and `z.function` are rejected at construction
  to match v3's reach.

- **v3 typed-config field surface.** `useForm` on v3 accepts
  `getDisplayState`, `maxRecursionDepth`, `sensitiveNames`, `multiTab`,
  and `autoAria` at the type level. Runtime already forwarded them;
  this closes the surfaced-config gap so v3 consumers see the same
  IDE autocomplete v4 consumers do.

- **`form.fields.X = …` / `delete form.fields.X` warn-and-noop.**
  Direct writes to the field-state proxy used to throw `TypeError` on
  some surfaces and pass silently on others. Both now produce a
  one-shot dev-warn and noop. `Object.defineProperty` against the
  proxy is also a warn-and-noop now. `Object.keys(form.errors)`
  includes the synthetic form-level bucket and server-only keys so an
  iteration sees everything errors holds. `form.fields.<array>` calls
  through to the real `Array.prototype` for read-only methods like
  `.map` / `.filter` / `.reduce`, instead of returning a phantom proxy
  that mis-iterates.

- **`getDisplayState` consumer throws no longer crash the form.** A
  throw from a user-supplied `getDisplayState` produces a one-shot
  dev-warn and falls back to the `defaultDisplayState` value for that
  field. Matches the library's `feedback-no-uncaught-exceptions`
  posture across the rest of the runtime.

- **Wizard `currentStep` returns a sensible key when a function slot
  drops the active step mid-flight.** A bare-function step that
  re-evaluates to an empty list (after a navigation that depended on
  schema state) used to leave `currentStep` pointing at a now-missing
  key. It now returns the first compiled step's key, matching the
  list-after-drop. `wizard.allValues` and `wizard.allErrors` are
  identity-stable proxy references; a single form edit no longer
  re-evaluates the whole record.

- **SSR hydration matches for `<input type="radio">` + `z.number()`.**
  The interactive-tag coercion ladder treats `"2"` (from the DOM) and
  `2` (from the schema) as equivalent for `:checked`. Earlier this
  triggered a hydration flicker on every radio bound to a numeric
  model.

- **Persistence flushes on `pagehide`.** A pending debounced write
  drains before the document is hidden / unloaded, closing edit-loss
  on tab close + bfcache eviction. The overlapping-debounced-write
  drain race is closed with a per-write generation counter so a stale
  in-flight write can't overwrite a fresher one.

- **Persistence envelope v5 → v6.** Persisted payloads now round-trip
  record keys that contain literal `.` characters without ambiguity
  against path notation. v5 payloads are read once and rewritten on
  next save.

### Security

- **Prototype-pollution defense flipped to prototype-less storage.**
  Every container the runtime allocates (defaults, `setValue` writes,
  snapshots, persistence restore, multi-tab sync, undo / redo, variant
  snapshots, schema-driven walks) is rooted at `Object.create(null)`,
  not `Object.prototype`. `Object.prototype` is structurally
  unreachable from any form-container write. The shape is also
  permissive of legitimate consumer fields: a form whose schema has a
  field literally named `prototype` (or `constructor`, or
  `__proto__`) now round-trips through every surface (errors,
  persistence, multi-tab, history) without rejection. Sanitise the
  storage, not the input.

- **CodeQL findings closed.** The first CodeQL pass surfaced six
  findings; all six are fixed. Polynomial-ReDoS in
  `readableFormKeyStem` regex is anchored. `placeAt` silently drops
  path segments matching `__proto__` / `constructor` / `prototype`
  rather than placing into them. A TOCTOU race in
  `scripts/generate-release-notes.mjs` is closed (existsSync +
  readFileSync collapsed into a try/catch on `ENOENT`). Untrusted
  HTTP→FS data flow in `apps/site/scripts/download-fonts.mjs` is
  bounded (family whitelist, filename sanitisation, unicode-range
  validation). FS→HTTP data flow in
  `apps/site/scripts/indexnow-ping.mjs` is bounded (URL parse +
  host / protocol assertion replaces byte-prefix check). The identity
  replacement in `apps/site/pages/docs/[...slug].vue` is dropped (it
  was a refactor leftover).

- **Multi-tab `onmessage` never throws.** Inbound message validation
  is tightened so a malformed peer message is dropped silently rather
  than crashing the listener.

- **Sensitive-leaf scrubbing.** A container-level persistence opt-in
  no longer leaks unacknowledged sensitive leaves (cvv, cardNumber,
  ssn, etc.) to disk. The scrub layer walks every persisted subtree
  and removes leaves whose path matches a sensitive name without an
  explicit acknowledgement.

- **Dockerfile pinned to `@sha256:`.**
  `FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920`.
  The previous tag-only `FROM` was the last open Scorecard
  Pinned-Dependencies gap.

- **GitHub Releases carry SLSA build-provenance.** See the matching
  Added entry; this is the supply-chain side of the same change.

### Internal

A seventeen-phase audit-remediation sweep closes out. Dead types
removed (`FormSummary` family, `DOMFieldState` family, `MetaTracker`
family, `FormErrorStore`, plus internal-only `markTouched` and
`resolveStorageKey`). Inner walkers unified behind shared core
modules (`walk-derive-default`, `walk-slim-primitives`,
`walk-path-segments`, `FlatPathBuilder`, `AugmentWithUnset<WriteShape>`,
`NestedTypeBuilder`). Five readonly proxy files deduplicated behind
`buildCallableReadonlySnapshotProxy`. v3 introspect routed through a
single chokepoint matching v4's 35-method accessor surface. Wizard
bare-function-slot compile pass decoupled from the navigation
pointer (no longer re-runs per `next` / `back` / `goTo`). Three
"monster" files split: `create-form-store.ts` 3687→3300 LOC,
`directive.ts` 1929→1470 LOC, `use-abstract-form.ts` 1485→970 LOC.
tsc instantiations down ~4,400 in net; bundle size neutral or
favourable across every entry. Persistence module extracted to its
own folder. 39 new characterisation tests pin behaviour across the
unified walkers so future changes can't silently desync between
modes.

## v0.19.0
### Breaking

- **`shouldShowErrors` becomes `displayState`.** The single-verdict
  `shouldShowErrors` timing gate grows into a full display-state system.
  `field.displayState` is now the source of truth, one of `'idle'`,
  `'pending'`, `'error'`, or `'success'`, and `showErrors` /
  `showPending` / `showSuccess` / `showIdle` are exact projections of
  it. The default follows "reward early, punish late": errors stay quiet
  on a clean tab-through and during first entry, then reveal once a field
  is edited and blurred (or on any submit), and clear live on re-focus as
  the user fixes them. It adds a `pending` spinner state and an earned
  `success` green check, shown only for a non-blank field the user edited
  to a valid value.
  The predicate config is renamed `getDisplayState` (a function;
  the boolean shorthand is gone), and the public `defaultShouldShowErrors`
  export is now `defaultDisplayState`. `form.meta` gains `displayState`
  and the matching `show*` projections.

### Added

- **`FieldState.interacted` and `FieldState.blurredAfterInteraction`.**
  Two sticky booleans for interaction-aware UX. `interacted` flips true on
  the user's first value edit through `v-register` (an insert or a
  delete), distinct from `dirty` (net change from the baseline) and
  `touched` (blur history). `blurredAfterInteraction` flips true on the
  first blur that follows an edit (edited, then left), composing
  `interacted` with the departure; it drives the default display-state
  gate, so a field tabbed through but never edited never complains. Both
  roll up on `form.meta` and clear on reset.

- **Accessible-by-default field ids and aria.** Every `FieldState` now
  carries a stable, SSR-safe `id` plus `aria.errorId` /
  `aria.descriptionId` satellites, unique across every mount on the page
  (they fold in the form's `instanceId`), so wiring a `<label :for>` or
  an `aria-describedby` reference never risks a cross-mount collision.
  `v-register` keeps `aria-invalid`, `aria-busy`, `aria-required`, and
  `aria-describedby` in sync with each field's gated display state, and
  emits the required / invalid states during SSR too. Any aria attribute
  you author yourself is left untouched. Opt out per binding
  (`register(path, { autoAria: false })`), per form
  (`useForm({ autoAria: false })`), or app-wide via
  `createAttaform({ defaults: { autoAria: false } })`.

- **`form.list` and `FieldState.key` for stable array iteration.** Every
  `FieldState` now carries `key`: an allocated identity token for an array
  element, empty otherwise. It follows the element across `insert`, `remove`,
  `move`, and `swap`, staying distinct even for duplicate values.
  `form.list(path)` reads an array as one FieldState per element, in index
  order, each carrying that key, so a `v-for` keyed by `row.key` keeps a
  row's component instance and input focus attached to its element through
  any reorder. The view is read-only; `form.fields(path)` stays the
  aggregated container.

- **`form.record` for keyed record iteration.** `form.record(path)` reads a
  record as one FieldState per entry, keyed by the entry's own key, so you
  iterate dynamic keys with `v-for="(field, key) in form.record(path)"`
  without tracking them yourself. An entry joins the view when you write its
  key through `form.setValue` and leaves when the key does. The keyed object
  is read-only; `form.fields(path)` stays the aggregated container.
  `form.list` and `form.record` are tightly typed to their own path sets, an
  array for `list` and a record for `record`, and each rejects the other at
  compile time. Works the same on zod-v3 and zod-v4.

- **Element state stays with the element across array mutations.** A `move`,
  `swap`, `insert`, `remove`, or `replace` now relocates an item's full
  per-element state to its new index: its value, its original baseline, its
  dirty and touched state, the errors you set on it, and its blank display
  all travel with the item rather than staying behind on the slot. A
  reordered row keeps its own dirty verdict, and nothing bleeds onto the row
  that shifts into its old place. A structural change still registers the
  form as dirty even when every surviving item matches its own baseline.
  Schema verdicts recompute from the live value after the change, and a
  removed item's in-flight validation is abandoned cleanly. Works the same on
  zod-v3 and zod-v4.

### Fixed

- **`validateOn: 'blur'` no longer revalidates an unchanged field.** A
  focus/blur cycle with no edit used to fire a fresh whole-form validation
  pass, flipping `validating` true for its duration and flickering a settled
  error through `'pending'` and back on every refocus. Attaform now tracks
  whether the form has changed since its last pass and skips the redundant
  run, so a showing error stays steady and async probes don't re-fire when the
  user refocuses without editing.

## v0.18.2
Supply-chain hardening across the publish pipeline. Attaform's npm
tarballs ship with OIDC Trusted Publishing + SLSA provenance,
branch-restricted GPG signing through a dedicated GitHub Environment,
env-bound secrets and context vars throughout, and a scoped-install
publish job whose dependency surface is just the published package
itself. Workflow security lint (`zizmor` pedantic) and OpenSSF
Scorecard run on every push to keep the posture from drifting.

### Breaking

- **Node 22+ required.** `engines.node` raised from `>=20.12.0` to
  `>=22.0.0`. Node 20 LTS reached EOL on 2026-04-30 and the
  contributor toolchain now requires pnpm 11, which itself
  requires Node 22.
- **pnpm 11 required for development.** `packageManager` bumped to
  `pnpm@11.3.0`. Contributors on pnpm 10 will need to re-pin via
  Corepack (`corepack enable && corepack prepare pnpm@11.3.0
  --activate`) or simply re-clone; Corepack reads
  `packageManager` automatically. The published `attaform`
  tarball does not require pnpm at runtime; this only affects
  the contributor / CI install path.

### Security

- **OIDC Trusted Publishing.** `pnpm publish` uses GitHub's OIDC
  token to mint an ephemeral npm publish credential at publish
  time. No long-lived `NPM_TOKEN` secret exists in the repo, and
  there is nothing to rotate. The published tarball carries SLSA
  provenance verifiable via `npm audit signatures`.
- **Scoped install for the publish job.** `publish-npm.yml` runs
  `pnpm install --filter attaform... --frozen-lockfile`, so
  `apps/site` and bench dependencies never load into the runner
  during the OIDC-token-write window. A compromised dev dep in
  those subtrees cannot reach the publish credential.
- **Branch-restricted GPG signing.** Version-bump commits + tags
  are GPG-signed via `crazy-max/ghaction-import-gpg`.
  `GPG_PRIVATE_KEY` and `GPG_PASSPHRASE` are scoped to the
  `Production (NPM)` GitHub Environment with branch restriction
  to `main`, so a fork or feature-branch copy of the workflow
  cannot reach the signing credentials.
- **No `GITHUB_TOKEN` in the working tree.** The publish-job
  checkout runs `persist-credentials: false`; the post-publish
  `git push --follow-tags` wires `gh auth setup-git` as the
  credential helper, so the token lives in env (retrieved
  on-demand) rather than persisted in `.git/config`.
- **24-hour install cooldown.** `.npmrc minimumReleaseAge=1440`
  refuses to install any package version published less than 24
  hours ago. Defeats the install-within-the-hour worm pattern
  (TanStack Router, May 2026). Lockfile-pinned versions are
  exempt; `attaform` itself is excluded from the cooldown so
  downstream testers can install fresh releases immediately.
- **Dependabot cooldown.** New-release PRs wait 7 days (14 for
  semver-major bumps) before opening. Security advisories bypass
  cooldown so critical CVEs still surface immediately.
- **Tarball-size budget.** `pnpm pack` output is checked against
  `.github/tarball-size-budget.txt` at publish time. Catches
  accidental publish-surface leaks (a stray `apps/site` embed, a
  debug bundle escaping `.npmignore`) before the tarball reaches
  the registry.

### Internal

- **pnpm config moved to `pnpm-workspace.yaml`.** pnpm 11 no
  longer reads `package.json#pnpm`. `overrides` and
  `onlyBuiltDependencies` (renamed to `allowBuilds` in pnpm 11)
  migrated to `pnpm-workspace.yaml` accordingly.
- **SHA-pinned actions.** Every `uses:` in `.github/workflows/`
  pins to a 40-character commit SHA with an explanatory version
  comment. Dependabot updates both fields together when a new
  upstream tag publishes.
- **Workflow security lint (`zizmor` pedantic).** Runs on every
  push and PR, uploading SARIF to Code Scanning. Catches
  unpinned actions, template-injection through user-controlled
  context vars, cache cross-ref poisoning, overbroad token
  permissions, missing concurrency blocks, and undocumented
  permission scopes. Current finding count: zero.
- **OpenSSF Scorecard.** Weekly + on-push scoring published to
  [securityscorecards.dev](https://securityscorecards.dev/viewer/?uri=github.com/attaform/Attaform),
  surfacing the supply-chain health posture to downstream
  consumers.
- **Publish-job split.** `publish-npm.yml` is now two jobs:
  `validate` (workspace-wide `pnpm check`, no `id-token`) gates
  `publish` (scoped install, OIDC handshake, signed version
  bump, npm publish, GitHub release). The publish job only
  starts when validate is green.
- **Cache hygiene.** `actions/cache` is split into `cache/restore`
  (every job) and `cache/save` (main-push only) with the
  `restore-keys` prefix-fallback removed. PR runs no longer
  write to main's cache key, closing the cross-ref cache
  poisoning vector.
- **Least-privilege workflow permissions.** Every workflow
  declares `permissions:` at the top level (`contents: read` or
  tighter); individual jobs upgrade to the exact scopes they
  need with inline rationale comments.
- **Per-workflow concurrency.** Publish + deploy serialize
  without cancelling mid-flight; PR-time workflows (lint,
  typecheck, dependency review) cancel stale runs on new
  commits.
- **Env-bound workflow context.** `${{ github.event.inputs.* }}`,
  `${{ github.actor }}`, `${{ github.server_url }}`,
  `${{ github.repository }}`, `${{ github.run_id }}`, and step
  outputs are bound to step `env:` blocks before reaching any
  shell or `node -e` script. Removes the template-injection
  expansion path that interpolates workflow-context values into
  the runner's bash before quoting takes effect.
- **`CODEOWNERS` + `SECURITY.md`.** Default ownership rules and
  the security disclosure policy are now first-class repo files.
  Private vulnerability reporting + maintainer contact + PGP
  fingerprint surface from the repo's Security tab.

## v0.18.1
Attaform now ships with **zero runtime dependencies**. The
SSR-accessed SFC transform that pulled in `magic-string` now
uses a small in-file helper, with the same rewrites and no
third-party install.

### Internal

- **Faster contributor lint.** `pnpm lint` drops from 25+
  minutes to ~19s cold and ~3s warm. The dominant fix is a
  single missing ignore: the REPL's bundled type cache under
  `apps/site/.repl-cache/**` (60k+ lines of `.d.ts` files)
  was being linted on every run. A small structural pass
  alongside it keeps the type-aware parser scoped to the
  rule block that actually reads it. Same rule coverage as
  before.

## v0.18.0
Multistep flows (`useWizard` + `injectWizard`), a Nuxt DevTools
panel, schema-faithful preprocess (`z.preprocess` / `z.coerce`
no longer mutate `form.values`), `v-register` on
`<input type="file">`, and a rebuilt docs site. Pre-1.0
rip-and-replace; no compat shims.

### New

- **`useWizard({ steps, ... })`**, a list-based multistep
  orchestrator. Each step is a `useForm` reference, a bare
  string (affordance-only step, desugars to a noop form), an
  eager function returning a form / key, or a `lazy(ctx => ...)`
  marker. Returned surface: `next` / `back` / `goTo` / `reset`
  navigation, `currentStep` / `activeIndex` / `count` /
  `isFinalStep`, `canAdvance` / `canGoBack` / `progress` /
  `complete` / `done`, namespaced `allValues` / `allErrors` /
  `statuses`, and a typed `forms` map.
- **`wizard.handleSubmit(onSubmit, onError?)`.** Intermediate-
  step calls validate the active form and advance; final-step
  calls validate every form in parallel. Submit context is
  `{ values, get(formRef), currentKey, isFinal }` with
  `values: Readonly<Record<FormKey, WizardValue>>`. Failed
  final-step submits reveal errors across the wizard
  simultaneously.
- **`injectWizard()`** for cross-component access. Ambient
  lookup reaches the nearest
  anonymous `useWizard()`; keyed lookup
  (`injectWizard('signup')`) reaches any registered wizard.
  Returns `null` with a dev warning on miss.
- **Wizard URL sync.** `WizardOptions.restore` /
  `WizardOptions.persist` round-trip `?step=<key>`; pass `false`
  to opt out or a callback for alternate storage. Nuxt
  deep-links hydrate without mismatch warnings.
- **`v-register` on `<input type="file">`.** Storage shape:
  `File | null` (single) or `File[]` (`multiple`). Empty
  selections route through `form.blankPaths` for required-file
  errors. `z.file()` is a first-class leaf in the v4 adapter,
  so `form.fields.<filePath>` resolves to a `FieldState`.
  `register(path, { persist: true })` on a file input is
  silently dropped with a dev warn (browsers block programmatic
  writes to pickers). Recommended pattern: upload-on-select +
  a sibling URL field.
- **Nuxt DevTools panel.** A new `attaform` tab auto-wires
  through `@nuxt/devtools-kit` in dev mode. Live value tree
  with click-to-edit leaves, schema vs user errors split by
  source, submit aggregates, and a 200-entry timeline of
  `onFormChange` / `onSubmitSuccess` / `onReset`. New exports:
  `DEVTOOLS_WINDOW_KEY`, `REDACTED`, `redactSensitiveLeaves`,
  `AttaformDevtoolsBridge`. New subpath:
  `attaform/devtools-panel`.
- **One `useForm` across Zod v3 and v4.** `attaform/zod` now
  dispatches per-call on schema shape, so four+ `useForm` calls
  in one scope no longer trip TS2589. New helpers
  `UseFormReturn<Schema>` / `UseFormConfig<Schema>` (plus
  `V4` / `V3` variants for code generic over a major).
- **`form.meta` additions.** `submissionAttempts: number`
  (every `handleSubmit` call); `submitted: boolean` (latches
  on a successful submit, cleared by `reset()`);
  `departAttempts: number` (real wizard departures).
- **Public `form.applyInvalidSubmitPolicy(policy?)`** and
  **`form.rehydrate()`**. `rehydrate()` re-fires a function-form
  `defaultValues` factory.
- **New error codes.** `AttaformErrorCode.ValidatorThrew`
  (throws inside `z.preprocess` / `.refine` / `.transform`),
  `HydrationFailed` (`defaultValues` factory throws),
  `ActivationFailed` (walked-form factory throws during
  `wizard.handleSubmit`). All surface as path-tagged
  `ValidationError` instead of bubbling as `submitError` or
  unhandled rejections.

### Breaking

- **`z.preprocess` / `z.coerce` no longer mutate `form.values`.**
  They run only at parse time (`handleSubmit`, `validate`,
  `validateAsync`, `form.process()`). `form.values('email')`
  holds the verbatim input; the parsed output appears as
  `data` in `form.handleSubmit((data) => ...)`.
- **`form.blankPaths.value` is `BlankPathsView`** (was
  `ReadonlySet<string>`). Exposes `.size`,
  `.has(string | Path)`, `.values()`, and iteration yielding
  `Path` arrays. Old persisted blank-path payloads drop on
  hydration with a dev warn.
- **`FieldState.touched` is `boolean`** (was `boolean | null`).
  Plain `false` at registration, sticky `true` after first
  blur, cleared only by `reset()` / `resetField()`. Migrate
  `touched === null` checks to `touched === false`.
- **`form.hydrateError` is `ValidationError | null`** (was
  `unknown | null`), normalised with
  `code: 'atta:hydration-failed'`. `form.isHydrating` and
  `form.hydrateError` are auto-unwrapping (read without
  `.value`).
- **`form.errors.<container>[''] ` is a new terminal slot.**
  Cross-field refines (`z.object({...}).refine(...)`) and
  server-side errors keyed at a container path surface
  through the proxy under the `''` sentinel at any depth.
  Schemas with a literal `''` field share the slot.
- **`typeof useForm<S>` type-query patterns break.** Overload
  resolution picks the last overload. Migrate
  `ReturnType<typeof useForm<S>>` to `UseFormReturn<Schema>`,
  `Parameters<typeof useForm<S>>[0]` to `UseFormConfig<Schema>`.
- **Removed exports.** `StepperLateRegistrationError`;
  `normalizeWriteValueAtPath` (adapter contract; replaced by
  `isPreprocessOrCoerceLeaf`).
- **`RegisterValue`'s full runtime shape now ships in the
  published `.d.ts`** (was stripped). Fixes a directive-shape
  mismatch in downstream Vue apps.

### Behaviour

- **`defaultShouldShowErrors` sharpened.** Post-submit
  (`submissionAttempts > 0` or `submitCount > 0`) reveals every
  own-path error unconditionally; errors hide while
  `field.validating === true` (stale-while-revalidate).
- **`<input autofocus>`** lands with `focused: true`
  immediately instead of waiting for the next event.
- **Throwing `.refine` / `.transform` / `z.preprocess`**
  surface as path-tagged `ValidationError`
  (`atta:validator-threw`).
- **DOM clears on non-string-accepting leaves** route through
  `markBlank()`, fixing the undeletable last-character on
  `z.number()` fields rendered as `<input type="text">`.

### Fixes

- **`attaform/vite` subpath rewrite.** The
  `attaform/zod → attaform/zod-v{3|4}` hook 404'd in real
  Nuxt 4 consumers; now forwards correctly.
- **`about:srcdoc` history calls.** REPL iframes no longer
  blow up with `SecurityError` when the wizard writes
  `?step=...`.

### Docs

- **Concept-per-page rebuild (~70 pages across 12 categories):**
  Getting started, Schemas, Reading the form, Binding inputs,
  Writing & mutating, Validation, Submitting, Persistence,
  Cross-cutting state, Server & SSR, DevTools & debugging,
  Multistep, Reference. Each page leads with a one-line
  definition, a metadata strip, and a working inline demo.
  New `/play/[slug]` standalone playgrounds with `?from=`
  back-links to the originating docs page. 301 redirects
  cover the pre-rebuild URL tree.
- **New homepage + README** with schema-first positioning, a
  `v-register` progressive-disclosure showcase, an 8-card
  feature grid, and a `useWizard` callout.
- **Measured-perf table** in
  `docs/server-and-ssr/performance.md` (keystroke /
  validation / submit / persistence figures against the
  16.7 ms 60 fps budget).
- **`llms.txt`** at
  [`attaform.com/llms.txt`](https://www.attaform.com/llms.txt)
  gives AI crawlers and other LLMs a focused, terse view of
  Attaform's mental model plus categorised links into the
  docs.

## v0.17.2
_No unreleased changes yet._

## v0.17.1
_No unreleased changes yet._

## v0.17.0
Library-hardening campaign closeout (52 failing probes → 0,
19 buckets resolved) + multi-tab sync as a headline feature.
Pre-1.0 rip-and-replace; no compat shims.

### Features

- **Multi-tab sync via `BroadcastChannel`.** Same-keyed
  `useForm` callsites in same-origin tabs auto-pair and mirror
  mutations in near real-time. Identity = `form.key` + schema
  fingerprint; no opt-in flag. Mount uses leader-election
  handshake (O(N) tiny announces + 1 snapshot). Cascade:
  `register({ multiTab })` > `useForm({ multiTab })` > global >
  library default `true`. Defenses: same-origin + secure-context
  gate (HTTPS or localhost — also gates built-in persistence
  storage adapters), bidirectional sensitive-path filter,
  prototype-pollution rejection, `senderId` echo drop, `v: 1`
  protocol versioning, post-apply schema validation. See
  `docs/recipes/multi-tab-sync.md` for the threat model.
- **Configurable sensitive-name heuristic.** Exported
  `DEFAULT_SENSITIVE_NAMES` (frozen) + `sensitiveNames` config
  at global / per-form. Resolved closure threads through
  persistence, multi-tab sync, AND DevTools redact walk.
- **`form.history` namespace.** Undo / redo / new `clear()`
  method + reactive `canUndo` / `canRedo` / `size` flags all
  under one bundle. **Breaking:** `form.undo` / `form.redo` and
  `form.meta.canUndo` / `canRedo` / `historySize` removed.
- **`form.process()`** — on-demand post-transform snapshot.
- **`form.touch(path?)`** — programmatic touched-flag flip.
- **`field.showErrors` + `field.firstError`** with configurable
  `shouldShowErrors` predicate (per-form / global).
- **`form.setFormErrors` / `form.clearFormErrors`** — formal
  surface for the form-level error bucket at `path: []`.
- **`maxRecursionDepth` knob** for recursive `z.lazy(...)`
  schemas. Library default 64; pass `Infinity` to disable.
- **Input/output type split** — `defaultValues` + `setValue`
  accept `z.input<Schema>`; `form.values()` returns
  `z.output<Schema>`. Write-boundary input normalization
  (preprocess) runs at `setValue` time.

### Behaviour changes

- **`reset()` re-derives schemaErrors AND re-runs validation
  against post-reset state.** Pre-fix, reset cleared errors
  and never re-validated → form sat invalid with empty error
  store, or (for async-refining schemas) container `.valid`
  read `true` for 600ms–1.5s before the async pass landed (the
  docs-site stepper demo flashed green on Reset). Four-part
  fix: pre-merge constraints via `mergeStructural`, run sync
  re-derive, restore `firstValidationDone` gate to its
  construction-time value, re-queue the async validation pass.
- **`reset()` is undoable.** Pre-reset state stays one
  `history.undo()` away; call `form.history.clear()` for a
  hard wipe.
- **Persistence hydration is the history floor.** Stacks
  reseed from the post-hydration snapshot.
- **`resetField('')` is the form-level path**, not "reset
  everything." Clears the form-level error bucket only.
- **`handleSubmit` rejects re-entry** while a submission is in
  flight (no double-click parallel submits).
- **`setFieldErrors` / `addFieldErrors` filter to own
  `formKey`** — cross-form entries dropped with dev warning.
- **Per-instance config lift.** Shared-key `useForm` callsites
  honor their own `validateOn` / `debounceMs` /
  `shouldShowErrors` / `coerce` / `rememberVariants`.
- **`Symbol`-keyed properties stripped at `setValue` boundary.**
- **Non-discriminated `z.union` of literals: writes accept,
  validation surfaces mismatches** (slim-primitive gate is
  type-shape, not value-content).

### Discriminated-union hardening

- Unknown discriminator values land in a stub state (~21
  probes resolved).
- Surgical variant-memory clearing per array op via
  `WriteMeta.arrayOp` hints.
- `z.intersection` peels in DU unwrap.
- Array gaps pad with element defaults during DU reshape.

### Bug fixes

- `z.any()` paths preserve `any` (not `unknown`) on `setValue`.
- `setValue` callback's `prev` types as `unknown` (not `any`)
  at preprocess paths.
- All public-API numeric options sanitised at injection
  (`NaN` / `Infinity` / negatives clamp to library defaults).
- DU-aware persistence hydration merge.
- `zod-v3` adapter preprocess parity at the write boundary.
- Counter-desync vector closed in submit + validation
  lifecycles.
- `form.errors` template / JSON / form-level visibility parity.
- Adapter-throw harmonised across `validateAsync` /
  `form.process()`.

### Internal

- History stored as base + forward deltas (was per-mutation
  full snapshots).
- `SSRDetectOptions.override` renamed to `.ssr`.

### Docs + site

- New recipe: `docs/recipes/multi-tab-sync.md` with required
  `## Security` section.
- Persistence recipe: secure-context-gate documentation +
  `sensitiveNames` composition example.
- SEO discovery gated on `VERCEL_ENV === 'production'` —
  preview / sandbox deploys emit `noindex` + suppressed
  sitemap, mirroring the IndexNow ping gate.

## v0.16.4
_No unreleased changes yet._

## v0.16.3
_No unreleased changes yet._

## v0.16.2
_No unreleased changes yet._

## v0.16.1
_No unreleased changes yet._

## v0.16.0
_No unreleased changes yet._

## v0.15.1
_No unreleased changes yet._

## v0.15.0
- **Sync-refinement errors seed at construction even when an async
  sibling is present (zod-v4 adapter).** When a strict-mode form's
  schema mixes sync and async refinements, sync-refinement
  violations on the supplied `defaultValues` now seed into
  `state.schemaErrors` immediately at construction. Pre-fix, the
  presence of any async refine caused `safeParse` to throw, and
  the catch swallowed every sync-refinement error along with the
  async ones — sync verdicts only landed after the post-mount
  async pass, so UI bound to construction-time errors ("fix N
  errors" badges, the demo REPL stepper) flickered for a frame.
  The catch now retries against a sync-only variant of the schema
  via a new `stripAsyncChecks` helper that filters async refines
  while preserving every sync refine (`.refine`, `.superRefine`,
  built-in checks). Async-only verdicts stay deferred to the
  post-mount async pass — that contract is unchanged. The zod-v3
  adapter carries the same conceptual gap; lifting v3 to parity
  requires a probe-and-parse detection scheme or a slim-schema
  redesign and is tracked as a follow-up.

- **Discriminated-union access extends to `form.values` and to
  every path-resolver type.** `form.values.cargo.permitNumber`
  (oversized-only) now types as `string | undefined` regardless of
  active variant — the same merged-view treatment we applied to
  `form.fields` and `form.errors`. Implementation lifts `ValuesSurface`
  via a new `LiftedValueShape<T>` helper. In addition, `NestedType`
  and `NestedReadType` switched to `KeyofUnion` / `ValueOfUnion` so
  path lookups on a union descent agree with `FlatPath`: every path
  `FlatPath` says is reachable now resolves to a useful value type
  (variant-specific paths previously collapsed to `never` because
  `keyof (A|B|C)` is the intersection of variant keys, not the
  union). Net: `setValue('cargo.tempMinC', 4)`, `toRef('cargo.tempMinC')`,
  `register('cargo.tempMinC')` etc. now typecheck on schemas where
  `tempMinC` is variant-only. Strict-variant write-side input still
  required by `setValue` and `defaultValues` whole-cargo writes —
  `WriteShape` itself stays distributive.

- **Discriminated-union forms expose merged metadata proxies.**
  `form.fields.X.Y` and `form.errors.X.Y` chained access now resolves
  for variant-only keys regardless of which discriminant is active.
  Reading `form.fields.cargo.tempMinC` (refrigerated-only) when the
  active variant is `dry` types as `FieldStateLeaf<number | undefined>`
  and resolves to a stable stub `FieldStateView` at runtime
  (`value: undefined`, `errors: []`, `valid: true`). Reading
  `form.errors.cargo.tempMinC` types as
  `readonly ValidationError[] | undefined` and yields `undefined` when
  no error is present at that path. Implementation: a "lift" in
  `FieldStateMapEntry`, `FieldStateMap`, and `ErrorsProxyShape` that
  merges variant key sets via two new utility types
  (`KeyofUnion`, `ValueOfUnion`), gated by `IsUnion<T>` so single-
  object schemas skip the merge entirely (zero perf cost on the
  common case). Value-shape types (`form.values`, `defaultValues`,
  `setValue` parameters) intentionally keep their existing
  discriminated-union distribution so consumers can still pattern-
  match on the runtime variant; the merged view of values is
  available through `form.fields.X.Y.value` or `form.values('X.Y')`.

- **Tuple-segment overload across path APIs.** New array-form
  overloads accept segments directly:

  ```ts
  form.register(['cargo', 'items', 0, 'sku'])
  form.setValue(['cargo', 'items', 0, 'sku'], 'SKU-1001')
  form.toRef(['cargo', 'items', 0, 'sku'])
  form.fields(['cargo', 'items', 0, 'sku'])    // typed FieldStateLeaf
  form.errors(['cargo', 'items', 0, 'sku'])    // typed errors
  form.errorsAt(['cargo', 'items'])             // typed prefix
  ```

  Resolved value types match the dotted-string forms exactly.
  Particularly useful inside a `v-for` over a prefix variable, where
  dotted concatenation widens a literal union to plain `string`:
  `form.register([block.prefix, 'line1'])` preserves
  `'pickup' | 'delivery'` through the joined path. New `JoinSegments`
  helper (in `runtime/types/types-core`) is exported alongside; no
  new path-segment union type is added (the constraint reuses the
  existing `FlatPath` / `RegisterFlatPath`). Type-check perf on the
  public surface (`src/`) is unchanged in practice (within ±20ms of
  baseline). The `fields()` and `errors()` callables keep their
  permissive `(segments: ReadonlyArray<string | number>)` overload as
  an untyped fallback so dynamic `Path`-typed inputs (e.g.
  `RegisterValue.segments`) keep working without casts.

- **`form.errorsAt(path)`.** Read-side aggregate that returns every
  error whose path **is** the given path **or descends from it**.
  Aggregates schema, blank-derived, and user-injected errors in the
  same order as `meta.errors`. Accepts both dotted-string
  (`errorsAt('cargo.items.0')`) and segment-array
  (`errorsAt(['cargo', 'items', 0])`) paths. Root prefix
  (`errorsAt('')` / `errorsAt([])`) matches every error including
  form-level. Useful for step-validity gating in multi-step forms:
  `STEP_PATHS[step].every(p => form.errorsAt(p).length === 0)`.
  New `isPathPrefix` helper exported from the path primitives.

- **`form.setFormErrors` / `form.clearFormErrors`.** First-class
  shortcut for the form-level error case (entries at `path: []`).
  Replaces just the form-level slot — field errors are untouched —
  with the library filling in `path: []`, `formKey`, and a default
  `code: 'atta:form-error'` per entry. Pass an empty array (or call
  `clearFormErrors()`) to clear. Form-level errors continue to
  surface in `meta.errors` only; the path-keyed `form.errors` proxy
  intentionally excludes them.

- **Per-field `validating` and `valid`.** `form.fields.<path>.validating`
  is the per-field analogue of `form.meta.validating` — `true` while a
  field-level run is in flight at this path (debounced
  `validate-on-change` runs and cross-field re-validations targeting
  the path). Whole-form `validate()` / `validateAsync()` calls drive
  `meta.validating` only and don't flip per-field flags.
  `form.fields.<path>.valid` is the composite signal: `true` iff
  `errors` is empty AND `validating` is `false`. Same shape as
  `meta.valid`. Reactive Map under the hood (`fieldValidationCounts`
  on `FormStore`); `> 0` semantics so a brief abort/restart overlap
  doesn't flicker `validating` off mid-flight.

- **Breaking — `is`-prefix dropped from state-boolean property names.**
  `form.meta` and `FieldStateLeaf` now use bare adjectives for state
  flags, reserving the `is` prefix for type-predicate functions
  (`isPlainRecord(x)`, `isUnset(x)`). Renames:

  | Before                          | After                         |
  | ------------------------------- | ----------------------------- |
  | `form.meta.isDirty`             | `form.meta.dirty`             |
  | `form.meta.isValid`             | `form.meta.valid` (see below) |
  | `form.meta.isSubmitting`        | `form.meta.submitting`        |
  | `form.meta.isValidating`        | `form.meta.validating`        |
  | `form.fields.<path>.isConnected`| `form.fields.<path>.connected`|

  `meta.valid` ALSO gets a stricter semantic: it now requires both
  empty error stores AND `!validating`, so the value can't read `true`
  during the brief window between an async refinement starting and
  resolving. The looser "errors-only" check is gone.

  Internal renames mirror the public ones: `state.isSubmitting` →
  `state.submitting`, `state.isSSR` → `state.ssr`, `FieldRecord.isConnected`
  → `FieldRecord.connected`, `FormStoreOptions.isSSR` → `ssr`,
  `AttaformRegistry.isSSR` → `ssr`. The DOM API `Element.isConnected`
  is untouched (W3C standard).

- **Reactive `RegisterValue.path` proxy.** `register('email').path`
  now tracks under `computed` / `watchEffect` reads — rotating the
  parent's path binding re-runs dependents in the child without a
  manual `.value` step. `formKey`, `formInstanceId`, and `segments`
  added alongside; `path` keeps its canonical JSON-encoded `PathKey`
  form, `segments` is the consumer-friendly array. `RegisterValue` is
  now `shallowReadonly(shallowReactive(...))`.

## v0.14.0
_No unreleased changes yet._

## v0.14.0-rc.0
- **Breaking — `useForm` validation config flattens.** The nested
  `fieldValidation: { on, debounceMs }` object is gone; both fields
  move to the top level as `validateOn` and `debounceMs`. The third
  trigger renames `'none'` → `'submit'` (submit IS the validator;
  the new name reads more directly). The `debounceMs` default flips
  `125` → `0` (synchronous; no `setTimeout` indirection — `0` is the
  off-switch). `debounceMs` is now type-gated to `validateOn:
  'change'` via the discriminated `ValidateOnConfig` union; pairing
  it with `'blur'` / `'submit'` is a TS error rather than a silent
  runtime drop. Type renames: `FieldValidationConfig`,
  `FieldValidationMode` are deleted; new types are `ValidateOn`,
  `ValidateOnConfig`. Migration in
  [migration guide](./docs/migration/0.13-to-0.14.md).

- **Breaking — `validationMode: 'strict' | 'lax'` → `strict: boolean`.**
  String-literal config flattens to a boolean. Default is `true`
  (previously `'strict'`). The `ValidationMode` type is deleted (no
  alias; pre-1.0 clean replace). The v3 adapter's previously-inconsistent
  `undefined` semantics standardize to match v4: `undefined` `strict`
  now means strict everywhere (was `'lax'`-equivalent in the v3 path
  pre-rename). Forms using the v3 adapter without an explicit
  override now seed construction-time validation errors and keep
  refinements in slim defaults; pass `strict: false` to opt back
  into the old `'lax'`-equivalent behaviour.

- **Breaking — useForm return shape rewritten around drillable
  proxies + `meta`.** `form.state` → `form.meta` (plus a new
  `meta.errors` flat aggregate and per-mount `meta.instanceId`).
  `form.errors` / `form.values` / `form.fields` become leaf-aware
  callable Proxies (drill via dot/bracket OR call dynamically;
  single-bracket dotted access is intentionally NOT supported).
  `useFormContext` → `injectForm`. `FormState` → `FormMeta`.
  `FormFieldErrors` → `FormErrorsSurface`. Full migration in
  [migration guide](./docs/migration/0.13-to-0.14.md).

- **New — schema-driven coercion** (`useForm({ coerce })`).
  User-typed DOM values get coerced to the schema's slim type at
  the directive layer — `string→number` and `string→boolean` by
  default. Pass `false` to disable, or a `CoercionRegistry` to
  replace the built-in rules. `defineCoercion(...)` narrows
  `transform` parameter typing for custom rules. Programmatic
  writes (`form.setValue`, `setValueWithInternalPath`) are NEVER
  coerced — coercion is user-input-only. New exports:
  `defaultCoercionRules`, `defineCoercion`, `CoercionEntry`,
  `CoercionRegistry`, `CoercionResult`. See
  [recipe](./docs/recipes/coerce.md).

- **New — register transforms** (`register(path, { transforms: [...] })`).
  Sync pure-function pipeline that runs AFTER directive modifiers
  (`.lazy` / `.trim` / `.number`) and BEFORE the assigner. Useful
  for trim / lowercase / mask / clamp normalisations. New export:
  `RegisterTransform = (value: unknown) => unknown`. Generic-erased
  so a personal library of transforms plugs into any path. See
  [recipe](./docs/recipes/transforms.md).

- **New — discriminated-union variant memory** (`useForm({ rememberVariants })`).
  Switching a DU variant (`notify.channel: 'email' → 'sms' →
  'email'`) restores the previous variant's typed subtree by
  default. Default `true`; pass `false` to drop the outgoing
  variant on every switch. Memory is in-memory only and does not
  survive reload — persisted state restores values on hydration,
  but variant memory starts empty. `reset()` clears all memory;
  `resetField(path)` clears entries under `path`. See
  [recipe](./docs/recipes/discriminated-unions.md).

- **Fix — DOM force-sync after default assigner.** When a transform
  or coerce produces a value identical to current storage, the
  diff-apply layer skipped the patch (no semantic change → no
  reactive trigger → no render), leaving the DOM stranded at the
  user-typed text. The directive now imperatively syncs the DOM
  to storage after the default assigner runs across every variant
  (text / checkbox / radio / select). Custom assigners
  (`@update:registerValue`) keep ownership — the force-sync is
  gated on `isDefaultAssigner`.

- **Fix — `debounceMs: 0` skips `setTimeout` entirely.** Both the
  field-validation debouncer and the persistence debouncer
  (`createDebouncedWriter`) treat `0` as the off-switch. Pre-fix
  they fell through to `setTimeout(fn, 0)` (next macrotask, browser
  clamps to ~4 ms); now they fire synchronously.

- **Persistence hydration now revalidates against the rehydrated
  value.** Pre-fix `wirePersistence` swapped in the persisted form
  via `applyFormReplacement` and stopped — sync errors stayed stale
  (still describing the empty default), and async refines never
  fired. A consumer who persisted `email: 'taken@example.com'`
  (passes `z.email()` sync, fails an async uniqueness refine) would
  refresh into a form the runtime considered VALID, surfacing
  whatever success message the template gated on `errors.email`
  being absent. Hydration now schedules an immediate full-form
  validation pass so sync + async results land against the actual
  rehydrated value. Affects every `persist:` configuration.

- **New — construction-time async-validation seed in strict mode.**
  Schemas carrying async-only verdicts (e.g. zod's
  `.refine(async (v) => …)`) previously didn't surface those errors
  at construction — sync `safeParse` throws on async pieces, the
  adapter caught and returned success. The runtime now asks the
  schema's `needsAsyncValidation()` and queues a one-shot full-form
  async pass when true, so errors land on a later microtask without
  waiting for a user mutation or a manual `validateAsync()` call.
  Two timing gates protect SSR↔CSR hydration parity: (a) the
  scheduling is skipped entirely on SSR (microtasks don't get
  awaited before serialisation, so the validation can't complete
  server-side; firing it would only stamp a misleading
  `isValidating: true` into the SSR HTML); (b) the client-side
  scheduling is wrapped in `queueMicrotask` so the
  `activeValidations++` lands AFTER Vue's synchronous hydration /
  first render, keeping SSR and CSR first-render output in sync.
  Sync schemas (the common case) still validate fully synchronously
  — detection skips the async pass so `meta.isValidating` doesn't
  flash true at mount for forms that have nothing async to validate.
  `AbstractSchema` gains an OPTIONAL `needsAsyncValidation?(): boolean`
  method — adapters that don't model async work can omit it, the
  runtime treats absence as `false`. Zod v4 implements it via a
  schema-tree walk; the v3 adapter omits it (consumers wanting
  construction-time async errors should use `attaform/zod`).

- **`parseApiErrors` now accepts the bare-string Rails / DRF / Laravel
  shape (`{ field: ["msg"] }`).** Pre-fix the parser required every
  entry to be a structured `{ message, code }` object; payloads
  emitting bare strings (the de facto JSON convention for many
  backends) returned `result.ok === false` and the recommended
  `if (result.ok) form.setFieldErrors(result.errors)` pattern silently
  did nothing. Bare strings now synthesize a `{ message: <str>,
  code: <defaultCode> }` ValidationError, with `defaultCode`
  defaulting to `'api:unknown'` and configurable via the new
  `defaultCode?: string` option. Structured `{ message, code }`
  entries continue to forward `code` verbatim. Mixed arrays are
  fine. Half-structured entries (`{ message }` missing `code`) are
  still rejected — a server emitting that probably has a bug worth
  surfacing.

- **Behavior change — `focusFirstError` / `scrollToFirstError` /
  `onInvalidSubmit: 'focus-first-error'` target the visually-first
  errored field instead of the schema-declaration-first.** "First" is
  now DOM-tree order via `compareDocumentPosition`; pre-fix it was
  schema-declaration order (the order Zod emitted issues, which the
  internal error Map preserved). Templates that rendered fields in a
  different order than the schema declared them previously focused
  the wrong field on submit failure. CSS `order:` flexbox/grid
  reordering is NOT respected — DOM-tree order wins. See the
  [troubleshooting entry](./docs/troubleshooting.md#focus-jumped-to-a-field-i-didnt-expect-on-submit)
  for the caveat.

- **Behavior change — focus is now scoped to the calling
  `useForm()` instance.** When two `useForm({ key })` callsites share
  a key (sidebar + main rendering the same form), each callsite's
  `focusFirstError` only targets elements registered through THAT
  callsite. Pre-fix, the sidebar's submit could focus the main
  form's input or vice versa. Children reaching the form via
  `injectForm()` inherit their ancestor's instance ID, so
  parent-submit-focus continues to work for inputs registered by
  deep children.

- **New — `form.meta.instanceId: string`.** Per-`useForm()`-call
  identity, opaque format, stable per mount. Useful for devtools
  panels disambiguating shared-key mounts, telemetry hooks tagging
  events, E2E test selectors (`data-form-id={form.meta.instanceId}`),
  and Vue `:key` on keyed lists of dynamically-rendered forms.
  Treat as identity, not state — don't parse, don't compare
  ordinally, don't persist.

- **Breaking — dropped `WithIndexedUndefined` from `form.values` and
  the whole-form `setValue((prev) => …)` callback.** The wrapper baked
  `| undefined` into every unbounded array's element type so
  `arr[N]` reads were honest about out-of-bounds — but the same
  widening also tainted iteration (`v-for`, `for-of`, `.map`, etc.)
  where every element exists by definition, producing spurious
  `T | undefined` on perfectly safe reads. The job is better done by
  TypeScript's `noUncheckedIndexedAccess: true` tsconfig flag, which
  scopes the taint to indexed access only and leaves iteration as
  `T`. The lib-level wrap was both redundant for consumers who set
  the flag, and worse than nothing for those who didn't (no
  iteration ergonomics either way).

  Migration: enable `noUncheckedIndexedAccess: true` in your
  consumer tsconfig (Nuxt projects already get it via the generated
  `.nuxt/tsconfig.*.json`). `arr[N]` and `prev.posts[N]` reads keep
  the same `T | undefined` typing they had before; iteration cleans
  up. The `WithIndexedUndefined<T>` type export is removed.

## v0.13.0
_No unreleased changes yet._

## v0.12.1
_No unreleased changes yet._

## v0.12.0
**Validation refactor: errors as a pure function of `(value, schema) +
injected user errors`.** The data layer (errors as state) is now fully
separable from the rendering layer (when to show them). Schema-driven
errors and consumer-injected errors live in distinct internal stores;
each has its own lifecycle, and the merged read view stays unchanged
for consumers. See the [migration guide](./docs/migration/0.11-to-0.12.md)
for the full set of changes.

- **Breaking — live validation by default.** `fieldValidation.on`
  defaulted to `'none'` in 0.11; it now defaults to `'change'`.
  Errors track the live `(value, schema)` instead of going stale
  until the next submit. `'none'` remains as the explicit opt-out
  for "submit-only" workflows. Migration: pass
  `fieldValidation: { on: 'none' }` to keep the old behaviour.
- **Breaking — `validationMode` defaults to `'strict'`.** Was `'lax'`
  in 0.11. Combined with the construction-time seed below, forms
  whose default values fail validation now report errors immediately
  — no user mutation or `validateAsync` call required. Lax remains
  as the explicit opt-out for multi-step wizards, placeholder rows
  in field arrays, and any case where mounting with invalid data is
  intentional. Migration: pass `validationMode: 'lax'` to keep the
  old behaviour.
- **Breaking — errors split by source.** `setFieldErrors` /
  `addFieldErrors` write to a separate user-error store internally;
  their entries now SURVIVE schema revalidation AND successful
  submits (only `clearFieldErrors` / `reset` / `resetField` remove
  them). Public surfaces (`fieldErrors`, `state.isValid`,
  `getFieldState(path).errors`) merge schema + user transparently —
  schema first, user second. `clearFieldErrors(path?)` deliberately
  clears both stores at the given path (pragmatic "make these
  errors go away" semantic).
- **Breaking — `setFieldErrorsFromApi` retired.** Replaced by the
  pure `parseApiErrors(payload, { formKey })` exported helper +
  `setFieldErrors(result.errors)`. The form's setter surface is now
  one canonical write; shape adapters live as composable parsers.
  Old: `form.setFieldErrorsFromApi(payload)`. New:
  `const r = parseApiErrors(payload, { formKey: form.key }); if (r.ok) form.setFieldErrors(r.errors)`.
  New exports: `parseApiErrors`, `PARSE_API_ERRORS_DEFAULTS`,
  `ParseApiErrorsOptions`, `ParseApiErrorsResult`. The parser
  returns a discriminated `{ ok, errors, rejected? }` so malformed
  payloads are visible (vs. the old "returns empty array" silent
  failure).
- **Breaking — persistence payload v2.** `PersistConfig.version`
  defaults to `2` (was `1`). On-disk shape: `data.errors` is gone,
  replaced by `data.schemaErrors` + `data.userErrors`. Old v1
  payloads are dropped silently on read; users see one fresh-defaults
  render after upgrading.
- **Breaking — SSR / hydration payload split.** `SerializedFormData`
  and `FormStoreHydration` types now carry `schemaErrors` +
  `userErrors` separately. Nuxt + bare-Vue serialize/hydrate
  bridges handle this transparently; only consumers reading the
  payload struct directly need to update.
- **Breaking — legacy `state.errors` writers removed.** The `errors`
  Map alias and `setErrorsForPath` / `setAllErrors` / `addErrors` /
  `clearErrors` methods on `FormStore` are gone. Replacements:
  `state.schemaErrors` + `state.userErrors` for direct access;
  `state.setSchemaErrorsForPath` + `state.setAllSchemaErrors` /
  `state.setAllUserErrors` / `state.addUserErrors` /
  `state.clearSchemaErrors` / `state.clearUserErrors` for writes.
  Most consumers never touched these — the public
  `setFieldErrors*` + `clearFieldErrors` surfaces still cover the
  standard use cases.
- **New — construction-time schema-error seed.** Strict-mode forms
  whose default values fail schema validation now report errors
  immediately at construction (no user mutation or `validateAsync`
  call required). Lax-mode forms still skip the seed; hydration
  takes precedence over the seed when present. Mostly a quality-of-
  life win for SSR — `<pre>{{ form.fieldErrors }}</pre>` now
  matches the client's first frame.
- **New — app-level defaults on the plugin.** Pass
  `createAttaform({ defaults: { ... } })` (or
  `attaform: { defaults: { ... } }` on the Nuxt module) to set
  cx-wide preferences once instead of repeating them at every
  `useForm` call. Supported defaults: `validationMode`,
  `onInvalidSubmit`, `fieldValidation`, `history`. Per-form options
  always win; `fieldValidation` shallow-merges at the field level so
  consumers can set `debounceMs` globally and override `on` per-form.
  See [recipe](./docs/recipes/app-defaults.md). Additive — existing
  apps that don't pass `defaults` are unchanged.
- **Breaking — synthetic-key namespace reserved.** `useForm({ key })`
  now throws `ReservedFormKeyError` when the consumer-supplied key
  starts with `__atta:`. The library uses the `__atta:` prefix for its
  internal synthetic keys, and synthetic anonymous-form keys are now
  `__atta:anon:<id>` (was `cx:anon:<id>`). Consumers using either prefix
  at any call site need to rename. Reserves the `__atta:` namespace for
  future internal use; with the entry-reject in place, collisions
  between consumer keys and library-allocated keys are now impossible
  by construction.
- **Breaking — persistence opt-in moved to per-field.** Form-level
  `persist: { storage: 'local' }` no longer auto-persists every
  field. Each persisted field opts in explicitly at its `register()`
  call site: `register('email', { persist: true })`. Programmatic
  `form.setValue` no longer reaches storage; use new `form.persist(path)`
  for an explicit one-shot checkpoint. Sensitive-named paths
  (password / cvv / ssn / token / api-key / etc.) throw
  `SensitivePersistFieldError` at mount unless
  `acknowledgeSensitive: true` is also passed. Persisted payloads
  are sparse — only opted-in paths land in storage; hydration
  merges over schema defaults. `reset()` and `resetField(path)` now
  wipe the persisted draft alongside the in-memory clear.
  New APIs: `form.persist(path, opts?)`,
  `form.clearPersistedDraft(path?)`, `RegisterOptions`, `WriteMeta`,
  `SensitivePersistFieldError`. Dev-mode warning if persist is
  configured but no field opts in. The `assignKey` symbol on
  v-register elements gains an optional `meta` parameter (clean
  break for the rare consumer who supplied a custom assigner via
  `onUpdate:registerValue`). See the
  [migration guide](./docs/migration/0.11-to-0.12.md#breaking-persistence-opt-in-moved-to-per-field)
  + [persistence recipe](./docs/recipes/persistence.md) for the full
  rewrite.
- **New — shorthand `persist:` config.** `useForm({ persist: 'local' })`
  is now equivalent to `useForm({ persist: { storage: 'local' } })`;
  same shorthand for `'session'` / `'indexeddb'` and for custom
  `FormStorage` adapters (`persist: encryptedStorage`). The full
  options bag is still required to override `key`, `debounceMs`,
  `version`, etc. New `PersistConfigOptions` type exported alongside
  `PersistConfig` (which is now the union of all input forms).
- **New — cross-store cleanup at mount.** The configured `storage` is
  the source of truth for "where the draft lives now." Standard
  backends (`'local'` / `'session'` / `'indexeddb'`) NOT matching the
  configured one get a `removeItem(key)` (fire-and-forget). A
  migration `'local'` → `'session'` (or `'local'` → encrypted custom
  adapter) can no longer orphan PII / sensitive fields in the
  abandoned backend. Configuring a custom adapter sweeps all three
  standard backends. Inlined per-backend so it doesn't drag in the
  adapter chunks the consumer didn't ask for.
- **New — auto-wipe of stale persisted entries.** A non-empty raw
  value that fails to parse on hydration (version mismatch,
  malformed envelope, corrupted JSON) is now wiped from the
  configured backend instead of being left on disk. Bumping
  `persist.version` no longer leaves the old payload bytes lingering
  indefinitely. "Truly absent" entries stay a no-op — the wipe only
  fires when there's actually something to clean.
- **New — symmetric dev-mode warning for the inverse misuse.**
  `register('foo', { persist: true })` on a form with no `persist:`
  option configured on `useForm()` now logs a one-time warning in
  development pointing at the offending call. Pairs with the
  existing "persist configured but no opt-ins" warning so both halves
  of the wire-up problem produce a clear signal at the right call
  site. Production is silent.

**Structural-completeness invariant + fingerprint persistence + read-
type honesty.** Three intertwined gaps closed in one pass — every
`setValue` write now leaves the form satisfying the slim schema (so
consumer code can read `prev.first.toUpperCase()` without optional-
chaining), persisted-draft keys carry a schema fingerprint that
auto-invalidates across deploys with no manual `version` bump, and
the read-type for `getValue` / `register` now reports `T | undefined`
once the path crosses an array index (out-of-bounds is an honest
runtime case, not a type-system lie). See the
[migration guide](./docs/migration/0.11-to-0.12.md) for the full set
of related changes.

- **Breaking — `AbstractSchema.getDefaultAtPath(path)` is now
  required.** Custom-adapter authors implement a fifth method that
  returns the schema-prescribed default at a structured path
  (object property → property's default; array index → element
  default; tuple position → position default; optional/nullable
  around a structural inner → inner default; primitive
  optional/nullable → `undefined`/`null`). The runtime calls this
  on every `setValue` to fill structural gaps; without it, partial
  writes leak through and break the new invariant. Migration: see
  [custom-adapter recipe](./docs/recipes/custom-adapter.md). Both
  Zod adapters ship the implementation out of the box.
- **Breaking — `FormStorage.listKeys(prefix)` is now required.**
  Custom storage adapters implement a fourth method that returns
  every key whose name starts with `prefix`. The persistence layer
  uses it to find and clean up orphaned fingerprint-suffixed keys
  on mount. Adapters that can't enumerate (HTTP-backed drafts,
  cookie-backed) can return `[]` — orphan cleanup degrades
  gracefully on those backends.
- **Breaking — `setValue` drops `DeepPartial` from both forms.**
  `setValue(value)` and `setValue(path, value)` now expect the full
  write shape at the type level, both for direct writes and for the
  callback form's return. Runtime mergeStructural still completes
  partials so dynamic / typecast inputs don't crash, but the type
  system now leads with strictness — the IDE points consumers at
  the canonical "give me the whole shape" pattern. Path-form
  callback `prev` is now `NonNullable<T>` (the runtime auto-defaults
  missing slots from the schema before invoking the callback);
  whole-form callback `prev` is `WithIndexedUndefined<Form>` (array
  reads are honest about returning `Item | undefined`). Migration:
  switch partial value-form writes to the callback form, or spread
  the existing value (`setValue('user', { ...prev, name: 'X' })`).
- **Breaking — `getValue` and `register` use `NestedReadType<F, P>`
  instead of `NestedType<F, P>`.** Once a path crosses an array
  index segment (e.g. `'posts.0.title'`), every result is
  `T | undefined`. Strict (no taint) for paths that don't cross
  arrays. Tuple positions stay strict — a tuple's length is static
  so out-of-bounds is a compile error, not a runtime case. Whole-
  form `getValue()` returns `Readonly<Ref<WithIndexedUndefined<Form>>>`
  (every unbounded array's elements get `| undefined`). Migration:
  consumers narrow at array-crossing paths with `?.` / `??` or a
  conditional check; non-crossing paths are unchanged.
- **Breaking — `PersistConfig.version` is gone.** The schema's
  `fingerprint()` is the canonical "shape changed" signal — passing
  a manual version is redundant and decoupled from the actual
  schema state. Storage keys now resolve to
  `${base}:${fingerprint}` automatically; a schema change produces
  a different fingerprint, the old key becomes orphaned, and the
  next mount's `listKeys`-driven cleanup pass wipes it. Migration:
  delete the `version: N` line from your `persist:` config; the
  typechecker flags it. The cx-internal envelope version (the `v`
  field on serialized payloads) stays as an internal storage-format
  invariant — bumped only when cx itself changes the on-disk shape,
  never by consumers.
- **Breaking — `AbstractSchema` parameter rename: `getInitialState`
  → `getDefaultValues`** has already shipped (0.11.0); the new
  break is `getDefaultAtPath`'s required-method status. The
  five-method contract is now: `fingerprint`, `getDefaultValues`,
  `getDefaultAtPath`, `getSchemasAtPath`, `validateAtPath`.
- **New — structural-completeness invariant on every `setValue`.**
  After every `setValue` write, the form is guaranteed to satisfy
  the slim schema (objects/arrays/primitives without refines).
  Three concrete consequences:
  - Sparse array writes (`setValue('posts.21', cb)` against an
    empty array) auto-pad indices `0..20` with the schema's
    element default. The runtime walks the path, fills missing
    intermediates from `getDefaultAtPath`, and writes the value at
    the leaf.
  - Partial value-form writes (`setValue('user', { name: 'X' })`
    when the schema requires `{ name, age, email }`) get
    structurally completed via `mergeStructural` against the
    schema's default — sibling keys appear with their schema-
    prescribed defaults. Consumer-only keys (validation flags,
    metadata) are preserved.
  - Path-form callback writes (`setValue('user', prev => ({ ...prev,
    name: 'X' }))`) now receive a strict, fully-defaulted `prev` —
    even when the slot was previously empty. The callback no
    longer needs `prev?.name ?? ''` defensive reads.
  Performance: the fast path (writes to existing slots) skips the
  schema entirely. Schema lookups fire only when a write actually
  hits a structural gap, with element-default caching to keep
  sparse-array padding O(N) instead of O(N×schema-traversal).
- **New — fingerprint-keyed persistence + active orphan cleanup.**
  Storage keys are now `${base}:${fingerprint}` automatically —
  changing the schema produces a different fingerprint, the old
  key becomes unreachable, and on the next mount the new
  `listKeys`-driven cleanup pass removes the orphaned entry. No
  manual `version` bumps, no stale drafts accumulating across
  redeploys. Cleanup uses exact-or-`:`-prefix match scoped to
  `${PERSISTENCE_KEY_PREFIX}${formKey}` (or the consumer's custom
  `key`) — sibling forms with overlapping prefixes (e.g.
  `'my-form'` vs `'my-form-2'`) don't collide. Cross-store
  cleanup on the non-configured standard backends extends to
  orphan-key sweeping symmetrically.
- **New — `WithIndexedUndefined<T>`, `NestedReadType<F, P>`, and
  `IsTuple<T>` type transforms** are exported from
  `attaform`. `WithIndexedUndefined` taints every
  unbounded array's element type with `| undefined`; tuples,
  `Date`, `RegExp`, `Map`, `Set`, and functions pass through
  untouched. `NestedReadType` walks a `FlatPath` and tracks
  whether a numeric segment was crossed — once tainted, all
  subsequent results are `T | undefined`. Use these directly when
  building wrappers / utility types around the form API.
- **New — `SetValuePayload<Write, Read = Write>` is parameterised**
  to support honest read-vs-write shape distinction in callbacks.
  `Write` is what the callback returns / what direct writes
  accept; `Read` is what the callback's `prev` receives. The
  whole-form `setValue` parameterises `Read` to
  `WithIndexedUndefined<Form>` so consumer reads of `prev.posts[5]`
  are honest. The path-form parameterises `Read` to
  `NonNullable<NestedType<Form, Path>>` because the runtime
  auto-defaults missing slots before the callback fires.

## v0.11.1
**Dev-mode ergonomics for the ambient `useFormContext` warning.**

- **Lazy warning, not eager.** `useForm()` no longer prints the
  duplicate-ambient-provide warning at every call site. Components
  that intentionally pile multiple `useForm()` calls into one setup
  (spike pages, exercise harnesses) stay silent unless a descendant
  actually consumes the ambient slot. The warning fires once, at the
  consume site (`useFormContext<F>()` with no key), and lists each
  offending `useForm()` call by source frame for click-through in
  DevTools.
- **Keyed forms bypass the ambient slot.** `useForm({ schema, key })`
  no longer fills the ambient `provide`/`inject` slot — keyed forms
  are addressable explicitly via `useFormContext<F>(key)`, and the
  ambient slot is reserved for anonymous siblings. This cleanly
  separates the two resolution modes and stops keyed forms from
  silently winning the ambient slot over a sibling anonymous form.

  **Behaviour change** (technically a breaking dev-time semantic, no
  type-system surface change): a descendant of a keyed-only parent
  that calls `useFormContext<F>()` with no key now throws "no ambient
  form context" instead of resolving to the keyed form. The throw is
  the right error: the form has a name; address it.

## v0.11.0
**What's new at a glance**

- **`state` — the form-level reactive bundle.** Nine form-level
  scalars (`isDirty`, `isValid`, `isSubmitting`, `isValidating`,
  `submitCount`, `submitError`, `canUndo`, `canRedo`, `historySize`)
  previously lived as top-level `Readonly<ComputedRef<X>>` fields on
  `useForm()`'s return. They're now collated on a single `state`
  object (`reactive()` + `readonly()` under the hood). Templates
  bind to primitives directly — `:disabled="form.state.isSubmitting"`
  just works — and scripts read without `.value`.
- **`fieldErrors` is a Proxy view.** The ComputedRef wrapper is gone.
  Templates and scripts both dot-access through
  `form.fieldErrors.email` without `.value`. Still readonly (compile
  time via the type + runtime via Proxy traps that warn + reject).

**Breaking changes**

Three migrations since 0.10, all shaped by the same Vue template-
auto-unwrap limitation — refs nested inside API *objects* don't
unwrap, and our API was making consumers pay for it.

- **`fieldErrors.value` is gone.** Drop `.value` everywhere. Watchers
  must use the getter form: `watch(() => api.fieldErrors.email, …)`
  rather than `watch(api.fieldErrors, …)`.
- **9 top-level scalars moved to `state`.**

  ```diff
  - form.isDirty.value
  - form.isSubmitting.value
  - form.canUndo.value
  + form.state.isDirty
  + form.state.isSubmitting
  + form.state.canUndo
  ```

  …for all 9 fields listed above. `undo()` and `redo()` stay at the
  top level — they're methods, not state.
- **Internal `FormState` type renamed to `FormStore`.** The name was
  freed for the new public `FormState` interface (the shape of
  `useForm().state`). Only breaks consumers who imported the
  internal type directly — unlikely but possible.
- **`initialState` config key renamed to `defaultValues`.** Same
  motivation: with `state` reserved for the form-level flag bundle,
  `useForm({ initialState: {…} })` read ambiguously. The new name
  matches RHF's vocabulary. Custom-adapter authors also need to
  rename `AbstractSchema.getInitialState` → `getDefaultValues` (and
  the matching `InitialStateResponse` / `GetInitialStateConfig`
  types). The `runtime/adapters/zod-v4/initial-state` module file
  is now `default-values`.

See [`docs/migration/0.10-to-0.11.md`](docs/migration/0.10-to-0.11.md)
for a full migration snippet with `sed` one-liners covering all four
breakages.

## v0.10.0
_No unreleased changes yet._

## v0.9.0
_No unreleased changes yet._

## v0.8.3
_No unreleased changes yet._

## v0.8.2
_No unreleased changes yet._

## v0.8.1
_No unreleased changes yet._

## v0.8.0
**What's new at a glance**

- **Full rewrite of the core.** The pre-rewrite `useState` composables
  are collapsed into a single `FormState` closure per form. Registry-
  backed, framework-agnostic — works under Nuxt 3/4, bare Vue 3, and
  bare Vue 3 + `@vue/server-renderer`.
- **Zod v4 adapter** at `attaform/zod`. The v3 adapter stays
  at `attaform/zod-v3` for existing consumers; the two are
  physically isolated and pick the zod major the consumer installs.
- **Type-inference improvements.** `register` / `getValue` / `setValue`
  / `getFieldState` narrow down to the exact leaf type for any
  `FlatPath<Form>`. New `ArrayPath<Form>` / `ArrayItem<Form, Path>`
  helper types drive the typed array helpers.
- **New surface:** `isDirty`, `isValid`, `isSubmitting`, `submitCount`,
  `submitError`, `reset()`, `resetField(path)`, and the typed array
  helpers (`append` / `prepend` / `insert` / `remove` / `swap` /
  `move` / `replace`).
- **Memory-leak fix.** `FormState` is evicted from the registry on
  the last consumer's scope dispose — prevents accumulation in
  long-lived SPAs.
- **Performance.** The keystroke bench runs several times faster than
  the pre-rewrite baseline; `scripts/check-bench.mjs` fails CI if the
  ratio regresses.
- **CI gates:** bundle size (`size-limit`), coverage (v8 with per-
  metric thresholds), and bench regression all run on every PR across
  the Node matrix. Test-file and intra-file execution order shuffles
  on every run.
- **Tree-shaking.** `sideEffects: false` is declared — unused subpath
  imports drop out of consumer bundles.
- **Docs.** A new `docs/` tree covers the full public API, task-
  oriented recipes (dynamic field arrays, server errors, custom
  adapters, SSR hydration, advanced validation), and per-release
  migration notes.

**Breaking changes**

Two consumer-facing breakages since 0.6:

- `useForm` requires `key`. Compile error without it; runtime error
  if passed `undefined` / `null` / `''`. See
  [`docs/migration/0.7-to-0.8.md`](docs/migration/0.7-to-0.8.md).
- `handleSubmit(cb)` returns a handler function instead of running
  immediately. Bind it directly to `@submit.prevent` or call it
  imperatively. See
  [`docs/migration/0.6-to-0.7.md`](docs/migration/0.6-to-0.7.md).

**Out of scope for this release (future candidates)**

Async validators, a Valibot adapter to validate the
schema-agnostic claim, a bare-Vue playground, an auto-release
pipeline, the Vue DevTools plugin, and published comparison
benchmarks against FormKit / VeeValidate / react-hook-form.

---

## Compare

[compare changes](https://github.com/attaform/attaform/compare/v0.5.0...HEAD)

### 🚀 Enhancements

- Reactive field-error store + setFieldErrorsFromApi helper ([#107](https://github.com/attaform/attaform/pull/107))
- ⚠️  HandleSubmit returns a submit handler instead of running immediately ([#108](https://github.com/attaform/attaform/pull/108))
- Phase 0 — max TS strictness, canonical paths, SSR primitives, typed errors ([6157a26](https://github.com/attaform/attaform/commit/6157a26))
- Phase 1a — diff-apply walker + keystroke benchmark (7.6x-10.6x faster) ([16a0193](https://github.com/attaform/attaform/commit/16a0193))
- Phase 1b.1 — structured-path get/set primitives ([1fcd2a8](https://github.com/attaform/attaform/commit/1fcd2a8))
- Phase 1b.2 — hydrate-api-errors with structured result shape ([8e89513](https://github.com/attaform/attaform/commit/8e89513))
- Phase 1b.3 — createFormState, the single per-form closure ([872471d](https://github.com/attaform/attaform/commit/872471d))
- Phase 1b.4 — API factories for register, field-state, process-form ([79458f1](https://github.com/attaform/attaform/commit/79458f1))
- Phase 2.1 — registry, plugin factory, serialization, directive move ([8c45fb0](https://github.com/attaform/attaform/commit/8c45fb0))
- Phase 2.2 — wire use-abstract-form to createFormState + registry ([204440a](https://github.com/attaform/attaform/commit/204440a))
- Phase 3 — AST + directive hardening (substring match, file input, shim, cleanup) ([d9f5185](https://github.com/attaform/attaform/commit/d9f5185))
- Phase 4a — packaging restructure, multi-entry build, new subpaths ([6c8ef1d](https://github.com/attaform/attaform/commit/6c8ef1d))
- Phase 4a + 4b — multi-entry build, dual zod v3/v4 adapters ([492577a](https://github.com/attaform/attaform/commit/492577a))
- Phase 5 — bare-Vue SSR end-to-end test (@vue/server-renderer) ([c8a4471](https://github.com/attaform/attaform/commit/c8a4471))
- ⚠️  Phase 7.2 — require explicit `key` at the type level ([584239e](https://github.com/attaform/attaform/commit/584239e))
- Phase 7.6 — v4 adapter parity with v3 (validate-then-fix, DU, strip) ([acdb63d](https://github.com/attaform/attaform/commit/acdb63d))
- Phase 8.2 — form-level isDirty and isValid computed aggregates ([0633b6d](https://github.com/attaform/attaform/commit/0633b6d))
- Phase 8.3 — expose isSubmitting/submitCount/submitError from handleSubmit ([d0fed7f](https://github.com/attaform/attaform/commit/d0fed7f))
- Phase 8.4 — reset() and resetField(path) restore form state ([48de785](https://github.com/attaform/attaform/commit/48de785))
- Phase 8.5 — typed array helpers (append/remove/swap/move/...) + recipe ([3de1298](https://github.com/attaform/attaform/commit/3de1298))

### 🔥 Performance

- Flag the package as `sideEffects: false` for tree-shaking ([3636b19](https://github.com/attaform/attaform/commit/3636b19))

### 🩹 Fixes

- **exports:** Drop null values and fix missing .js extension ([#106](https://github.com/attaform/attaform/pull/106))
- Phase 8.1 — release FormState from the registry on scope dispose ([8fc9436](https://github.com/attaform/attaform/commit/8fc9436))

### 💅 Refactors

- Phase 2.3 — delete pre-rewrite composables, utils, and directive plugins ([7fa8479](https://github.com/attaform/attaform/commit/7fa8479))
- Phase 7.1 — remove dead surface ([d049fd7](https://github.com/attaform/attaform/commit/d049fd7))
- Phase 7.4 — tighten ESLint exemptions to zero disables ([e7c9248](https://github.com/attaform/attaform/commit/e7c9248))
- Phase 7.5 — rewrite-zod-aliases script → rollup-plugin-alias ([56261af](https://github.com/attaform/attaform/commit/56261af))

### 📖 Documentation

- Surface reactive field-errors API in Features list ([#111](https://github.com/attaform/attaform/pull/111))
- Phase 6 — README rewrite for the multi-target shape ([4bd4611](https://github.com/attaform/attaform/commit/4bd4611))
- Phase 8.7 — API reference, recipes, and migration notes ([864a32d](https://github.com/attaform/attaform/commit/864a32d))

### 📦 Build

- Silence the last two unbuild warnings (zod-v3, @nuxt/schema) ([d319f1c](https://github.com/attaform/attaform/commit/d319f1c))

### 🏡 Chore

- **dev:** Dist-rebuild watcher for consumer-side iteration via pnpm link ([#109](https://github.com/attaform/attaform/pull/109))
- Phase 7.7 — CI gates for bundle size, coverage, bench regression ([16088de](https://github.com/attaform/attaform/commit/16088de))
- Phase 7.3 — playground migrated to /zod subpath ([d273d36](https://github.com/attaform/attaform/commit/d273d36))
- Silence npm warnings in husky hooks via `pnpm exec` ([3c2b900](https://github.com/attaform/attaform/commit/3c2b900))

### ✅ Tests

- Phase 7.8 — Vite plugin resolution + transforms registration coverage ([42dc662](https://github.com/attaform/attaform/commit/42dc662))
- Phase 7.9 — Nuxt SSR payload round-trip for server-written values ([2b61e56](https://github.com/attaform/attaform/commit/2b61e56))
- Phase 7.10 — property-based tests for diff-apply, paths, api-errors ([cee5b1b](https://github.com/attaform/attaform/commit/cee5b1b))
- **packaging:** Skip exports checks when dist contains Nuxt stubs ([698209e](https://github.com/attaform/attaform/commit/698209e))
- Add type-inference tests; fix register generic; shuffle tests in CI ([d980198](https://github.com/attaform/attaform/commit/d980198))

### 🤖 CI

- Sign publish-workflow version-bump commits with GPG ([#110](https://github.com/attaform/attaform/pull/110))
- Phase 8.6 — run full pnpm check on every PR across the Node matrix ([200fe46](https://github.com/attaform/attaform/commit/200fe46))

#### ⚠️ Breaking Changes

- ⚠️  HandleSubmit returns a submit handler instead of running immediately ([#108](https://github.com/attaform/attaform/pull/108))
- ⚠️  Phase 7.2 — require explicit `key` at the type level ([584239e](https://github.com/attaform/attaform/commit/584239e))

### ❤️ Contributors

- Oswald Chisala <ozzy@cubicforms.com>

