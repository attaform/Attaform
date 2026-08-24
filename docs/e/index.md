---
title: Error codes
description: Every AF code an Attaform production build can emit, decoded. Each page carries the full development message, the cause, and the way out.
---

# Error codes

Attaform keeps production diagnostics compact: each condition throws or logs as a stable code in the shape `[attaform] AF10 attaform.dev/e/af10`, and the link in the message lands here. Development builds carry the full explanation inline instead, so the fastest way to a rich message is running the same interaction on a dev build.

Codes are stable identifiers. A retired code is never reassigned, and the message text around a code can evolve without notice; branch on the error class or the code, never on the prose.

| Code            | Condition                                                    |
| --------------- | ------------------------------------------------------------ |
| [AF01](/e/af01) | The schema and the adapter disagree on the Zod major version |
| [AF02](/e/af02) | The schema uses a kind Attaform has no form semantics for    |
| [AF03](/e/af03) | The adapter met a Zod kind it does not recognize             |
| [AF04](/e/af04) | `useForm` received an invalid configuration                  |
| [AF05](/e/af05) | A form key uses the reserved `__atta:` namespace             |
| [AF06](/e/af06) | `useForm` / `injectForm` ran outside Vue `setup()`           |
| [AF07](/e/af07) | No Attaform registry is attached to the Vue app              |
| [AF08](/e/af08) | A numeric path segment is not a non-negative integer         |
| [AF09](/e/af09) | A dotted path contains an empty segment                      |
| [AF10](/e/af10) | `form.rehydrate()` ran without a `defaultValues` factory     |
| [AF11](/e/af11) | `resetField` could not restore a leaf from originals         |
| [AF12](/e/af12) | `resetField` could not restore a subtree from originals      |
| [AF13](/e/af13) | The Zod v3 adapter defaulted an unsupported kind to `null`   |
| [AF14](/e/af14) | A `register` transform threw and the write was aborted       |
