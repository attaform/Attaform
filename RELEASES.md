# Releases

## v0.21.1 — 2026-06-05

## What's Changed
* ci(codeql): emit single-language check name to match required context by @ozzyfromspace in https://github.com/attaform/Attaform/pull/352
* chore(deps-dev): bump the dev-dependencies group across 1 directory with 6 updates by @dependabot[bot] in https://github.com/attaform/Attaform/pull/351
* fix: docs-site demo bugs + v-register external-update reactivity by @ozzyfromspace in https://github.com/attaform/Attaform/pull/362
* fix(playground): grant the @vue/repl preview iframe allow-downloads by @ozzyfromspace in https://github.com/attaform/Attaform/pull/363
* fix(zod): keep the unified entry's v3 read shape from collapsing to never by @ozzyfromspace in https://github.com/attaform/Attaform/pull/353
* feat(wizard): push step history so browser Back/Forward walk the flow by @ozzyfromspace in https://github.com/attaform/Attaform/pull/354
* fix(submit): handleSubmit records a rejecting callback on submitError instead of re-throwing by @ozzyfromspace in https://github.com/attaform/Attaform/pull/355
* fix(wizard): handleSubmit records a rejecting callback on submitError (parity with form) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/356
* fix(submit): clear user-set errors at handleSubmit entry by @ozzyfromspace in https://github.com/attaform/Attaform/pull/357
* fix(wizard): clear processed forms' user-set errors at handleSubmit entry by @ozzyfromspace in https://github.com/attaform/Attaform/pull/358
* refactor(api): rename form.process() to form.parse() by @ozzyfromspace in https://github.com/attaform/Attaform/pull/359
* refactor(proxy): non-callable surface nodes + prototype-shadowed-key safety by @ozzyfromspace in https://github.com/attaform/Attaform/pull/360
* feat(transforms): async register transforms + file-pipeline unification by @ozzyfromspace in https://github.com/attaform/Attaform/pull/361
* docs(transforms): async register transforms + file-upload demo by @ozzyfromspace in https://github.com/attaform/Attaform/pull/364
* refactor(surface): truthful absence on form.fields / form.errors / form.values (model P) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/365
* docs(changelog): capture unreleased changes since v0.21.0 by @ozzyfromspace in https://github.com/attaform/Attaform/pull/366


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.21.0...v0.21.1

---

## v0.21.0 — 2026-06-02

## What's Changed
* perf(bundle): strip dev-only code from prod builds + add eager-byte gate by @ozzyfromspace in https://github.com/attaform/Attaform/pull/340
* perf(bundle): drop the lodash-es peer dependency by @ozzyfromspace in https://github.com/attaform/Attaform/pull/341
* perf(bundle): adapter shared-core, lazy optional features, cross-bundler plugins by @ozzyfromspace in https://github.com/attaform/Attaform/pull/342
* feat: anti-flash validation display timing (timed getDisplayState) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/343
* docs(changelog): capture unreleased changes since v0.20.2 by @ozzyfromspace in https://github.com/attaform/Attaform/pull/344
* docs(demos): give every faux submit button toast feedback by @ozzyfromspace in https://github.com/attaform/Attaform/pull/347
* feat(validation): form.meta reads pending while a submit validates by @ozzyfromspace in https://github.com/attaform/Attaform/pull/349


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.20.2...v0.21.0

---

## v0.20.2 — 2026-05-31

## What's Changed
* ci(release): pr-driven publish workflow with idempotent recovery by @ozzyfromspace in https://github.com/attaform/Attaform/pull/318
* fix(release): bootstrap the release-pr label on every dispatch by @ozzyfromspace in https://github.com/attaform/Attaform/pull/319
* feat(release): adopt an existing release branch via tree-hash byte-match by @ozzyfromspace in https://github.com/attaform/Attaform/pull/320
* fix(release): sign the bump commit via createCommitOnBranch by @ozzyfromspace in https://github.com/attaform/Attaform/pull/322
* fix(release): auto-delete orphan release branches on dispatch by @ozzyfromspace in https://github.com/attaform/Attaform/pull/324
* fix(release): open release PR with a per-repo GitHub App, not GITHUB_TOKEN by @ozzyfromspace in https://github.com/attaform/Attaform/pull/325
* fix(release): differentiate 404 from real branch existence in classify step by @ozzyfromspace in https://github.com/attaform/Attaform/pull/326
* chore(release): v0.20.1 by @attaform-release[bot] in https://github.com/attaform/Attaform/pull/327
* fix(release): migrate App auth from deprecated app-id to client-id by @ozzyfromspace in https://github.com/attaform/Attaform/pull/328
* fix(directive): unify consumer assigner fire-time contract by @ozzyfromspace in https://github.com/attaform/Attaform/pull/329
* test(docs-demos): smoke harness for documented gestures by @ozzyfromspace in https://github.com/attaform/Attaform/pull/330
* test(perf): cut test-suite execution time by ~27% by @ozzyfromspace in https://github.com/attaform/Attaform/pull/331
* fix(directive): close three stale-closure sites by @ozzyfromspace in https://github.com/attaform/Attaform/pull/332
* fix(persistence): auto-attach per-element meta inside RegisterValue by @ozzyfromspace in https://github.com/attaform/Attaform/pull/333
* docs(persistence): describe rv-side persist-meta auto-attach by @ozzyfromspace in https://github.com/attaform/Attaform/pull/334
* test(docs-demos): backfill Phase 2 smoke entries by @ozzyfromspace in https://github.com/attaform/Attaform/pull/335
* docs: close out the brand-voice sweep with two micro-touches by @ozzyfromspace in https://github.com/attaform/Attaform/pull/336
* docs(changelog): draft Unreleased section covering #329-#336 by @ozzyfromspace in https://github.com/attaform/Attaform/pull/337
* ci(release): signal bump type in commit headline + publish run-name by @ozzyfromspace in https://github.com/attaform/Attaform/pull/338

## New Contributors
* @attaform-release[bot] made their first contribution in https://github.com/attaform/Attaform/pull/327

**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.20.1...v0.20.2

---

## v0.20.1 — 2026-05-30

**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.20.1...v0.20.1

---

## v0.20.0 — 2026-05-30

## What's Changed
* Phase 1: Security & honesty (SEC-1/2/3/4, SF1 guard, DEVTOOLS-1/2) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/288
* Phase 2: Dead-code & dead-type sweep by @ozzyfromspace in https://github.com/attaform/Attaform/pull/289
* Phase 3: Pure perf wins on the keystroke hot path (CORE-P1b + CORE-P2a) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/290
* Phase 4: Proxy consistency (PASS2-4/5/10/11/12) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/291
* fix: blank-mark & array-state correctness (Phase 5 — PASS2-1/6/7/8/9/S1) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/292
* Phase 6: Validation lifecycle (PASS2-2/3/S3/14 + CORE-P1a) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/293
* Phase 7: v3 introspect chokepoint (ADAPT-F1 / D18) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/294
* fix(zod-v3): unify path walker against introspect, retire walkV3ToLeafSchema (Phase 8 / D1 / D15 / D16 / R1) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/295
* fix(adapters): v3 per-method parity + symmetric SF6/D11 on v4 (Phase 9) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/296
* Phase 10: v3 validation contract — needsAsyncValidation + strict-mode seeding + validator-threw wrap by @ozzyfromspace in https://github.com/attaform/Attaform/pull/297
* Phase 11: v3 typed-config field-surface parity (SF2) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/298
* refactor(adapters): createAbstractSchema factory + D6/B3 dedup (Phase 12, part 1 of 2) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/299
* Phase 12 part 2: deriveDefault / slimPrimitives / walkPathSegments dedup (D2 / D3 / D5) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/300
* Phase 13: proxy factory + entry barrel dedup (CORE-P1c + ENTRY-1) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/301
* Phase 14: wizard decouple + dedup (COMP-W1-W5) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/302
* Phase 15: transform dedup + DIR-F4 SSR hydration fix (DIR-F1/F2/F4/F5/F6/F8/F9/F10/F11 + test/vite coverage gap) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/303
* refactor: type-walker dedup + naming (Phase 16 — TYPES-D2/D3/D4/D7) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/304
* Phase 17: structural extraction + PASS2-13 + PASS2-S2 (CORE-P3 / DIR-F7 / persistence-extract) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/305
* ci(security): add CodeQL SAST workflow by @ozzyfromspace in https://github.com/attaform/Attaform/pull/306
* fix(security): close CodeQL findings + pin Dockerfile by @ozzyfromspace in https://github.com/attaform/Attaform/pull/307
* fix(security): proto-less storage closes proto-pollution + sanitizes-not-blocks legit keys by @ozzyfromspace in https://github.com/attaform/Attaform/pull/308
* fix(security): proto-less storage sweep across the runtime by @ozzyfromspace in https://github.com/attaform/Attaform/pull/309
* chore(security): polish-pass proto-less containers across schema-driven walks by @ozzyfromspace in https://github.com/attaform/Attaform/pull/310
* ci(security): SLSA attestation + Packaging signal for Scorecard by @ozzyfromspace in https://github.com/attaform/Attaform/pull/311
* docs(scorecard): draft CII Best Practices Passing-level answers by @ozzyfromspace in https://github.com/attaform/Attaform/pull/312
* docs(changelog): draft Unreleased section covering #288-#312 by @ozzyfromspace in https://github.com/attaform/Attaform/pull/313


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.19.0...v0.20.0

---

## v0.19.0 — 2026-05-27

## What's Changed
* docs(readme): add OpenSSF Scorecard badge by @ozzyfromspace in https://github.com/attaform/Attaform/pull/276
* chore: align package.json description with the homepage + README by @ozzyfromspace in https://github.com/attaform/Attaform/pull/277
* refactor(validation)!: displayState replaces shouldShowErrors by @ozzyfromspace in https://github.com/attaform/Attaform/pull/278
* feat(a11y): field ids and auto-aria via v-register by @ozzyfromspace in https://github.com/attaform/Attaform/pull/279
* feat(forms): form.list / form.record with stable element identity by @ozzyfromspace in https://github.com/attaform/Attaform/pull/280
* feat(arrays): identity-keyed element state across array mutations by @ozzyfromspace in https://github.com/attaform/Attaform/pull/281
* fix(home): stop the multistep code block forcing mobile horizontal scroll by @ozzyfromspace in https://github.com/attaform/Attaform/pull/282
* chore(size-limit): rebaseline core-bundle budgets after the refactor by @ozzyfromspace in https://github.com/attaform/Attaform/pull/283
* docs(demos): pare the display-state demo to a single field by @ozzyfromspace in https://github.com/attaform/Attaform/pull/284
* feat(validation): tune the default display state (earned success + interacted gate) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/285
* refactor(aria): unify autoAria across form, app, and per-register by @ozzyfromspace in https://github.com/attaform/Attaform/pull/286
* fix(validation): skip blur revalidation when the value is unchanged by @ozzyfromspace in https://github.com/attaform/Attaform/pull/287


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.18.2...v0.19.0

---

## v0.18.2 — 2026-05-26

## What's Changed
* build(deps): bump pnpm 10 → 11, raise Node floor to 22 by @ozzyfromspace in https://github.com/attaform/Attaform/pull/262
* chore(security): pin action SHAs, add CODEOWNERS and SECURITY.md by @ozzyfromspace in https://github.com/attaform/Attaform/pull/263
* chore(security): add zizmor + openssf scorecard workflows by @ozzyfromspace in https://github.com/attaform/Attaform/pull/264
* chore(security): split publish into validate + publish, gate tarball size by @ozzyfromspace in https://github.com/attaform/Attaform/pull/265
* chore(security): bind workflow inputs to env, scope dependency-review perms by @ozzyfromspace in https://github.com/attaform/Attaform/pull/268
* chore(ci): resolve remaining zizmor warnings by @ozzyfromspace in https://github.com/attaform/Attaform/pull/269
* fix(ci): adjust dependabot cooldown to pass both zizmor + Dependabot validation by @ozzyfromspace in https://github.com/attaform/Attaform/pull/270
* chore(security): push version bump without persisting GITHUB_TOKEN by @ozzyfromspace in https://github.com/attaform/Attaform/pull/272
* chore(security): scope publish-job GPG secrets to a GitHub Environment by @ozzyfromspace in https://github.com/attaform/Attaform/pull/271
* chore(security): install cooldown + matrix cache restore/save split by @ozzyfromspace in https://github.com/attaform/Attaform/pull/266
* docs(changelog): note the supply-chain hardening initiative by @ozzyfromspace in https://github.com/attaform/Attaform/pull/273
* fix(ci): drop apps/site prepare step from the publish job by @ozzyfromspace in https://github.com/attaform/Attaform/pull/274
* fix(ci): publish the pre-packed tarball, not via --no-prepack by @ozzyfromspace in https://github.com/attaform/Attaform/pull/275


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.18.1...v0.18.2

---

## v0.18.1 — 2026-05-25

## What's Changed
* chore: drop magic-string, reach zero runtime dependencies by @ozzyfromspace in https://github.com/attaform/Attaform/pull/253
* chore(deps): bump the production-dependencies group with 4 updates by @dependabot[bot] in https://github.com/attaform/Attaform/pull/257
* docs(site): tighten the homepage hero + reposition to Zod-first by @ozzyfromspace in https://github.com/attaform/Attaform/pull/261
* perf(lint): cut lint runtime from 25+ min to ~19s cold, ~3s warm by @ozzyfromspace in https://github.com/attaform/Attaform/pull/254
* chore: clean up stale refs to removed Recipes section + pre-rebuild slugs by @ozzyfromspace in https://github.com/attaform/Attaform/pull/258
* fix(docs): move docs-prose + install-command CSS out of .vue `<style>` blocks by @ozzyfromspace in https://github.com/attaform/Attaform/pull/259
* docs(changelog): zero-runtime-deps + faster contributor lint by @ozzyfromspace in https://github.com/attaform/Attaform/pull/255


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.18.0...v0.18.1

---

## v0.18.0 — 2026-05-25

## What's Changed
* feat(form): defaultValues trichotomy + form.rehydrate() + meta extensions by @ozzyfromspace in https://github.com/attaform/Attaform/pull/199
* feat(form): useStepper core — navigation + activation lifecycle by @ozzyfromspace in https://github.com/attaform/Attaform/pull/200
* feat(form): useStepper statuses + aggregates + onStatusChange + progress by @ozzyfromspace in https://github.com/attaform/Attaform/pull/201
* feat(form): useStepper browser history + SSR active-step selection by @ozzyfromspace in https://github.com/attaform/Attaform/pull/202
* feat(form): useStepper on zod entries + useForm type-alias factoring by @ozzyfromspace in https://github.com/attaform/Attaform/pull/203
* refactor(types): preserve recursive walkers as aliases in bundled .d.ts (PR A of 4) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/204
* refactor(types): fuse DeepPartial+DefaultValuesShape into DefaultValuesInput (PR B of 4) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/205
* refactor(types): factor FieldStateMapEntry + ErrorsProxyShape via LeafWalker (PR C of 4) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/206
* feat(types): bundled-typecheck CI gate + 4-form pressure suite (PR D of 4) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/207
* refactor(types): fuse ErrorsProxyShape into LeafWalker (wave 2 — PR E) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/208
* refactor(composables): untype v3 useForm impl signature (wave 2 — PR F) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/209
* feat(form): four-form shipment demo + v4/v3 useForm overloads by @ozzyfromspace in https://github.com/attaform/Attaform/pull/210
* feat: v-register on <input type="file"> (picker plumbing + persistence carve-out) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/211
* chore: cleanup sweep — lean + efficient + defensive by @ozzyfromspace in https://github.com/attaform/Attaform/pull/212
* docs(perf): surface measured bench numbers by @ozzyfromspace in https://github.com/attaform/Attaform/pull/213
* fix(vite): forward attaform/zod rewrite + devtools meta by @ozzyfromspace in https://github.com/attaform/Attaform/pull/214
* feat(devtools): first-class Nuxt DevTools overlay panel by @ozzyfromspace in https://github.com/attaform/Attaform/pull/215
* refactor(form): split field-flag tri-state by semantic group + autofocus probe by @ozzyfromspace in https://github.com/attaform/Attaform/pull/216
* test(multi-tab): pin no-plugin lazy-install path for cross-tab sync by @ozzyfromspace in https://github.com/attaform/Attaform/pull/217
* ci: manual-trigger docs deploy + exact-version publish mode by @ozzyfromspace in https://github.com/attaform/Attaform/pull/222
* ci(docs): scope deploy-docs workflow to Production (Docs) environment by @ozzyfromspace in https://github.com/attaform/Attaform/pull/224
* fix(vercel): move vercel.json to repo root so the disable flag is read by @ozzyfromspace in https://github.com/attaform/Attaform/pull/225
* fix(husky): mark hook scripts executable so git stops skipping them by @ozzyfromspace in https://github.com/attaform/Attaform/pull/226
* [01/14] docs(concept-per-page): Phase 1 — preamble + demo restructuring by @ozzyfromspace in https://github.com/attaform/Attaform/pull/229
* [02/14] docs(concept-per-page): Phase 2 — validation + submitting clusters by @ozzyfromspace in https://github.com/attaform/Attaform/pull/230
* [03/14] docs(concept-per-page): Phase 3 — devtools + getting-started cluster by @ozzyfromspace in https://github.com/attaform/Attaform/pull/231
* [04/14] docs(concept-per-page): Phase 4 — reference cluster by @ozzyfromspace in https://github.com/attaform/Attaform/pull/232
* [05/14] docs(human-review): copy + tone sweep by @ozzyfromspace in https://github.com/attaform/Attaform/pull/233
* [06/14] docs(human-review): schemas section by @ozzyfromspace in https://github.com/attaform/Attaform/pull/234
* [07/14] feat(form): preprocess + coerce — no storage mutation by @ozzyfromspace in https://github.com/attaform/Attaform/pull/235
* [08/14] fix(form): errors proxy container self-materialisation by @ozzyfromspace in https://github.com/attaform/Attaform/pull/236
* [09/14] refactor(form): blank-paths as dotted strings by @ozzyfromspace in https://github.com/attaform/Attaform/pull/237
* [10/14] docs(human-review): reading-the-form section by @ozzyfromspace in https://github.com/attaform/Attaform/pull/238
* [11/14] docs(human-review): binding-inputs section by @ozzyfromspace in https://github.com/attaform/Attaform/pull/239
* [12/14] feat(form): useWizard lazy activation + SSR by @ozzyfromspace in https://github.com/attaform/Attaform/pull/240
* [13/14] docs(multistep): section walk by @ozzyfromspace in https://github.com/attaform/Attaform/pull/241
* [14/14] feat(form): wizard composition — useWizard(entry) + handleSubmit + injectWizard by @ozzyfromspace in https://github.com/attaform/Attaform/pull/221
* qc: close typecheck gaps after wizard PR + tighter submit typing by @ozzyfromspace in https://github.com/attaform/Attaform/pull/243
* chore(deps): pin @nuxt/kit and @nuxt/schema to $nuxt in pnpm.overrides by @ozzyfromspace in https://github.com/attaform/Attaform/pull/244
* Wizard polish: docs, hydration, focus, depart-reveal by @ozzyfromspace in https://github.com/attaform/Attaform/pull/245
* feat(wizard): rewrite useWizard around list-based steps (v2) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/246
* feat(wizard): v2 follow-ups — graceful degrade, lazy(), docs sweep by @ozzyfromspace in https://github.com/attaform/Attaform/pull/247
* docs: brand-voice + API-validation sweep across all sections by @ozzyfromspace in https://github.com/attaform/Attaform/pull/248
* docs: revamp homepage + README with schema-first positioning + v-register showcase by @ozzyfromspace in https://github.com/attaform/Attaform/pull/249
* docs(changelog): draft v0.18.0 entry by @ozzyfromspace in https://github.com/attaform/Attaform/pull/250
* docs: add llms.txt + restore CHANGELOG Unreleased convention by @ozzyfromspace in https://github.com/attaform/Attaform/pull/251
* ci(publish): switch to npm Trusted Publishing (drop NPM_TOKEN) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/252


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.17.2...v0.18.0

---

## v0.17.2 — 2026-05-14

## What's Changed
* fix(form): v3 parity through the unified attaform/zod entry by @ozzyfromspace in https://github.com/attaform/Attaform/pull/198


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.17.1...v0.17.2

---

## v0.17.1 — 2026-05-13

## What's Changed
* feat(form): close §1–4 of the 0.17.0 feedback — ReadShape, form.clear, preprocess synthesis by @ozzyfromspace in https://github.com/attaform/Attaform/pull/196
* chore(ci): bump actions/dependency-review-action from 4 to 5 by @dependabot[bot] in https://github.com/attaform/Attaform/pull/190
* fix(form): StorageShape replaces ReadShape — fixes Volar TS2589 by @ozzyfromspace in https://github.com/attaform/Attaform/pull/197
* chore(deps-dev): bump the dev-dependencies group with 20 updates by @dependabot[bot] in https://github.com/attaform/Attaform/pull/191
* chore(deps-dev): bump marked from 15.0.12 to 18.0.3 by @dependabot[bot] in https://github.com/attaform/Attaform/pull/192
* chore(deps-dev): bump @commitlint/config-conventional from 20.5.3 to 21.0.1 by @dependabot[bot] in https://github.com/attaform/Attaform/pull/193
* chore(deps-dev): bump lint-staged from 16.4.0 to 17.0.4 by @dependabot[bot] in https://github.com/attaform/Attaform/pull/194
* chore(deps-dev): bump @commitlint/cli from 20.5.3 to 21.0.1 by @dependabot[bot] in https://github.com/attaform/Attaform/pull/195


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.17.0...v0.17.1

---

## v0.17.0 — 2026-05-11

## What's Changed
* feat(form): library hardening + multi-tab sync via BroadcastChannel by @ozzyfromspace in https://github.com/attaform/Attaform/pull/189


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.16.4...v0.17.0

---

## v0.16.4 — 2026-05-10

## What's Changed
* fix(zod-v3): array .min and parent .refine no longer break per-field revalidation by @ozzyfromspace in https://github.com/attaform/Attaform/pull/183
* chore(site): ship raster favicons for Bing SERP + iOS by @ozzyfromspace in https://github.com/attaform/Attaform/pull/185
* feat(form): add form.touch(path?) and disambiguate '' from root path by @ozzyfromspace in https://github.com/attaform/Attaform/pull/184
* feat(form): add field.showErrors + field.firstError + shouldShowErrors predicate by @ozzyfromspace in https://github.com/attaform/Attaform/pull/186
* chore(site): self-host Inter + JetBrains Mono webfonts by @ozzyfromspace in https://github.com/attaform/Attaform/pull/187
* chore(site): clear pre-existing build warnings by @ozzyfromspace in https://github.com/attaform/Attaform/pull/188


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.16.3...v0.16.4

---

## v0.16.3 — 2026-05-09

## What's Changed
* fix(zod): unify fieldMeta storage; portable hello-world example by @ozzyfromspace in https://github.com/attaform/Attaform/pull/181
* chore(site): IndexNow ping for Bing/Yandex/Naver/Seznam fast-recrawl by @ozzyfromspace in https://github.com/attaform/Attaform/pull/182


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.16.2...v0.16.3

---

## v0.16.2 — 2026-05-08

## What's Changed
* docs(readme): simplify going further snippet by @ozzyfromspace in https://github.com/attaform/Attaform/pull/180


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.16.1...v0.16.2

---

## v0.16.1 — 2026-05-08

## What's Changed
* chore(security): force fast-uri >=3.1.2 to patch open Dependabot alerts by @ozzyfromspace in https://github.com/attaform/Attaform/pull/179
* docs: expand attaform/nuxt reference, rename app-defaults to Global defaults, strip prose backticks from InstallCommand by @ozzyfromspace in https://github.com/attaform/Attaform/pull/178


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.16.0...v0.16.1

---

## v0.16.0 — 2026-05-08

## What's Changed
* feat: Vite + useForm DX overhaul by @ozzyfromspace in https://github.com/attaform/Attaform/pull/176


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.15.1...v0.16.0

---

## v0.15.1 — 2026-05-08

## What's Changed
* fix(composables): surface undefined in useRegister return type by @ozzyfromspace in https://github.com/attaform/Attaform/pull/175


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.15.0...v0.15.1

---

## v0.15.0 — 2026-05-07

## What's Changed
* refactor(site): editorial polish on docs landing + homepage v-register flag by @ozzyfromspace in https://github.com/attaform/Attaform/pull/170
* feat(register/forms): reactive RegisterValue + per-field validating/valid + bare-name booleans by @ozzyfromspace in https://github.com/attaform/Attaform/pull/171
* feat(core): unified FieldState + schema-attached metadata via fieldMeta by @ozzyfromspace in https://github.com/attaform/Attaform/pull/172
* fix(test): deterministic poll for v=2 envelope warn flake by @ozzyfromspace in https://github.com/attaform/Attaform/pull/173


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.14.0...v0.15.0

---

## v0.14.0 — 2026-05-04

## What's Changed
* docs: capitalize Attaform as a proper noun in narrative prose by @ozzyfromspace in https://github.com/attaform/Attaform/pull/167
* chore(deps-dev): bump the dev-dependencies group with 12 updates by @dependabot[bot] in https://github.com/attaform/Attaform/pull/161
* chore(deps-dev): bump vite-plugin-dts from 4.5.4 to 5.0.0 by @dependabot[bot] in https://github.com/attaform/Attaform/pull/162
* feat(site): launch attaform.com — docs site phase 1 by @ozzyfromspace in https://github.com/attaform/Attaform/pull/168
* fix(site): ship REPL types in prod + clean up build noise by @ozzyfromspace in https://github.com/attaform/Attaform/pull/169


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.14.0-rc.0...v0.14.0

---

## v0.14.0-rc.0 — 2026-05-03

## What's Changed
* feat!: 0.14 rewrite — drillable surfaces, DU variant memory, schema coercion, v3/v4 parity, audit + test quality by @ozzyfromspace in https://github.com/attaform/Attaform/pull/160
* refactor!: rebrand @chemical-x/forms → decant by @ozzyfromspace in https://github.com/attaform/Attaform/pull/163
* perf: hot-path optimizations (S/A tier perf review findings) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/164
* perf: drop LRU bump in canonicalizePath; FIFO at this cap by @ozzyfromspace in https://github.com/attaform/Attaform/pull/165
* refactor!: rebrand decant → attaform by @ozzyfromspace in https://github.com/attaform/Attaform/pull/166


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.13.0...v0.14.0-rc.0

---

## v0.13.0 — 2026-04-30

## What's Changed
* chore: gitignore .claude workspace state by @ozzyfromspace in https://github.com/attaform/Attaform/pull/155
* feat!: Pinia-style read API + persist throws + SSR fixes by @ozzyfromspace in https://github.com/attaform/Attaform/pull/156
* refactor: rename transient-empty test files to blank.* by @ozzyfromspace in https://github.com/attaform/Attaform/pull/157
* docs: polish pass — proxy API everywhere, action-first JSDoc, 0.12→0.13 migration by @ozzyfromspace in https://github.com/attaform/Attaform/pull/158


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.12.1...v0.13.0

---

## v0.12.1 — 2026-04-29

## What's Changed
* fix(slim-gate): reject unknown-path writes + property tests + KISS warn copy by @ozzyfromspace in https://github.com/attaform/Attaform/pull/154
* chore(deps-dev): bump the dev-dependencies group with 3 updates by @dependabot[bot] in https://github.com/attaform/Attaform/pull/152


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.12.0...v0.12.1

---

## v0.12.0 — 2026-04-29

## What's Changed
* Claude/optimistic isconnected ssr by @ozzyfromcubic in https://github.com/attaform/Attaform/pull/133
* feat!: validation refactor — errors as data, live by default by @ozzyfromspace in https://github.com/attaform/Attaform/pull/134
* docs: trim README + close the lint/format-check gap by @ozzyfromspace in https://github.com/attaform/Attaform/pull/135
* docs: lower the first-touch barrier in the README by @ozzyfromspace in https://github.com/attaform/Attaform/pull/136
* docs: hoist npm install above the framework split by @ozzyfromspace in https://github.com/attaform/Attaform/pull/137
* feat!: validationMode defaults to 'strict' by @ozzyfromspace in https://github.com/attaform/Attaform/pull/138
* feat: snappier default field-validation debounce (200 → 125 ms) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/139
* feat: app-level defaults on createAttaform + Nuxt module by @ozzyfromspace in https://github.com/attaform/Attaform/pull/140
* feat!: reserve __atta: form-key namespace; rename anon prefix by @ozzyfromspace in https://github.com/attaform/Attaform/pull/141
* test: silence Vue setup-error warns on the reserved-key reject tests by @ozzyfromspace in https://github.com/attaform/Attaform/pull/142
* feat!: per-element persistence opt-in via register({ persist: true }) by @ozzyfromspace in https://github.com/attaform/Attaform/pull/143
* fix: honor setValue callback form at runtime by @ozzyfromspace in https://github.com/attaform/Attaform/pull/148
* feat!: useFormContext returns null + dev-warn on miss by @ozzyfromspace in https://github.com/attaform/Attaform/pull/149
* feat: split useRegistry throws into OutsideSetupError vs RegistryNotInstalledError by @ozzyfromspace in https://github.com/attaform/Attaform/pull/150
* feat!: structural-completeness invariant + fingerprint persistence + read/write type honesty by @ozzyfromspace in https://github.com/attaform/Attaform/pull/151
* feat!: error codes + transient-empty/unset + slim-primitive write contract by @ozzyfromspace in https://github.com/attaform/Attaform/pull/153


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.11.1...v0.12.0

---

## v0.11.1 — 2026-04-25

## What's Changed
* fix(dev): quiet ambient-provide warning + add source frames by @ozzyfromspace in https://github.com/attaform/Attaform/pull/132


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.11.0...v0.11.1

---

## v0.11.0 — 2026-04-25

## What's Changed
* docs: slim README, add Vue 3 / Nuxt 3 + 4 / TypeScript badges by @ozzyfromspace in https://github.com/attaform/Attaform/pull/126
* ci: dedicated lint job + extend prettier scope to md/json/yml by @ozzyfromspace in https://github.com/attaform/Attaform/pull/127
* feat(api)!: expose fieldErrors as a Proxy view, drop ComputedRef wrapper by @ozzyfromspace in https://github.com/attaform/Attaform/pull/128
* feat(api)!: bundle 9 form-level scalars into reactive `state` by @ozzyfromspace in https://github.com/attaform/Attaform/pull/129
* feat(api)!: rename initialState → defaultValues across config + adapters by @ozzyfromspace in https://github.com/attaform/Attaform/pull/130
* docs: sweep recipes + api.md to the 0.11 `state` bundle vocabulary by @ozzyfromspace in https://github.com/attaform/Attaform/pull/131


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.10.0...v0.11.0

---

## v0.10.0 — 2026-04-24

## What's Changed
* fix(nuxt): resolve Nuxt module against package entry, not ./runtime/ by @ozzyfromcubic in https://github.com/attaform/Attaform/pull/125


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.9.0...v0.10.0

---

## v0.9.0 — 2026-04-24

## What's Changed
* Claude/optional form key by @ozzyfromcubic in https://github.com/attaform/Attaform/pull/117
* feat(schema): structural fingerprint() on AbstractSchema + shared-key warning by @ozzyfromspace in https://github.com/attaform/Attaform/pull/118
* ci: enable Dependabot + GitHub Dependency Review on PRs by @ozzyfromspace in https://github.com/attaform/Attaform/pull/119
* chore(ci): bump actions/upload-artifact from 5 to 7 by @dependabot[bot] in https://github.com/attaform/Attaform/pull/120
* chore(ci): bump actions/checkout from 5 to 6 by @dependabot[bot] in https://github.com/attaform/Attaform/pull/123
* chore(ci): bump actions/setup-node from 5 to 6 by @dependabot[bot] in https://github.com/attaform/Attaform/pull/121
* chore(ci): bump pnpm/action-setup from 5 to 6 by @dependabot[bot] in https://github.com/attaform/Attaform/pull/122
* ci: drop deprecated always-auth input from publish-npm workflow by @ozzyfromspace in https://github.com/attaform/Attaform/pull/124


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.8.3...v0.9.0

---

## v0.8.3 — 2026-04-24

## What's Changed
* fix(test): poll for persistence writes instead of fixed-sleep waits by @ozzyfromcubic in https://github.com/attaform/Attaform/pull/115
* ci: auto-create GitHub Release after npm publish + tag push by @ozzyfromcubic in https://github.com/attaform/Attaform/pull/116


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.8.2...v0.8.3

---

## v0.8.2 — 2026-04-24

## What's Changed
* fix(eslint): point nuxt-globals loader at playground/.nuxt by @ozzyfromcubic in https://github.com/attaform/Attaform/pull/114


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.8.1...v0.8.2

---

## v0.8.1 — 2026-04-24

## What's Changed
* ci: bump crazy-max/ghaction-import-gpg + actions/upload-artifact by @ozzyfromcubic in https://github.com/attaform/Attaform/pull/113

## New Contributors
* @ozzyfromcubic made their first contribution in https://github.com/attaform/Attaform/pull/113

**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.8.0...v0.8.1

---

## v0.8.0 — 2026-04-24

## What's Changed
* Core rewrite + new APIs + docs by @ozzyfromspace in https://github.com/attaform/Attaform/pull/112


**Full Changelog**: https://github.com/attaform/Attaform/compare/v0.7.2...v0.8.0

---

Auto-generated per version from the PRs merged into `main` since the
previous tag. Written by `scripts/generate-release-notes.mjs` during
the `pnpm version` hook in the publish workflow — format mirrors
GitHub's auto-generated release notes (PR title + author + PR number).

Historical entries land at the top; older entries below. `CHANGELOG.md`
remains the commit-grouped narrative view of releases.

<!-- Automated entries will be prepended here by the publish workflow. -->
