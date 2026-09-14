---
title: The v-register directive
description: v-register binds a native input to a schema path. The directive handles the value sync, the coercion, the dirty-tracking, and the focus pass while your input stays native.
metaRows:
  - label: Category
    value: Directive
  - label: Element
    value: input / select / textarea / file
  - label: Auto-installed
    value: 'Yes'
---

# The `v-register` directive

> One directive binds a native input to a schema path. The `<input>` stays native; Attaform sits at the directive layer.

::docs-meta-table
::

Click the input, type a few characters, blur, refocus. The four `form.fields.email.*` bits in the table below flip with each interaction. The directive surfaces every signal the schema-aware layer needs without you wiring a single event listener; the [What it does](#what-it-does) section unpacks the four pieces of plumbing.

::docs-demo{slug="v-register" label="v-register Demo"}
::

## What it does

Bind any native input to a schema path:

```vue
<input v-register="form.register('email')" />
```

The directive runs four pieces of plumbing for you:

1. **Reads** the current value from `form.values.<path>` and writes it into the DOM input on initial render and on every reactive update.
2. **Writes** back to `form.values.<path>` on every `input` event (or `change` / `blur` with modifiers).
3. **Coerces** the DOM string to the schema's leaf type: `type="number"` inputs land in storage as a number, checkboxes as a boolean, radio groups pick the option `value`.
4. **Tracks** field state (`touched`, `focused`, `blurred`, `blank`) and surfaces it through `form.fields.<path>`.

## Let `v-register` own the value

Because the directive already reads and writes the field's value, a second binding for the same value is dead weight: `v-register` wins, and yours never shows. Leave off `:value` on a text input or `<select>`, `:checked` on a checkbox or radio, and `:selected` on an `<option>`, unless the element is [meant to work unbound too](/docs/binding-inputs/use-register):

```vue
<!-- Dead: v-register already drives the value -->
<input v-register="form.register('email')" :value="form.values.email" />

<!-- Correct: v-register owns it -->
<input v-register="form.register('email')" />
```

`v-model` is the one that genuinely fights. It installs Vue's own model directive beside `v-register`, so two writers drive one element and the DOM goes where the last one to run put it. That one is a bug rather than dead weight, and it warns.

The one `:value` that stays is an identity rather than state: the value a radio or an `<option>` stands for. Attaform reads that to decide which option is selected, so keep it.

```vue
<label v-for="flavor in flavors" :key="flavor">
  <input type="radio" v-register="form.register('flavor')" :value="flavor" />
  {{ flavor }}
</label>
```

Two guards keep this right without you thinking about it:

- A dev-console warning in every app, the moment the field mounts.
- A build-time warning when you run Attaform's [Vite or Nuxt plugin](/docs/server-and-ssr/ssr-bare-vue), on every compile, so CI catches it too.

Both are about `v-model` now, and both leave the radio and `<option>` identity `:value` alone. Under the [Vite or Nuxt plugin](/docs/getting-started/installation) a `:value` / `:checked` / `:selected` is not flagged at all: it is what the element falls back to when `v-register` resolves no field, which is what lets [one wrapper serve both a bound and an unbound caller](/docs/binding-inputs/use-register). The runtime warning also stands down entirely for a `v-register` that resolved no field, since nothing is redundant beside a directive that is not driving anything.

That fallback is compiled in, so it needs the plugin. Building without one (the [`installVRegister` setup](#delivered-at-compile-time) below), nothing injects a fallback leg, and a `:value` beside a `v-register` that _did_ resolve a field is dead weight again. The dev-console warning still says so there, which is the right answer for that setup.

## Listen without binding

A second _binding_ fights `v-register`. A _listener_ does not. The directive attaches its own handler in Vue's `created` hook, which runs before Vue applies the handlers you wrote, so `v-register` has already written the field by the time yours is called. What you read there is committed state, not the value the field held a moment ago.

That ordering is what lets a surface save each decision as it is made. The control keeps the binding, the SSR value injection, and the ARIA that `v-register` gives it, and you observe the result:

```vue
<script setup lang="ts">
  import { z } from 'zod'
  import { useForm } from 'attaform'

  const schema = z.object({ choice: z.string() })
  const form = useForm({ schema })

  async function save() {
    // `form.values.choice` is already the newly picked value here.
    await fetch('/api/choice', {
      method: 'PATCH',
      body: JSON.stringify({ value: form.values.choice }),
    })
  }
</script>

<template>
  <select v-register="form.register('choice')" @change="save">
    <option value="yes">Yes</option>
    <option value="no">No</option>
  </select>
</template>
```

`@change` is not a second binding here: it never writes the field, so nothing competes with the directive and neither guard flags it. The same holds for `@input`, for a `v-register.lazy` control, and for a checkbox or radio.

Reach for a listener when the reaction belongs to the interaction, and for a [watch on `form.toRef`](/docs/cross-cutting-state/autosave) when it belongs to the value. The watch also sees programmatic writes such as `form.setValue` and `form.reset()`, which a DOM event never fires for. The autosave recipe builds the whole policy on that: debouncing, per-field status, a validity gate, and a pause for hydrating writes.

## Delivered at compile time

The [Vite plugin and Nuxt module](/docs/getting-started/installation) bind `v-register` into each compiled template that uses it, so in those setups you write the directive and never import it. Building without either (a webpack-family bundler, a no-build page, runtime-compiled templates)? One line per app delivers it:

```ts
import { installVRegister } from 'attaform/directive'

installVRegister(app)
```

This split is also what keeps Attaform lean: an app that never renders `v-register` never ships the directive's DOM machinery.

If you wrap inputs inside a component whose root is **not** the input itself, [`useRegister`](/docs/binding-inputs/use-register) re-binds `v-register` onto an inner native element. For compound components binding multiple paths, prefer [`injectForm`](/docs/reading-the-form/the-form) over `useRegister`.

## Reading errors per field

The directive's binding pair is read-and-error: `form.register('email')` for the input, `form.fields.email.firstError?.message` for the message, gated by `form.fields.email.showErrors` so a half-typed value doesn't get yelled at on first paint.

```vue
<input v-register="form.register('email')" />
<p v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</p>
```

The raw `form.errors.email` Proxy stays available as `ValidationError[]` when you need the full array, empty when the field is valid. `form.fields` is the display-ergonomics layer over the same data.

## Accessibility, handled

By default, `v-register` keeps a field's aria attributes in sync with its [display state](/docs/validation/showing-errors), so assistive technology announces exactly what sighted users see, with no extra wiring:

| Attribute          | Set when                                                              |
| ------------------ | --------------------------------------------------------------------- |
| `aria-invalid`     | the field's `displayState` is `'error'`                               |
| `aria-busy`        | the field's `displayState` is `'pending'` (an async check is running) |
| `aria-required`    | the schema marks the path required                                    |
| `aria-describedby` | points at the field's error id while in the error state               |

These track the same gated `displayState` that drives `form.fields.email.showErrors`, so the announcement and the visible message reveal together, never on a half-typed value. The required and invalid states are emitted during SSR too, so a server-rendered form is accessible before hydration.

`aria-required` is scoped with care. A checkbox that rolls up into an array or set group never carries it, since no single box is required on its own and an empty selection is valid; the requirement lives on the group. And every attribute lands on the real form control: when `v-register` is on a wrapper component, the attributes follow the inner element it re-binds with [`useRegister`](/docs/binding-inputs/use-register), never the presentational root.

### Wiring the error element

Auto-aria sets `aria-describedby` to [`form.fields.<path>.aria.errorId`](/docs/reading-the-form/fields). Put that id on your error element so the reference resolves:

```vue
<input v-register="form.register('email')" />
<p v-if="form.fields.email.showErrors" :id="form.fields.email.aria.errorId">
  {{ form.fields.email.firstError?.message }}
</p>
```

`form.fields.email.aria.errorId` is stable for the field and unique across every mount on the page (it folds in the form's `instanceId`), so two instances of the same form never cross their references. The companion `form.fields.email.id` wires a `<label :for>` to the input when you need one.

### Respect your markup

Write any aria attribute yourself and Attaform leaves it alone, for that one attribute. Author `aria-invalid` while the other three stay automatic:

```vue
<input v-register="form.register('email')" :aria-invalid="hasCustomError" />
```

The check happens per attribute and per binding, so reaching for one escape hatch never disables the rest.

### Turning it off

One knob, `autoAria`, at three tiers; the narrower tier wins:

- Per binding: `form.register('email', { autoAria: false })`.
- Per form: `useForm({ schema, autoAria: false })`.
- App-wide: `createAttaform({ defaults: { autoAria: false } })`.

A narrower tier overrides the wider one in either direction, so a single binding can re-enable management with `{ autoAria: true }` even when the form opted out. Any tier set to `false` hands every aria attribute back to your markup; an authored attribute is always preserved regardless.

## Where to next

- [`useRegister`](/docs/binding-inputs/use-register): the composable for re-binding `v-register` onto an inner native element inside a wrapper component.
- [Modifiers](/docs/binding-inputs/modifiers): `.lazy`, `.trim`, `.number` for tuning the write side.
- [Schema-driven coercion](/docs/binding-inputs/coercion): how DOM strings land at the right leaf type.
- [`values`](/docs/reading-the-form/values): what the directive writes into.
- [`errors`](/docs/reading-the-form/errors): the error reads paired with each registered path.
- [`fields`](/docs/reading-the-form/fields): the `id` and `aria` ids the accessibility wiring reads from.
- [Display state and showing errors](/docs/validation/showing-errors): the gated verdict the aria attributes track.
