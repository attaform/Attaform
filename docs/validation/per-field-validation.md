---
title: Per-field validation
description: Schema-level chains attach validators to one field at a time; .refine on the parent object attaches cross-field refinements with a target path. Both surface the error at the right field.
metaRows:
  - label: Category
    value: Schema pattern
  - label: Single-field
    value: .min · .max · .regex · .email · .refine (per-leaf)
    kind: code
  - label: Cross-field
    value: parent.refine(checker, { path })
    kind: code
  - label: Errors surface at
    value: errors.<targetPath>
    kind: code
---

# Per-field validation

> The schema is the validator — chain refinements onto one leaf, or attach cross-field rules to the parent with a target path.

::docs-meta-table
::

Type into each field to watch its own refinements light up — the username's regex requirement, the password's min length, and the cross-field "passwords must match" check that fires when `confirmPassword` differs from `password`. Both single-field and cross-field validators live in the schema; the [Two patterns](#two-patterns) section traces each.

::docs-demo{slug="per-field-validation" label="Per-field Validation Demo"}
::

## Two patterns

Attaform reads two Zod patterns for per-field validation, both surfacing errors at the right `form.errors.<path>`.

### Single-field chains

Every Zod primitive accepts a chain of refinements:

```ts
z.object({
  username: z
    .string()
    .min(3, 'At least 3 characters')
    .max(20, 'At most 20 characters')
    .regex(/^[a-z0-9_]+$/, 'Lowercase letters, numbers, and underscores only'),
})
```

Each refinement's error message appears at `errors.username`. The order matters — refinements stop at the first failure, so `.min(3)` runs before `.regex`. Read the field's `firstError` to get the first failure's message; the full array is available at `errors.<path>` for surfacing every refinement that fired.

### Cross-field refinements

For checks that involve multiple paths, attach `.refine` to the parent object and use the `path` option to target where the error lands:

```ts
z.object({
  password: z.string().min(8),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: 'Passwords must match',
  path: ['confirmPassword'],
})
```

The refinement runs against the whole parent value; the `path` option directs the error to `errors.confirmPassword` so the UI surfaces it next to the right input. Without `path`, the error lands at the parent path (the form root in this example).

## Custom per-field refinements

For predicates beyond the built-in chain, use `.refine` at the leaf:

```ts
z.string().refine((v) => !v.includes('admin'), {
  message: 'Reserved word — pick another username',
})
```

The function receives the parsed leaf value; return `true` to accept, `false` to reject. The message string surfaces as the error's `.message`.

## Sync vs async

Sync refinements run on every validation pass — keystroke, blur, submit (per the [validateOn config](/docs/validation/when-validation-runs)). For checks that need a server round-trip (uniqueness probes, slug availability, password-breach lookups), reach for [async refinements](/docs/validation/async-refinements) — Zod's `.refine` accepts an async predicate, and Attaform awaits it before submit dispatches.

## Where to next

- [Async refinements](/docs/validation/async-refinements) — predicates that await a server round-trip.
- [The validation lifecycle](/docs/validation/lifecycle) — the three imperative methods (`validate`, `validateAsync`, `process`).
- [When validation runs](/docs/validation/when-validation-runs) — the `validateOn` timing knob.
- [Showing errors at the right time](/docs/validation/showing-errors) — the `showErrors` predicate.
