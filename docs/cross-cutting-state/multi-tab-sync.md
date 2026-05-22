---
title: Multi-tab sync
description: Same-keyed forms in same-origin tabs auto-pair via BroadcastChannel — every keystroke mirrors across tabs in near real-time, with sensitive paths filtered both directions and HTTPS-or-localhost required.
metaRows:
  - label: Category
    value: Module
  - label: Opt in
    value: useForm({ key })
    kind: code
  - label: Transport
    value: BroadcastChannel (same-origin)
  - label: Security gate
    value: secure context (HTTPS or localhost)
---

# Multi-tab sync

> Same-keyed forms in same-origin tabs converge live — type in one, the other catches up on the next microtask. No subscription wiring, no opt-in beyond the form's `key`.

::docs-meta-table
::

Open this page in a second tab (duplicate, or a regular new tab navigating to the same URL), then type in either one. Both tabs share the same `key:` and the same Attaform form, so the broadcaster mirrors every keystroke. Errors and submit lifecycle stay tab-local — only values and `blankPaths` cross the wire.

::docs-demo{slug="multi-tab-sync"}
::

## What it closes

The user-impact footgun without sync: a user submits in tab A while tab B holds stale state. Tab B looks live (no error), so subsequent edits there race against and overwrite the just-submitted truth. The data-loss mode is invisible to the user.

With sync on, every same-keyed tab converges in near real-time. Tab B sees tab A's submit (the cleared form), so further edits there start from a known baseline.

## What syncs

| Surface                 | Sync model                                                          |
| ----------------------- | ------------------------------------------------------------------- |
| `form.values`           | Per-mutation `Patch[]` (live); full snapshot on join.               |
| `blankPaths` set        | Per-mutation added/removed; snapshot on join.                       |
| `errors`                | NOT synced — locally re-derived from values via validation.         |
| Field interaction state | NOT synced — `touched`/`focused`/`blurred` are UI-state, tab-local. |
| Submit lifecycle        | NOT synced — `submitCount` / `submitError` are per-callsite.        |
| `instanceId`            | NOT synced — per-mount identity by definition.                      |
| History chain           | NOT synced — each tab walks its own user's undo timeline.           |

Errors aren't broadcast because they'd carry sensitive context ("invalid SSN: 123-45-6789"). Each tab re-runs its own validation against the synced value — one source of truth for the data, zero leaks.

## Conflict semantics

Last-writer-wins. Two tabs typing into the same field at the same instant produce convergent state on whichever message arrives later. For form fields (mostly short scalars), the cost of an occasional clobbered character is far less than the cost of invisible divergence.

There's no focus-skip rule — the field a user is currently in WILL accept remote writes mid-typing. For stricter semantics on a particular field, opt it out per-register:

```vue
<input v-register="form.register('notes', { multiTab: false })" />
```

The opted-out field stays tab-local — broadcasts neither out nor in for that path, even when the rest of the form syncs.

## Disabling sync

Three levels of opt-out. The cascade goes (most specific wins):

```ts
register(path, { multiTab: false }) // single field tab-local
useForm({ multiTab: false }) // whole form tab-isolated
createAttaform({ defaults: { multiTab: false } }) // app-wide
```

The cascade is downgrade-only. `multiTab: false` at any level prevents the broadcaster from instantiating; `multiTab: true` at a more specific level cannot bring it back if a broader scope already disabled it.

## Pairing with `persist`

Sync and persistence are independent — both, either, or neither.

- **Sync only**: live cross-tab convergence; no durable baseline. Reloading the tab loses the in-memory state and fresh-joins via handshake to any other live tab.
- **Persist only**: durable baseline; tabs don't see each other's mid-edit state.
- **Both**: sync drives live convergence; persist drives warm-start. Persistence hydration is the floor — when a `BroadcastChannel` snapshot arrives on a fresh mount, it overrides the disk-persisted baseline.

```ts
useForm({
  schema,
  key: 'signup',
  persist: 'local', // warm-start
  // multiTab implicit-true → live cross-tab convergence
})
```

## Security

Required reading for production deployments handling regulated data (PII, PHI, FedRAMP, HIPAA).

### Secure-context requirement

The module activates only when `window.isSecureContext === true` — HTTPS in production OR localhost in development (covers `localhost`, `127.0.0.1`, `[::1]`, `*.localhost`). Plain HTTP on a real hostname silently no-ops with a one-shot dev warning.

This is the same gate browsers apply to other sensitive APIs (clipboard, geolocation, push, web crypto subtle) — no new mental model. Production deployments must be served over HTTPS for sync to function.

### Threat model

`BroadcastChannel` is **same-origin only** — browser-enforced. Cross-origin tabs, iframes, and windows cannot subscribe. Messages are transient (not persisted) — no replay-across-reload surface.

What sync expands vs. the no-sync status quo:

- **XSS amplification.** An XSS bug in any tab can passively eavesdrop on or actively inject into every same-origin tab running the same keyed form. Same-origin trust is binary; this is irreducible at the library layer.
- **Third-party scripts on the same origin** (analytics, embedded widgets, ad SDKs) can subscribe to channels.
- **PII / PHI exposure** widens — previously gated behind a persistence opt-in, now flows by default for any keyed form.

### Defenses (built in, not optional)

- **Sensitive-path filtering — outbound AND inbound.** Paths matching the resolved `sensitiveNames` list are stripped before posting AND rejected on receive. Defense in depth — the wire is never trusted, even when the originating tab "should have" stripped them. The same list gates persistence and the DevTools redact walk; extend per-form or globally:

  ```ts
  createAttaform({
    defaults: { sensitiveNames: [...DEFAULT_SENSITIVE_NAMES, 'mrn'] },
  })
  ```

- **Prototype-pollution defense.** Inbound patches with `__proto__` / `constructor` / `prototype` segments in their path are rejected before the apply step touches the form.
- **Echo drop via per-module `senderId`.** Every outbound message carries a per-`useForm` UUID; receivers drop messages whose `senderId` matches their own. Defends intra-tab self-loops and any UA echo behaviour.
- **Protocol versioning.** Every message carries `v: 1`; unknown versions are dropped silently. Lets the wire format evolve across rolling deploys without silently corrupting older tabs.
- **No errors / submit lifecycle on the wire.** An error message could carry sensitive context, so it never leaves the local tab.

## Where to next

- [Sensitive-name protection](/docs/persistence/sensitive-names) — the same list gates broadcasts and persistence.
- [Persistence edge cases & hydration](/docs/persistence/edge-cases) — handles the warm-start case; sync handles the live case.
- [App-wide defaults](/docs/cross-cutting-state/app-defaults) — disable sync globally or extend the sensitive-names list.
