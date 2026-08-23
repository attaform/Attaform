# P2: directive un-weld

Status: DONE 2026-08-23. Measured: eager 43,741 -> 37,210 B gz (-6,531: 5,702
from the un-weld flip exactly as verify-unweld predicted, plus 829 from the
store DOM-slice extraction, beating the plan's ~5,900). Budget 44_250 ->
37_700; 12 size-limit caps tightened (createAttaform's treeshaken import
collapsed 8 KB cap -> 1.5 KB, measured 0.79 KB — that import WAS the weld) +
a new `attaform/directive` entry cap (8 KB, measured 7.17). Tarball 380.1 kB
/ 83 files under the unchanged 450k budget. Full suite green both majors;
`pnpm check` chain green end to end. Execution findings at the bottom.

Delivers: -5,900 B gz (6,255 measured twice: baseline 46,477 -> 40,222 by removing
plugin.ts's vRegister import; credited 5,900 net of the ~350 dev-strip overlap once
P1 lands). The single largest lever. Spike-first: the delivery mechanism is NEW
machinery, not an existing Vue pattern (compiler helpers can only import from 'vue').
Re-verify with `reference/scripts/verify-unweld.mjs` before and after.

Fresh anchor (2026-08-23, post-P1a): eager is 43,741 B gz with the ratchet and
attribution.mjs now measuring through the package build's source-level `__DEV__`
strip. verify-unweld.mjs ALIGNED 2026-08-23 (stripPlugin on every src module,
stub applies the strip itself since esbuild gives the load to the first
responding plugin): baseline reproduces the ratchet exactly (43,741) and the
un-weld delta re-measures at 5,702 B gz -> expected landing 38,039. The
pre-strip 6,255 claim carried ~550 of dev-flavor bytes P1a already banked.
Removed set confirmed: directive, directive-{aria,file,listeners,lifecycle,
value-sync}, register-protocol, assigner-pipeline, vue-shared-shim; store and
register-api stay eager. P1b's further ~950 is independent and still pending
its docs pages, so P2 may run first — the dedup guards in 00-program.md
already keep the two claims separate.

## Accepted end state (sign-off 1)

- `ensureAttaformInstalled` / `createAttaform()` register NO directive and NO stub.
- New `attaform/directive` entry: `vRegister`, `vRegisterFile`, `installVRegister(app)`.
- Build-plugin users (vite/nuxt): transforms inject component-local registration so
  templates keep writing `v-register` with zero setup.
- Everyone else (webpack-family, no-build, CDN, runtime-compiled templates):
  documented one-liner `installVRegister(app)`. Miss signal: Vue's own dev warning
  "Failed to resolve directive: register".
- SSR: server build eagerly imports + registers the real directive (server bytes are
  free) so `getSSRProps` stays synchronous.
- The store's DOM slice (elements/hostTargets/sort cache/focus resolution/mark\*
  wiring) moves into the register/directive feature; kernel keeps fields records only.
  This is the public RegisterValue reshape covered by sign-offs 1 and 6.

## Spike results (2026-08-23)

- Spike A, RESOLVED — mechanism (2) wins, and it is one stable pattern.
  Compiled every authoring style (script setup, options API, template-only)
  x dev/prod x client/SSR through @vue/compiler-sfc exactly as
  @vitejs/plugin-vue drives it: every non-local-binding case emits the
  identical line `const _directive_register = _resolveDirective("register")`
  (helper alias and double quotes are compiler-core constants), and the
  script-setup local-binding case (`import { vRegister } ...` in scope) emits
  NO resolveDirective at all, so a rewrite naturally defers to a user's own
  import. Mechanism (1) (inject a `directives` option) was rejected: locating
  the options object is plugin-vue-shape-coupled (inline vs split, \_sfc_main
  naming) while (2) targets the exact call, covers the SSR-compiled path in
  the same stroke (`ssrGetDirectiveProps(_ctx, _directive_register, ...)`),
  and is HMR-safe (plugin-vue re-emits fresh compiler output per update, the
  post-transform re-runs). Mechanism (3) (module-slot arming) stays rejected:
  code-split apps can install before the arming chunk loads. Delivery: the
  rewrite replaces the call with a same-length space-padded local identifier
  and appends the `attaform/directive` import at EOF (ESM hoists it), so
  existing line/column positions survive and no magic-string dependency is
  needed. It runs as a second `enforce: 'post'` plugin returned from
  `attaform()` (return type becomes Plugin[]; Vite flattens nested plugin
  arrays, and the nuxt module forwards through the same addVitePlugin call).
  Known semantic narrowing, documented: in vite/nuxt builds a template's
  v-register binds statically to attaform's directive; a component-local
  `directives: { register: ... }` shadow no longer intercepts it.
- Spike B, RESOLVED — parity is structural. Both SSR paths receive the SAME
  directive object: the compiled path via the rewritten import (synchronous
  getSSRProps, no app registration involved), the runtime vnode path via the
  directive object placed in withDirectives. The #378 matrix harness keeps
  covering divergence; its apps switch from createAttaform-welded delivery
  to `installVRegister` (the honest runtime-compiled-template story). The
  rewrite itself is covered by unit tests against real compiler-sfc module
  output plus the live vite pipeline (nuxt e2e fixture + apps/site).
- Spike C, RESOLVED — seam is a lazily-armed DOM binding, public surface
  unchanged. `rv.registerElement` STAYS on RegisterValue (the register
  protocol's polymorphic member; hand-rolled RVs and the duck-check depend on
  it). The store's DOM slice (elements / hostTargets / elementToFormInstance
  / sorted-registrations cache / registerElement / deregisterElement /
  markHostConnected / getFirstErrorElement / resolveHostFocusTarget +
  register-api's focus-listener pair and the INTERACTIVE_TAG_NAMES gate)
  moves to a new `dom-binding` module in the lazy cluster. The kernel keeps
  field records plus two narrow internal transitions (noteDomConnected /
  noteDomDisconnected, shared with the SSR-only markConnectedOptimistically
  which stays kernel for first-paint `connected`) and a
  `domBinding: ShallowRef<DomBinding | null>` slot. Arming is explicit
  dependency injection: the directive / useRegister (both in or adjacent to
  the lazy cluster) pass `createDomBinding` into an @internal
  `rv.ensureDomBinding(factory)` before element calls — package.json has
  `"sideEffects": false`, so import-time slot arming would be tree-shaken;
  DI also survives duplicate-package-copy apps. Eager readers go through the
  slot: field-state's `element`/`elements`, process-form + form
  focusFirstError/scrollToFirstError (`domBinding.value?.getFirstErrorElement
?? null`). Confirmed degradation for "register() bindings but no directive
  and no useRegister anywhere": the slot stays null, element registration and
  invalid-submit focus no-op without a crash — truthful absence, since
  nothing could have registered elements in that world anyway; a dev-flavor
  warn names the fix. Consumer inventory verified: no devtools / serialize
  readers of store.elements; the only eager readers are the four above.
- Flip blast radius measured: 65 test files use v-register and rely on the
  welded registration (45 via createAttaform directly, the rest via lazy
  install or harnesses). Strategy: @vue/test-utils global directive
  registration in test/setup.ts + installVRegister in form-harness and the
  ssr-cross-path harness; per-file mounts fixed as surfaced. The in-browser
  REPL (runtime-compiled, no vite plugin) must call installVRegister in its
  bootstrap — DemoReplEditor.client.vue.

## Spikes (original brief, kept for the record)

- Spike A, client delivery: vite/nuxt transform emits component-local registration
  for components whose templates use v-register. Candidate mechanisms, in preference
  order: (1) inject `directives: { register: _vRegister }` into the compiled component
  options + a module-scope import; (2) rewrite compiled `resolveDirective("register")`
  calls to the imported symbol; (3) transform-injected side-effect import arming a
  module-slot the un-welded runtime reads. Must work for `<script setup>` SFCs, plain
  SFCs, and survive HMR.
- Spike B, SSR compile parity: `@vue/compiler-ssr` emits
  `ssrGetDirectiveProps(_ctx, resolveDirective("register"))` for component hosts and
  the transforms handle native hosts; verify BOTH SSR paths with the #378 cross-path
  parity matrix extended to the new delivery. Known traps from #381/#404: getSSRProps
  fires twice for component-host directives; SSR_COMPONENT_HOST_MODIFIER marking.
- Spike C, store DOM slice seam: confirm process-form's invalid-submit focus works
  when only register() bindings exist (no directive), and that
  `markConnectedOptimistically` stays synchronous for first-paint `field.connected`.

## Implementation order

1. Land `attaform/directive` entry re-exporting today's directive (no behavior change).
2. Transforms: injection mechanism from Spike A + SSR parity from Spike B, behind the
   existing vite/nuxt plugins. apps/site is the live testbed (it uses v-register
   everywhere).
3. Flip: remove the vRegister import from plugin.ts; add `installVRegister`; update
   the webpack-family plugin docblocks + docs install recipes (they already state
   vite transforms "do not transfer").
4. Move the DOM slice out of the store (register feature owns element registration,
   host anchors, focus-target resolution; ~400-690 B additional, verifier-adjusted).
5. Extend the SSR parity matrix + e2e: a no-plugin fixture using installVRegister,
   and a directive-less fixture asserting the cluster is absent from its bundle.

## Acceptance

- Ratchet: ~-5.9 kB on the minimal scenario. verify-unweld.mjs confirms the module
  set: directive\*, register-protocol, vue-shared-shim gone; register-api still eager.
- apps/site fully green (SSR + hydration + focus-first-error + file inputs + no-latch
  hosts) on both majors; #378 matrix green on both SSR paths.
- Docs: install page updated (plugin users: nothing; others: one line).

## P2 execution findings beyond the spikes (2026-08-23)

- Delivery landed as designed: `attaform()` returns `[main, delivery]`
  (`Plugin[]`; Vite flattens, `@nuxt/kit`'s addVitePlugin spreads arrays).
  The delivery post-plugin applies `rewriteDirectiveDelivery` from
  `runtime/lib/core/transforms/directive-delivery-transform.ts` — kept
  INTERNAL, not exported from `attaform/transforms`, to avoid widening
  the tooling surface before someone actually needs it outside Vite.
- The DI arming (Spike C) held: `rv.ensureDomBinding(factory)` is an
  optional @internal RegisterValue member; arming sites are
  vRegisterDynamic.created + beforeUpdate, vRegisterFile.created, and
  useRegister's two capture paths. dev-dce gained S4: the eleven
  un-welded modules (directive + 5 satellites, register-protocol,
  assigner-pipeline, vue-shared-shim, dom-binding, interactive-tags)
  asserted OFF the minimal eager inputs — the structural re-weld guard
  the byte ratchet alone can't give.
- Kernel additions: `noteDomConnected` / `noteDomDisconnected` (the
  field-record transitions; markConnectedOptimistically now routes its
  SSR lift through the former), and `domBinding: ShallowRef` so
  field-state's `element`/`elements` re-track when the binding arms.
  `deregisterElement`'s remaining-count return died with the move
  (nothing consumed it); array-bookkeeping's `elements` dep turned out
  DEAD (declared, never destructured) and was removed.
- Vitest now runs the PRODUCTION delivery: both vitest configs register
  the same post-plugin `attaform/vite` ships, so the ~65 docs-demo SFCs
  exercise the rewrite on every suite run. Template-STRING harnesses
  (runtime-compiled) use `installVRegister` — the honest no-build story.
- Silent-degradation trap found and closed: the #378 cross-path harness
  spies console.warn, so its compiled path kept passing while rendering
  with NO directive (the nodeTransforms carry value/checked/selected).
  The harness now installs the directive AND asserts zero
  `Failed to resolve directive` warnings — a delivery guard that fails
  loudly instead of degrading the matrix silently.
- Public-surface outcome, for the record: NOTHING was removed.
  RegisterValue keeps registerElement/deregisterElement (the register
  protocol's polymorphic members; hand-rolled RVs unaffected). The one
  new degradation: a custom integration calling `rv.registerElement`
  with neither the directive cluster nor useRegister loaded anywhere
  no-ops (dev-flavor warn names the fix). FLAG for Oswald: if
  manual-rv integrations without useRegister turn out to matter, a
  public arming surface is a ~20-line follow-up; until then useRegister
  is the documented manual path.
- installVRegister semantics: idempotent, and a consumer's own
  app-level `register` directive registered first is left in place.
- The rewrite skips `/node_modules/`: a third-party package's own
  `register` directive is never captured. A component library that
  wants Attaform's directive without depending on the host app's
  plugin binds it locally (`import { vRegister } from
'attaform/directive'` in `<script setup>` — the compiler then emits
  no resolveDirective at all). Known narrowing, documented in the
  transform docblock: inside the Vite pipeline v-register binds
  statically, so a component-local `directives: { register }` shadow
  no longer intercepts it.
- The REPL (in-browser compiler, no bundler plugin) registers the
  directive via `app.directive('register', vRegister)` off the BARREL
  import — installVRegister lives only on `attaform/directive`, which
  is not in the REPL's import-map bundle set, and vRegister already
  rides the barrel. Invisible plumbing; docs teach installVRegister.
- Plan step 5's fixtures landed as equivalents: the no-plugin
  installVRegister fixture IS the updated #378 harness (runtime-
  compiled path, both SSR paths, both majors); cluster-absence is
  dev-dce S4 (source-level, stronger than a bundle grep); and the
  dist-flavor e2e fixture gained a v-register probe that proves the
  injected `attaform/directive` import resolves through the REAL
  exports map (dev flavor via the development condition) with SSR
  value emission — a missing export would 500 the fetch.
- Docs: installation restructured (Nuxt module / Vite plugin sections
  now carry the delivery; new "No build plugin?" one-liner section),
  v-register page's "Auto-installed" became "Delivered at compile
  time", entry-points gained the `attaform/directive` section (15
  entries), webpack-family docblocks carry the one-liner.
- Aliases for the injected import: vitest.config, vitest.nuxt-ui.config,
  apps/site nuxt.config (both blocks), test/fixtures/ssr. The
  auto-imports fixture needs none (no v-register in its app files).
- Deviation from the spike's test-strategy sketch: no VTU global config
  and no form-harness change were needed. The vitest delivery plugin
  covered every SFC-based suite, and the harnesses that register
  elements manually (focus-scroll, wizard-handle-submit,
  v-register-component-host, register-api) arm explicitly via
  `armDomBinding` — which doubles as in-repo documentation of the
  arming contract.
