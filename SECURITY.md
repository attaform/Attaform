# Security Policy

Thanks for taking the time to report a security issue in Attaform. Coordinated disclosure helps every consumer of the library, and is genuinely appreciated.

## Supported versions

Attaform is pre-1.0. The most recent `0.x` minor on the `latest` dist-tag receives security fixes; older minors do not. Once 1.0 ships, the support window expands; the policy will be updated then.

| Version | Supported          |
| ------- | ------------------ |
| 0.18.x  | :white_check_mark: |
| < 0.18  | :x:                |

## Reporting a vulnerability

**Preferred channel — GitHub Private Vulnerability Reporting:**

[https://github.com/attaform/Attaform/security/advisories/new](https://github.com/attaform/Attaform/security/advisories/new)

This routes the report directly to the maintainer through GitHub's encrypted advisory workflow. The thread stays private until a fix ships and an advisory is published.

**Backup channel — email:**

`oswald.kay.chisala@gmail.com` with the subject prefix `[security][attaform]`. Use this only if GitHub Private Vulnerability Reporting is unavailable.

Please include, as best you can:

- Affected version(s) of Attaform.
- A minimal reproducer, or a clear description of the attack surface.
- The impact you've assessed (RCE, data exposure, supply-chain, etc.).
- Whether the issue is publicly known or already mitigated downstream.

## Scope

**In scope:**

- The published `attaform` npm tarball and everything it ships at runtime.
- The build and publish pipeline under `.github/workflows/`.
- The docs site at `apps/site/` (the Vercel deployment of `docs.attaform.dev` and `attaform.dev`).
- Repository-level configuration: branch protection, secrets handling, trusted publishing setup.

**Out of scope:**

- Transitive dependency CVEs that do not reach Attaform's consumer surface (those are tracked through Dependabot + Dependency Review).
- Vulnerabilities in third-party Nuxt, Vue, or Vite plugins that the docs site loads but the library itself does not depend on.
- Social-engineering of maintainers, account-recovery flows, or non-technical impersonation.
- Issues that require a compromised maintainer credential as a precondition (the project already invests in WebAuthn 2FA, trusted publishing, and branch protection to harden that surface).

## Response targets

The maintainer is solo. The targets below are best-effort, not contractual.

- **Initial acknowledgement:** within 5 business days of receipt.
- **Triage outcome (confirmed / not-a-vuln / needs-more-info):** within 10 business days.
- **Fix timeline:**
  - Critical (RCE, supply-chain compromise, prototype pollution affecting consumer code): targeted within 14 days.
  - High / moderate: next patch release on the supported minor.
  - Low / informational: next minor.

If a fix requires a coordinated release window with downstream consumers, the embargo will be discussed in the advisory thread before publication.

## Disclosure

After a fix ships:

1. A GitHub Security Advisory is published with the CVE (if assigned) and credit to the reporter (or anonymous, as preferred).
2. The advisory is mirrored to the npm registry through `npm audit` metadata.
3. A note is added to `CHANGELOG.md` under the affected version.

Thank you again.
