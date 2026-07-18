---
description: The answer key behind Attaform's OpenSSF Best Practices Passing badge, listing every criterion's answer and the repo path or URL that backs it. Submission happens via the bestpractices.dev form.
---

# OpenSSF Best Practices answers for Attaform

Answer key for the [OpenSSF Best Practices](https://www.bestpractices.dev/projects/new) Passing-level criteria. Submitted to earn the badge that closes the `CII-Best-Practices` check on the project's [OpenSSF Scorecard report](https://securityscorecards.dev/viewer/?uri=github.com/attaform/Attaform).

This file is the audit trail: every criterion's answer, the URL or repo path that backs it, and any context that doesn't fit in the form's free-text field. The submission itself happens out-of-band via the bestpractices.dev form (interactive GitHub OAuth required).

The criterion IDs match the upstream form's `criteria_short` field, so the order here is the order they appear at https://www.bestpractices.dev/criteria/0.

Project URL: <https://github.com/attaform/Attaform>
npm package: <https://www.npmjs.com/package/attaform>

## BASICS

### 1. `description_good`: The project website MUST succinctly describe what the software does.

**Answer:** Met.
**URL/evidence:** [README.md](https://github.com/attaform/Attaform/blob/main/README.md)
**Notes:** Top of README describes Attaform as a schema-driven Vue 3 / Nuxt forms library with Zod validation, in one paragraph. The npm package page mirrors the same description.

### 2. `interact`: The project website MUST provide information on how to obtain, give feedback, and contribute.

**Answer:** Met.
**URL/evidence:** [README.md](https://github.com/attaform/Attaform/blob/main/README.md), [CONTRIBUTING.md](https://github.com/attaform/Attaform/blob/main/CONTRIBUTING.md), [Issues](https://github.com/attaform/Attaform/issues)
**Notes:** README has install + quickstart for `pnpm add attaform`. CONTRIBUTING.md covers feedback and contribution flow. GitHub Issues is the feedback channel.

### 3. `contribution`: Information on how to contribute MUST explain the contribution process.

**Answer:** Met.
**URL/evidence:** [CONTRIBUTING.md](https://github.com/attaform/Attaform/blob/main/CONTRIBUTING.md)
**Notes:** CONTRIBUTING.md covers dev setup, the `pnpm check` gate, branch / commit conventions (Conventional Commits), and the PR-flow expectation.

### 4. `contribution_requirements`: Information on how to contribute SHOULD include requirements for acceptable contributions.

**Answer:** Met.
**URL/evidence:** [CONTRIBUTING.md](https://github.com/attaform/Attaform/blob/main/CONTRIBUTING.md), [eslint.config.js](https://github.com/attaform/Attaform/blob/main/eslint.config.js)
**Notes:** CONTRIBUTING.md states the test-required policy for `src/runtime/` changes and lists the conventional-commit prefixes. ESLint config + TypeScript strict mode codify the style requirements; PRs that fail `pnpm check` cannot merge once branch protection is in place.

### 5. `floss_license`: The software produced by the project MUST be released as FLOSS.

**Answer:** Met.
**URL/evidence:** [LICENSE](https://github.com/attaform/Attaform/blob/main/LICENSE)
**Notes:** MIT License.

### 6. `floss_license_osi`: Any required license(s) SHOULD be approved by the Open Source Initiative.

**Answer:** Met.
**URL/evidence:** <https://opensource.org/licenses/MIT>
**Notes:** MIT is OSI-approved.

### 7. `license_location`: The project MUST post the license(s) in a standard location.

**Answer:** Met.
**URL/evidence:** [LICENSE](https://github.com/attaform/Attaform/blob/main/LICENSE)
**Notes:** Root-level `LICENSE` file, recognized by GitHub's license-detection UI.

### 8. `documentation_basics`: The project MUST provide basic documentation for the software.

**Answer:** Met.
**URL/evidence:** [apps/site (docs portal)](https://github.com/attaform/Attaform/tree/main/apps/site), [README.md](https://github.com/attaform/Attaform/blob/main/README.md)
**Notes:** Docs site (Nuxt + @nuxt/content) hosts the full reference; README has the quickstart. Live docs deployed via the `deploy-docs.yml` workflow.

### 9. `documentation_interface`: The project MUST provide reference documentation describing external interfaces.

**Answer:** Met.
**URL/evidence:** [apps/site/content/docs](https://github.com/attaform/Attaform/tree/main/apps/site/content/docs)
**Notes:** Per-symbol reference pages: `useForm`, `useRegister`, `useWizard`, `injectForm`, plus schema, validation, SSR, undo/redo. Every public API symbol has its own page with the inference-first DX walkthroughs Attaform is built around.

### 10. `sites_https`: Project sites MUST support HTTPS using TLS.

**Answer:** Met.
**URL/evidence:** <https://github.com/attaform/Attaform>, <https://www.npmjs.com/package/attaform>
**Notes:** GitHub and npm registry both HTTPS-only. The Vercel-hosted docs deployment is also HTTPS by default.

### 11. `discussion`: The project MUST have searchable discussion mechanisms allowing URL-addressable topics.

**Answer:** Met.
**URL/evidence:** [Issues](https://github.com/attaform/Attaform/issues), [Pull Requests](https://github.com/attaform/Attaform/pulls)
**Notes:** GitHub Issues + Pull Requests provide URL-addressable, searchable, threaded discussion. Each issue and PR has a stable URL.

### 12. `english`: The project SHOULD provide documentation in English.

**Answer:** Met.
**URL/evidence:** README, CONTRIBUTING, SECURITY, all docs pages
**Notes:** Every persisted artifact is in English.

### 13. `maintained`: The project MUST be maintained.

**Answer:** Met.
**URL/evidence:** [Recent commits](https://github.com/attaform/Attaform/commits/main), [Recent releases](https://github.com/attaform/Attaform/releases)
**Notes:** Active development with multiple commits per week and weekly-to-bi-weekly releases (current: 0.27.5). Issues responded to within days. Active maintainer signal is the strongest signal Scorecard's `Maintained` check already grades at 10/10.

## CHANGE_CONTROL

### 14. `repo_public`: Publicly readable version-controlled source repository with URL.

**Answer:** Met.
**URL/evidence:** <https://github.com/attaform/Attaform>
**Notes:** Public GitHub repository.

### 15. `repo_track`: Repository MUST track what changes were made, who made them, and when.

**Answer:** Met.
**URL/evidence:** [Commit history](https://github.com/attaform/Attaform/commits/main)
**Notes:** Git history. Commit authorship is verified by GPG signatures on tagged releases ([Pinned-Dependencies](https://securityscorecards.dev/viewer/?uri=github.com/attaform/Attaform) check confirms).

### 16. `repo_interim`: Repository MUST include interim versions for review between releases.

**Answer:** Met.
**URL/evidence:** [Commit history](https://github.com/attaform/Attaform/commits/main), [Pull Requests](https://github.com/attaform/Attaform/pulls)
**Notes:** Every commit lands via PR; the full development history (~300+ PRs as of May 2026) is the interim record between npm releases.

### 17. `repo_distributed`: Common distributed version control software SHOULD be used.

**Answer:** Met.
**URL/evidence:** Git (via GitHub)
**Notes:** Git is the canonical example given by the criterion text.

### 18. `version_unique`: Project results MUST have a unique version identifier for each release.

**Answer:** Met.
**URL/evidence:** [Releases](https://github.com/attaform/Attaform/releases), [npm versions](https://www.npmjs.com/package/attaform?activeTab=versions)
**Notes:** semver-versioned npm releases; each `v0.X.Y` is a unique tag + npm version.

### 19. `version_semver`: Semantic Versioning or Calendar Versioning SHOULD be used for releases.

**Answer:** Met.
**URL/evidence:** [package.json](https://github.com/attaform/Attaform/blob/main/package.json), [Releases](https://github.com/attaform/Attaform/releases)
**Notes:** Strict SemVer. Pre-1.0 cycle uses the `0.MINOR.PATCH` convention; breaking changes bump the minor (per SemVer §4).

### 20. `version_tags`: Projects SHOULD identify each release within version control.

**Answer:** Met.
**URL/evidence:** [Tags](https://github.com/attaform/Attaform/tags)
**Notes:** Every release has a `vX.Y.Z` git tag. Tags are GPG-signed (`git tag -v vX.Y.Z` verifies against the maintainer's published key). Verified by the publish workflow.

### 21. `release_notes`: Each release MUST provide human-readable release notes summarizing major changes.

**Answer:** Met.
**URL/evidence:** [CHANGELOG.md](https://github.com/attaform/Attaform/blob/main/CHANGELOG.md), [RELEASES.md](https://github.com/attaform/Attaform/blob/main/RELEASES.md), [GitHub Releases](https://github.com/attaform/Attaform/releases)
**Notes:** Three-layer notes: handwritten `CHANGELOG.md` for the curated narrative, auto-generated `RELEASES.md` for the PR-by-PR ledger, GitHub Releases for the in-platform view.

### 22. `release_notes_vulns`: Release notes MUST identify every publicly known runtime vulnerability fixed.

**Answer:** Met.
**URL/evidence:** [SECURITY.md](https://github.com/attaform/Attaform/blob/main/SECURITY.md), [CHANGELOG.md](https://github.com/attaform/Attaform/blob/main/CHANGELOG.md)
**Notes:** SECURITY.md states the disclosure policy: every fixed vulnerability is mirrored to CHANGELOG.md with reporter credit + CVE (when assigned). Recent prototype-pollution remediation (PRs #308, #309, #310) is documented in CHANGELOG.md under the relevant minor.

## REPORTING

### 23. `report_process`: Project MUST provide a process for users to submit bug reports.

**Answer:** Met.
**URL/evidence:** [Issues](https://github.com/attaform/Attaform/issues), [SECURITY.md](https://github.com/attaform/Attaform/blob/main/SECURITY.md)
**Notes:** GitHub Issues for non-security bugs; SECURITY.md documents the Private Vulnerability Reporting channel for security bugs.

### 24. `report_tracker`: Project SHOULD use an issue tracker for tracking individual issues.

**Answer:** Met.
**URL/evidence:** [Issues](https://github.com/attaform/Attaform/issues)
**Notes:** GitHub Issues with labels for triage, severity, and area.

### 25. `report_responses`: Project MUST acknowledge majority of bug reports.

**Answer:** Met.
**URL/evidence:** [Closed issues](https://github.com/attaform/Attaform/issues?q=is%3Aissue+is%3Aclosed)
**Notes:** Solo-maintainer project; every issue has a maintainer response within days. The Issues "closed" tab shows the historical rate.

### 26. `enhancement_responses`: Project SHOULD respond to majority of enhancement requests.

**Answer:** Met.
**URL/evidence:** [Issues with enhancement label](https://github.com/attaform/Attaform/issues?q=is%3Aissue+label%3Aenhancement)
**Notes:** Same rapid-response pattern as bug reports. Enhancement requests are responded to and either accepted (file PR), deferred (label + comment), or rejected (closed with rationale).

### 27. `report_archive`: Project MUST have a publicly available archive for reports and responses.

**Answer:** Met.
**URL/evidence:** [Issues](https://github.com/attaform/Attaform/issues?q=is%3Aissue), [Pull Requests](https://github.com/attaform/Attaform/pulls?q=is%3Apr)
**Notes:** GitHub Issues + PRs are the public archive. Every state transition is timestamped and searchable.

### 28. `vulnerability_report_process`: Project MUST publish its vulnerability reporting process on the project site.

**Answer:** Met.
**URL/evidence:** [SECURITY.md](https://github.com/attaform/Attaform/blob/main/SECURITY.md)
**Notes:** SECURITY.md is the published process. GitHub also surfaces it under the repo's Security tab via the "Report a vulnerability" affordance.

### 29. `vulnerability_report_private`: If private vulnerability reports are supported, the project MUST include how to send them privately.

**Answer:** Met.
**URL/evidence:** [SECURITY.md](https://github.com/attaform/Attaform/blob/main/SECURITY.md)
**Notes:** Primary channel: GitHub Private Vulnerability Reporting at `https://github.com/attaform/Attaform/security/advisories/new` (encrypted advisory workflow, two-party visible only). Backup: email `oswald.kay.chisala@gmail.com` with subject prefix `[security][attaform]`.

### 30. `vulnerability_report_response`: Initial response to vulnerability reports MUST be ≤14 days.

**Answer:** Met.
**URL/evidence:** [SECURITY.md](https://github.com/attaform/Attaform/blob/main/SECURITY.md)
**Notes:** SECURITY.md commits to 5-business-day initial acknowledgement (well inside the 14-day requirement). Triage outcome within 10 business days. Critical fixes ship within 14 days.

## QUALITY

### 31. `build`: If software requires building, MUST provide working build system.

**Answer:** Met.
**URL/evidence:** [CONTRIBUTING.md](https://github.com/attaform/Attaform/blob/main/CONTRIBUTING.md), [package.json](https://github.com/attaform/Attaform/blob/main/package.json), [Makefile](https://github.com/attaform/Attaform/blob/main/Makefile)
**Notes:** `pnpm install --frozen-lockfile && pnpm dev:prepare` bootstraps from source. The Docker-based dev flow (`make install` / `make dev`) is the documented setup. `pnpm prepack` (unbuild) is the production build.

### 32. `build_common_tools`: Common tools SHOULD be used for building.

**Answer:** Met.
**URL/evidence:** [package.json](https://github.com/attaform/Attaform/blob/main/package.json), [build.config.ts](https://github.com/attaform/Attaform/blob/main/build.config.ts)
**Notes:** pnpm, Node.js 22, TypeScript, Vue 3, Nuxt 3+, unbuild. All canonical in the JS ecosystem.

### 33. `build_floss_tools`: Project SHOULD be buildable using only FLOSS tools.

**Answer:** Met.
**URL/evidence:** all dependencies are FLOSS-licensed (verified by [Pinned-Dependencies](https://securityscorecards.dev/viewer/?uri=github.com/attaform/Attaform) check at 10/10 and [dependency-review.yml](https://github.com/attaform/Attaform/blob/main/.github/workflows/dependency-review.yml))
**Notes:** dependency-review.yml's license-policy block denies AGPL/GPL/LGPL but accepts permissive FLOSS licenses (MIT, ISC, Apache-2.0, BSD).

### 34. `test`: Project MUST use at least one automated test suite released as FLOSS.

**Answer:** Met.
**URL/evidence:** [test/](https://github.com/attaform/Attaform/tree/main/test), [vitest.config.ts](https://github.com/attaform/Attaform/blob/main/vitest.config.ts)
**Notes:** Vitest (MIT-licensed) is the test runner. 3,580+ tests as of May 2026.

### 35. `test_invocation`: Test suite SHOULD be invocable in a standard way.

**Answer:** Met.
**URL/evidence:** [package.json scripts](https://github.com/attaform/Attaform/blob/main/package.json)
**Notes:** `pnpm test` and `pnpm check` (full pipeline) are the documented entry points. `pnpm test <file>` runs a single test file. CONTRIBUTING.md documents both.

### 36. `test_most`: Test suite SHOULD cover most or ideally all code branches and functionality.

**Answer:** Met.
**URL/evidence:** [Coverage report (per matrix.yml artifact)](https://github.com/attaform/Attaform/actions/workflows/matrix.yml)
**Notes:** Current coverage: 87% statements, 81% branches, 88% functions, 91% lines. Coverage budget enforced by `pnpm check:coverage`; PRs that drop coverage fail CI.

### 37. `test_continuous_integration`: Project SHOULD implement continuous integration with automated tests.

**Answer:** Met.
**URL/evidence:** [.github/workflows/matrix.yml](https://github.com/attaform/Attaform/blob/main/.github/workflows/matrix.yml)
**Notes:** `matrix.yml` runs full `pnpm check` (lint, format, typecheck, site build, tests, size, bench, coverage) on every push to `main` and every PR. `peer-matrix.yml` runs the Vue 3.5+, Vite 5/6, Nuxt 3/4 compatibility sweep weekly.

### 38. `test_policy`: Project MUST have a policy that tests be added as major new functionality is added.

**Answer:** Met.
**URL/evidence:** [CONTRIBUTING.md](https://github.com/attaform/Attaform/blob/main/CONTRIBUTING.md)
**Notes:** CONTRIBUTING.md "What NOT to touch" section explicitly requires "matching test" for any change under `src/runtime/lib/core/transforms/`. PR template (when added) enforces the same.

### 39. `tests_are_added`: Project MUST provide evidence that test policy has been adhered to recently.

**Answer:** Met.
**URL/evidence:** [Recent PRs adding tests](https://github.com/attaform/Attaform/pulls?q=is%3Apr+is%3Aclosed)
**Notes:** Recent example: PRs #308, #309 (prototype-pollution remediation) each landed dedicated regression tests in `test/core/set-at-path-prototype-pollution.test.ts`, etc. Every feature PR includes its matching test file.

### 40. `tests_documented_added`: Test policy SHOULD be documented in change-proposal instructions.

**Answer:** Met.
**URL/evidence:** [CONTRIBUTING.md](https://github.com/attaform/Attaform/blob/main/CONTRIBUTING.md)
**Notes:** Section "What NOT to touch" documents the matching-test requirement for `src/runtime/lib/core/transforms/` changes.

### 41. `warnings`: Project MUST enable compiler warning flags or use a linter.

**Answer:** Met.
**URL/evidence:** [eslint.config.js](https://github.com/attaform/Attaform/blob/main/eslint.config.js), [tsconfig.json](https://github.com/attaform/Attaform/blob/main/tsconfig.json)
**Notes:** ESLint (flat config with `@typescript-eslint`, `eslint-plugin-vue`, `eslint-plugin-promise`). TypeScript with `strict: true` and `noUncheckedIndexedAccess`. Vue SFC linting via `eslint-plugin-vue`. zizmor (pedantic persona) lints workflows.

### 42. `warnings_fixed`: Project MUST address warnings.

**Answer:** Met.
**URL/evidence:** [matrix.yml](https://github.com/attaform/Attaform/blob/main/.github/workflows/matrix.yml)
**Notes:** `pnpm check` runs `eslint .` with `--max-warnings 0`. Any new warning fails CI; no warnings can land on `main`.

### 43. `warnings_strict`: Projects SHOULD be maximally strict with warnings where practical.

**Answer:** Met.
**URL/evidence:** [eslint.config.js](https://github.com/attaform/Attaform/blob/main/eslint.config.js), [tsconfig.json](https://github.com/attaform/Attaform/blob/main/tsconfig.json)
**Notes:** TypeScript `strict: true` includes the full strict family (strictNullChecks, noImplicitAny, strictFunctionTypes, strictBindCallApply, alwaysStrict, strictPropertyInitialization, useUnknownInCatchVariables, noImplicitThis). Plus `noUncheckedIndexedAccess`, `noImplicitReturns`, `noUnusedParameters`. ESLint config is the project's own flat config with conservative defaults, per-rule curated rather than extended from a permissive recommended preset.

## SECURITY

### 44. `know_secure_design`: At least one primary developer MUST know how to design secure software.

**Answer:** Met.
**URL/evidence:** Recent commit history demonstrating threat-modelling
**Notes:** The maintainer (Oswald Chisala) is a full-time senior software engineer with experience covering secure design (least-privilege OIDC flows, supply-chain hardening, input-sanitisation patterns). Recent demonstrations: scoped OIDC publish surface in publish-npm.yml after the May 2026 Mini Shai-Hulud worm; `Object.create(null)` proto-less storage sweep across the runtime (PRs #308, #309, #310); CodeQL triage closing 6 first-run findings (PR #307).

### 45. `know_common_errors`: At least one primary developer MUST know common vulnerability errors and mitigations.

**Answer:** Met.
**URL/evidence:** [PR #307](https://github.com/attaform/Attaform/pull/307), [PR #308](https://github.com/attaform/Attaform/pull/308), [PR #309](https://github.com/attaform/Attaform/pull/309)
**Notes:** PR #307 remediated polynomial ReDoS, prototype pollution, TOCTOU file race, untrusted HTTP→FS data flow, FS→HTTP data flow, and identity replacement. Six distinct CodeQL categories, each with a targeted fix that doesn't just suppress the finding.

### 46. `crypto_published`: Software MUST use only publicly published and reviewed cryptographic protocols.

**Answer:** Met (delegated).
**URL/evidence:** N/A (no first-party cryptographic protocol use)
**Notes:** Attaform is a forms library; it does not implement or invoke cryptography directly. Its publish pipeline uses HTTPS (TLS 1.3) via npm, GPG signatures via OpenPGP, and Sigstore via `actions/attest-build-provenance`. All published, peer-reviewed protocols.

### 47. `crypto_call`: Applications SHOULD only call cryptographic functions, not re-implement them.

**Answer:** Met (delegated).
**URL/evidence:** N/A (no first-party cryptographic code)
**Notes:** No cryptographic code in `src/`.

### 48. `crypto_floss`: Cryptography-dependent functionality MUST be implementable using FLOSS.

**Answer:** N/A.
**Notes:** Attaform has no cryptography-dependent runtime functionality.

### 49. `crypto_keylength`: Default keylengths MUST meet NIST minimum requirements through 2030.

**Answer:** N/A.
**Notes:** No first-party key generation or selection. The OpenSSF Sigstore-backed attestation flow (used by `actions/attest-build-provenance` per PR #311) is internally bound to current NIST recommendations.

### 50. `crypto_working`: Defaults MUST NOT depend on broken cryptographic algorithms.

**Answer:** N/A.
**Notes:** See #48–49.

### 51. `crypto_weaknesses`: Defaults SHOULD NOT depend on algorithms with known serious weaknesses.

**Answer:** N/A.
**Notes:** See #48–49.

### 52. `crypto_pfs`: Security mechanisms SHOULD implement perfect forward secrecy.

**Answer:** N/A.
**Notes:** No key-agreement mechanisms; all transport is HTTPS (TLS handles PFS at the transport layer outside Attaform's surface).

### 53. `crypto_password_storage`: Passwords MUST be stored as iterated hashes with per-user salt.

**Answer:** N/A.
**Notes:** Attaform does not store passwords. Form values are held in memory only and are never written to browser storage by Attaform; persistence of any collected value is the consumer application's responsibility.

### 54. `crypto_random`: Cryptographic keys and nonces MUST be generated using secure random generators.

**Answer:** N/A.
**Notes:** Attaform does not generate cryptographic keys or nonces. Internal `field-ids.ts` uses string-stem normalisation, not random IDs.

### 55. `delivery_mitm`: Project MUST use delivery mechanism countering MITM attacks.

**Answer:** Met.
**URL/evidence:** [package.json](https://github.com/attaform/Attaform/blob/main/package.json), [.npmrc](https://github.com/attaform/Attaform/blob/main/.npmrc)
**Notes:** `publishConfig.registry: "https://registry.npmjs.org/"` (HTTPS-only). The publish workflow uses npm Trusted Publishing OIDC, eliminating any MITM-able token. Git clone over HTTPS or SSH.

### 56. `delivery_unsigned`: Cryptographic hashes MUST NOT be retrieved via http without signature verification.

**Answer:** Met.
**URL/evidence:** [.npmrc](https://github.com/attaform/Attaform/blob/main/.npmrc), [pnpm-lock.yaml](https://github.com/attaform/Attaform/blob/main/pnpm-lock.yaml)
**Notes:** `pnpm-lock.yaml` pins every dependency by SHA-512 integrity hash (lockfile v9). Publication includes `--provenance` (npm provenance) and GitHub Attestation (`actions/attest-build-provenance`, see PR #311); consumer can verify with `npm audit signatures` or `gh attestation verify`.

### 57. `vulnerabilities_fixed_60_days`: NO unpatched medium+ severity vulnerabilities publicly known >60 days.

**Answer:** Met.
**URL/evidence:** [Security tab](https://github.com/attaform/Attaform/security)
**Notes:** Zero open security advisories at submission time. Recent CodeQL findings (May 2026) were remediated within 48 hours of detection (PRs #307–#310).

### 58. `vulnerabilities_critical_fixed`: Projects SHOULD fix critical vulnerabilities rapidly.

**Answer:** Met.
**URL/evidence:** [PR #307](https://github.com/attaform/Attaform/pull/307), [PR #308](https://github.com/attaform/Attaform/pull/308), [PR #309](https://github.com/attaform/Attaform/pull/309)
**Notes:** The proto-pollution sweep landed across three PRs within a 72-hour window of CodeQL surfacing the findings. SECURITY.md commits to a 14-day-or-less fix window for critical issues; recent evidence beats that target by an order of magnitude.

### 59. `no_leaked_credentials`: Public repositories MUST NOT leak valid private credentials.

**Answer:** Met.
**URL/evidence:** GitHub Secret Scanning (enabled by default on public repos), npm Trusted Publishing eliminates the `NPM_TOKEN` secret
**Notes:** No `.env` files committed. The publish pipeline uses OIDC Trusted Publishing (no NPM_TOKEN to leak) + GPG signing via `GPG_PRIVATE_KEY` repo secret (write-only access, scoped to the Production environment). GitHub secret-scanning + push-protection are active.

## ANALYSIS

### 60. `static_analysis`: At least one static analysis tool MUST be applied before major release.

**Answer:** Met.
**URL/evidence:** [.github/workflows/codeql.yml](https://github.com/attaform/Attaform/blob/main/.github/workflows/codeql.yml)
**Notes:** CodeQL with the `security-extended` query suite for JavaScript/TypeScript. ESLint with type-aware rules (`@typescript-eslint`). TypeScript compiler strict mode. zizmor (pedantic) for workflows.

### 61. `static_analysis_common_vulnerabilities`: Static analysis tools SHOULD include rules for common vulnerabilities.

**Answer:** Met.
**URL/evidence:** [.github/workflows/codeql.yml](https://github.com/attaform/Attaform/blob/main/.github/workflows/codeql.yml)
**Notes:** `security-extended` includes prototype pollution, ReDoS, path traversal, code injection, taint-flow chains, SSRF, eval-injection. The standard OWASP/CWE high-priority set. Demonstrated by the PR #307 remediation surfacing real findings under each major category.

### 62. `static_analysis_fixed`: Medium+ severity vulnerabilities from analysis MUST be fixed timely.

**Answer:** Met.
**URL/evidence:** [PR #307](https://github.com/attaform/Attaform/pull/307), [Security tab](https://github.com/attaform/Attaform/security)
**Notes:** First-run CodeQL findings remediated in PR #307 (close-out within 24 hours). Subsequent runs (PRs #308–#310) addressed deeper architectural concerns (sanitise-not-block proto-less storage). Zero open code-scanning alerts at submission time.

### 63. `static_analysis_often`: Static analysis SHOULD occur on every commit or at least daily.

**Answer:** Met.
**URL/evidence:** [.github/workflows/codeql.yml](https://github.com/attaform/Attaform/blob/main/.github/workflows/codeql.yml)
**Notes:** CodeQL triggers: push to main, every PR, weekly cron (Tue 03:00 UTC). Per-commit on every change to main; per-PR on every code review.

### 64. `dynamic_analysis`: At least one dynamic analysis tool SHOULD be applied before major release.

**Answer:** Met.
**URL/evidence:** [test/](https://github.com/attaform/Attaform/tree/main/test), [.github/workflows/matrix.yml](https://github.com/attaform/Attaform/blob/main/.github/workflows/matrix.yml)
**Notes:** Vitest unit + integration tests (3,580+) run on every commit. Coverage report enforces branch and statement budgets. `peer-matrix.yml` runs cross-version compatibility tests weekly (Vue 3.5+, Vite 5/6, Nuxt 3/4).

### 65. `dynamic_analysis_unsafe`: Memory-unsafe languages SHOULD use dynamic tools with memory safety detection.

**Answer:** N/A.
**Notes:** Attaform is implemented in TypeScript (compiled to memory-safe JavaScript). No native code in the publish surface.

### 66. `dynamic_analysis_enable_assertions`: Dynamic analysis SHOULD use configuration enabling many assertions.

**Answer:** Met.
**URL/evidence:** [vitest.config.ts](https://github.com/attaform/Attaform/blob/main/vitest.config.ts), [test/](https://github.com/attaform/Attaform/tree/main/test)
**Notes:** Vitest config enables strict mode. Tests use explicit assertions (`expect`) throughout, no soft-pass patterns. CI fails the run on any assertion failure.

### 67. `dynamic_analysis_fixed`: Medium+ severity vulnerabilities from dynamic analysis MUST be fixed timely.

**Answer:** Met.
**URL/evidence:** [matrix.yml](https://github.com/attaform/Attaform/blob/main/.github/workflows/matrix.yml)
**Notes:** `matrix.yml` blocks merge on any failing test or coverage regression. Recent dynamic-analysis-surfaced failures (the validation-signal regressions across the tune/default-display-state and perf/skip-unchanged-revalidation branches) were addressed within the same PR cycle.

## Submission checklist

The repo ships a generated `.bestpractices.json` at the root. bestpractices.dev auto-discovers it and pre-fills the form, so submission collapses to a review pass.

1. Confirm `.bestpractices.json` is up to date: `node scripts/build-bestpractices-json.mjs` should produce no diff.
2. Open <https://www.bestpractices.dev/projects/new>.
3. Sign in with GitHub (the OAuth flow links the badge to the maintainer's identity).
4. Enter the project URL: `https://github.com/attaform/Attaform`.
5. Open each of the six sections in order (`BASICS` → `CHANGE_CONTROL` → `REPORTING` → `QUALITY` → `SECURITY` → `ANALYSIS`). The first edit per section triggers the auto-fill from `.bestpractices.json`. Spot-check the pre-filled answers against the table above.
6. Click **Save (and continue) 🤖** at the bottom of each section.
7. The form's status flips to "passing" once every MUST and most SHOULD criteria are Met or N/A. The pre-fill produces that state by design; if the badge meter doesn't move, find the offending criterion in the upstream form and trace the value back to the markdown above.
8. After approval (usually same-day for clean submissions), file a follow-up PR adding the badge image + link to README.md:

   ```markdown
   [![CII Best Practices](https://www.bestpractices.dev/projects/<id>/badge)](https://www.bestpractices.dev/projects/<id>)
   ```

   Replace `<id>` with the integer the form assigns on submission. The badge sits in the existing README badges row alongside the Scorecard badge.

## What this answer-key does not cover

- **Silver** and **Gold** badge levels. Those add criteria around code review, governance, and cryptographic hardening that exceed Passing's scope. Once Attaform has a co-maintainer (the structural cap on Scorecard's `Code-Review` check), Silver becomes achievable; until then, Passing is the right target.
- **Per-criterion remediation work**: none required. Every Passing criterion is already met or marked N/A by the existing repo state.

## Maintenance

The OpenSSF badge state revalidates yearly. When the renewal prompt arrives, walk this file top-to-bottom and update any URL or rationale that's drifted (e.g. file path moves, new SECURITY.md commitments), then regenerate `.bestpractices.json`:

```bash
node scripts/build-bestpractices-json.mjs
```

Commit the regenerated JSON alongside the markdown edits. bestpractices.dev re-reads the file on the next form save; only changed criteria need clicking through.
