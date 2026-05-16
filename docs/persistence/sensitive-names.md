---
title: Sensitive-name protection
description: A built-in heuristic throws SensitivePersistFieldError at mount if you try to persist a path named password / cvv / ssn — one configurable list gates persistence, multi-tab sync, and the DevTools redact walk.
metaRows:
  - label: Category
    value: Module
  - label: Default list
    value: DEFAULT_SENSITIVE_NAMES
    kind: code
  - label: Override
    value: createAttaform({ defaults: { sensitiveNames } })
    kind: code
  - label: Bypass per field
    value: register(path, { persist: true, acknowledgeSensitive: true })
    kind: code
---

# Sensitive-name protection

> A speed bump for the obvious mistakes — opting `password` into client-side storage throws at mount, and the same list gates multi-tab broadcasts and the DevTools redact walk.

::docs-meta-table
::

This page is code-only — the demo _is_ the throw, and rendering a thrown setup hook on the docs page would make the docs page itself fail to mount. The mechanism is small enough to read at a glance below.

## The default list

`DEFAULT_SENSITIVE_NAMES` covers the common shapes — passwords, card data, identifiers, tokens, MFA artifacts:

```text
password, passwd, pwd, pin, cvv, cvc, ssn, social-security, dob,
date-of-birth, card-number, card, iban, routing-number,
account-number, passport, driver-license, mfa-secret, recovery-code,
token, secret, api-key, private-key
```

Trying to opt one of them into persistence throws `SensitivePersistFieldError` at mount:

```vue
<!-- Throws SensitivePersistFieldError -->
<input v-register="form.register('password', { persist: true })" />
```

The match is case-insensitive and ignores separator punctuation — `apiKey`, `api_key`, `api-key`, and `API.KEY` all hit the same `api-key` entry. Slash-separated segments and camelCase boundaries split into words before comparison.

## Bypassing per field

If persistence is intentional (custom encrypted adapter, narrow-scope internal tool), pass `acknowledgeSensitive: true`:

```vue
<input v-register="form.register('password', { persist: true, acknowledgeSensitive: true })" />
```

The override silences the throw for that exact register call — it does NOT remove the path from the resolved sensitive-names list, so the same path is still stripped from multi-tab broadcasts and redacted in the DevTools panel.

Treat `acknowledgeSensitive: true` as a code-review trigger, not a soundness boundary. The heuristic doesn't catch alias-typed paths (`register('pswd' as 'password')`), abbreviated variants not in the list, or schemas with deliberately innocuous keys for sensitive data. Per-field opt-in is the real defense; this is a default to lean against.

## Extending the list

The default is exposed as `DEFAULT_SENSITIVE_NAMES`. Compose your own by spreading it:

```ts
import { createAttaform, DEFAULT_SENSITIVE_NAMES } from 'attaform'

createAttaform({
  defaults: {
    sensitiveNames: [...DEFAULT_SENSITIVE_NAMES, 'mrn', 'tax_id', 'health_record'],
  },
})
```

The resolved list applies to every form created by that app. Per-form overrides land via `useForm({ sensitiveNames })` — the same union type, same matching rules.

## One source of truth, three uses

The resolved `sensitiveNames` list gates three subsystems:

- **Persistence** — `{ persist: true }` against a sensitive path throws.
- **Multi-tab sync** — matching paths are stripped _outbound_ (the broadcaster never posts them) AND rejected _inbound_ (receivers drop them even if a malicious sender tries to slip them through).
- **DevTools redact walk** — values on matching paths render as `<redacted>` in the inspector tree.

One list, three layers. Extending it once tightens all three.

## Catching the error

If you'd rather log and continue than throw, wrap the throwing register call in a `try` outside the directive. Easiest in `useRegister`-driven custom components:

```ts
import { SensitivePersistFieldError } from 'attaform'

try {
  // …
} catch (err) {
  if (err instanceof SensitivePersistFieldError) {
    console.warn('Persistence blocked on sensitive path:', err.path)
  } else {
    throw err
  }
}
```

In practice almost no one does this — the throw lands at _mount_, the same time a typo in the schema or a missing key would. Fix it in the call site, not in a try/catch.

## Where to next

- [Per-field opt-in](/docs/persistence/per-field-opt-in) — the deliberate per-path opt-in this heuristic backstops.
- [Storage backends](/docs/persistence/storage-backends) — the form-level gate before the field gate even matters.
- [Multi-tab sync](/docs/cross-cutting-state/multi-tab-sync) — the second subsystem that uses the same resolved list.
