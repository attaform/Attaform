# P2: directive un-weld

Delivers: -5,900 B gz (6,255 measured twice: baseline 46,477 -> 40,222 by removing
plugin.ts's vRegister import; credited 5,900 net of the ~350 dev-strip overlap once
P1 lands). The single largest lever. Spike-first: the delivery mechanism is NEW
machinery, not an existing Vue pattern (compiler helpers can only import from 'vue').
Re-verify with `reference/scripts/verify-unweld.mjs` before and after.

Fresh anchor (2026-08-23, post-P1a): eager is 43,741 B gz with the ratchet and
attribution.mjs now measuring through the package build's source-level `__DEV__`
strip. Align verify-unweld.mjs the same way (copy the stripPlugin from
attribution.mjs) BEFORE re-measuring the un-weld delta, or the before/after pair
mixes methodologies. Expected landing ~37,800; P1b's further ~950 is independent
and still pending its docs pages, so P2 may run first — the dedup guards in
00-program.md already keep the two claims separate.

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

## Spikes (do first, timebox, write results into this file)

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
