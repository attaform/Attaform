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

## Auto-installed

`createAttaform()` registers the directive globally, in bare Vue and in Nuxt. You don't import it.

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
