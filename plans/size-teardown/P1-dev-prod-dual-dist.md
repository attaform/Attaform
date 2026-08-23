# P1: dev/prod dual dist + error codes

Delivers: -3,500 B gz eager (2,551 measured strip + ~950 prose-to-codes measured +
~100-150 unguarded-warn gating, counted once per the dedup guards). Fixes the defect:
~2.5 kB (esbuild) to ~3.5-4.4 kB (Vite-class) of dev code shipping in prod today.
Split into P1a (no external dependency) and P1b (needs attaform.dev/e/\* pages live).

## P1a: pre-stripped dual dist

1. Build: two-pass unbuild (programmatic `build()` twice) or a single config with two
   entry sets: prod flavor with `__DEV__` replaced by `false` at package build (esbuild
   `define` on `src/runtime/core/dev.ts`'s export, or an inline replace plugin), dev
   flavor with `true`. Layout: `dist/prod/*` + `dist/dev/*` (or `*.dev.mjs` twins;
   pick at execution, prod flavor keeps today's paths so tooling that bypasses the
   exports map degrades to prod, the safe direction).
2. exports map: every runtime entry gains a `development` condition resolving the dev
   flavor; `default`/`import` resolve prod. Order inside each entry: `types`,
   `development`, `import`. Node-only entries (nuxt, vite, bundler plugins) are
   dev-tooling and can stay single-flavor.
3. Nuxt runtime plugin flavor hazard (verifier condition): `src/nuxt.ts` registers
   `dist/runtime/plugins/attaform.mjs` by LITERAL PATH via
   `addPlugin({ src: resolver.resolve(...) })`. A literal prod path + app imports
   resolving dev = two module graphs = two registries. Fix: resolve the flavored path
   from `nuxt.options.dev`, or re-point the plugin to import through the bare
   specifier so the bundler's condition resolution picks the flavor. Add a test that
   boots the nuxt fixture in dev and asserts a single registry instance.
4. Re-point measurement + tests at the SHIPPED prod flavor:
   - `scripts/check-eager-size.mjs`: apply the same `__DEV__ -> false` replacement the
     package build uses (source-level strip in the esbuild config), so the ratchet
     equals shipped bytes. Record the re-point in the budget comment.
   - `test/packaging/dev-dce.test.ts`: replace the single-string assert with
     structural gates on the prod flavor: no `if(!1)`, no `!1&&`, no
     `dev-stack-trace` module in the eager input set, `[attaform]` prose only from an
     explicit allowlist (the ~13 legitimately-prod strings the verifier catalogued).
   - CI grep gate on dist/prod: no `process.env.NODE_ENV`, no `typeof process` (CDN
     safety), no `__DEV__` identifier remaining.
5. Tarball: dev flavor adds ~+130 kB packed; raise the P0 tarball budget to ~500 kB
   with a recorded reason.
6. Known acceptable degradations (document, do not fight): bundlers that ignore the
   `development` condition serve prod in dev (diagnostics silently absent, same as
   today's CDN path); Node SSR without conditions resolves prod (diagnostics-only
   loss; Nitro pushes development/production correctly for Nuxt).

Verifier note kept for the record: a cheaper competing design exists (per-call-site
NODE_ENV expression inlining, Vue's esm-bundler pattern) that fixes Vite/webpack leak
without dual dist but keeps prod prose in the dev-condition-less case; dual dist was
chosen because it also carries P1b (prose lives only in the dev flavor). If dual-dist
integration turns painful at execution, that fallback is pre-approved to reconsider.

## P1b: error codes + prose diet (needs docs pages live first)

1. Assign AF## codes to the intentional throws + invariants (~2.25 kB of >=32 B prose
   catalogued by the dev-and-strings analyst: introspect not-a-schema, registry
   errors, InvalidUseFormConfigError, hydration invariants, etc.).
2. Prod message shape: `[attaform] AF## attaform.dev/e/AF##`; dev flavor keeps full
   prose. Error CLASSES and `atta:` public codes are API; message text documented as
   non-API.
3. Gate the genuinely unguarded warn sites found: directive.ts:545/573 checkbox
   prose (Vue `warn` is not a prod noop in all builds), plus the audit's grep list.
4. Docs: one page per code under attaform.dev/e/ (generated stub per code is fine to
   start); nuxt-link-checker keeps them from rotting.

## Acceptance

- Ratchet (now prod-flavor) drops ~2.5 kB in P1a, ~1.0 kB more in P1b.
- A Vite consumer fixture built in prod mode contains zero `[attaform]` dev prose
  outside the allowlist; built in dev mode shows full diagnostics.
- Nuxt fixture: one registry instance in dev and prod; devtools panel still works.
- Full `pnpm check` green both majors; budgets tightened with recorded reasons.
