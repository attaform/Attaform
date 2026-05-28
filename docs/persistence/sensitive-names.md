---
title: Sensitive-name protection
description: A built-in heuristic warns and skips the persist opt-in for paths like password / cvv / ssn. One configurable list gates persistence writes and multi-tab broadcasts.
metaRows:
  - label: Category
    value: Module
  - label: Default list
    value: DEFAULT_SENSITIVE_NAMES
    kind: code
  - label: Override
    value: createAttaform({ defaults: { sensitiveNames } })
    kind: code
  - label: Acknowledge per field
    value: register(path, { persist: true, acknowledgeSensitive: true })
    kind: code
---

# Sensitive-name protection

> A speed bump for the obvious mistake: opting `password` into client-side storage warns and skips the opt-in. The secret stays unwritten, which is the safe default. Pass `acknowledgeSensitive: true` if the client-side persistence is intentional.

::docs-meta-table
::

Attaform never throws over a recoverable misconfiguration like this. A sensitive-named persist opt-in lands as a one-shot dev warning, the field is dropped from the persist set, and the form mounts cleanly. Devs see the warning during testing and either acknowledge or remove the opt-in; production users never see anything unsafe.

## The default list

`DEFAULT_SENSITIVE_NAMES` covers the common shapes: passwords, card data, identifiers, tokens, MFA artifacts.

```text
password, passwd, pwd, pin, cvv, cvc, ssn, social-security, dob,
date-of-birth, card-number, card, iban, routing-number,
account-number, passport, driver-license, mfa-secret, recovery-code,
token, secret, api-key, private-key
```

Opting one of them into persistence is a quiet no-op plus a console warning:

```vue
<!-- Warns once in dev; the field is not persisted. -->
<input v-register="form.register('password', { persist: true })" />
```

The match is case-insensitive and ignores separator punctuation: `apiKey`, `api_key`, `api-key`, and `API.KEY` all hit the same `api-key` entry. Slash-separated segments and camelCase boundaries split into words before comparison.

## Acknowledging per field

When persistence is intentional (custom encrypted adapter, narrow-scope internal tool, server-managed encryption layer), pass `acknowledgeSensitive: true`:

```vue
<input v-register="form.register('password', { persist: true, acknowledgeSensitive: true })" />
```

The acknowledgement silences the warning for that exact register call and lets the value through to storage. It does NOT remove the path from the resolved sensitive-names list, so the same path stays stripped from multi-tab broadcasts.

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

The resolved list applies to every form created by that app. Per-form overrides land via `useForm({ sensitiveNames })`: the same union type, same matching rules.

## One list, two surfaces

The resolved `sensitiveNames` list gates two write paths:

- **Persistence**: `{ persist: true }` on a sensitive path warns and skips the opt-in. Container opt-ins shed nested sensitive leaves the same way (`register('payment', { persist: true })` writes `payment.last4` but not `payment.cvv`, even if no one ever directly registered `cvv`). The field stays out of storage unless you acknowledge it.
- **Multi-tab sync**: matching paths are stripped _outbound_ (the broadcaster never posts them) AND rejected _inbound_ (receivers drop them even if a peer tries to slip them through).

DevTools renders raw values by design. It is a dev-only surface, and redacting across every place a value surfaces (panels, logs, network tabs, breakpoints, source maps) is impractical security theater, not a real safeguard. Don't share your screen with the DevTools panel open over a customer's session.

## Where to next

- [Per-field opt-in](/docs/persistence/per-field-opt-in): the deliberate per-path opt-in this heuristic backstops.
- [Storage backends](/docs/persistence/storage-backends): the form-level gate before the field gate even matters.
- [Multi-tab sync](/docs/cross-cutting-state/multi-tab-sync): the second subsystem that uses the same resolved list.
