# Attaform

> A type-safe, schema-driven form library for Vue 3 and Nuxt with first-class Zod support. Hand a Zod schema to `useForm` and Attaform turns it into a reactive form, typed end-to-end, with live errors, automatic accessibility, and SSR out of the box.

This file is regenerated from the Attaform documentation on every build, so its links and its code stay in lockstep with the live site. For anything past this index, the docs at [attaform.dev](https://attaform.dev), the published `attaform` types, and the source at [github.com/attaform/Attaform](https://github.com/attaform/Attaform) are canonical. When in doubt, crawl from the homepage rather than giving up on the project.

Attaform's core idea is that the schema IS the form. One Zod schema declares the shape, the defaults, the validation, the per-field errors, and the input/output types. Attaform builds the reactive surface around it.

The default entry `attaform` dispatches between Zod v3 and v4 per call, so projects on either version (or a mix) share one import; `attaform/zod` is the same surface, named explicitly. The Nuxt module auto-wires the plugin, the `v-register` directive, the SSR plumbing, and the DevTools panel. Bare Vue + Vite works through the Vite plugin without Nuxt.

Forms are bound to native inputs through the `v-register` directive, which also keeps each field's aria attributes in sync with its validation state. Submission goes through `form.handleSubmit(onSubmit)`. Multistep flows compose multiple `useForm` instances under `useWizard`. Undo/redo, server-error routing, and a Nuxt DevTools panel are all opt-in.

## API at a glance

<!-- @snippet:script -->

<!-- @snippet:template -->

The form handle exposes reactive reads (`form.values`, `form.errors`, `form.fields`, `form.meta`), mutation helpers (`form.setValue`, `form.reset`, `form.history.undo`), and submission (`form.handleSubmit`). The `v-register` directive accepts `{ transforms, autoAria }` options for per-field configuration.

Multistep flows compose forms under `useWizard`:

```ts
import { useForm, useWizard } from 'attaform'

const account = useForm({ schema: accountSchema, key: 'account' })
const profile = useForm({ schema: profileSchema, key: 'profile' })

const wizard = useWizard({
  steps: [account, 'review', profile],
})

const onComplete = wizard.handleSubmit(async (ctx) => {
  await fetch('/onboarding', { method: 'POST', body: JSON.stringify(ctx.values) })
})
```

Steps can be `useForm` references, bare strings (affordance-only positions), `null` / `undefined` (filtered out), eager function slots, or `lazy(ctx => ...)` markers. `wizard.handleSubmit` validates every step from any position and calls `onSubmit` once with all values; it never advances. `wizard.tryNext()` is the gated Next: it validates the active step and advances only on a clean pass.

## Quick reference

The form handle returned by `useForm({ schema })`:

- `form.values` reactive view of form state. Drill: `form.values.email`. Call: `form.values('user.email')`.
- `form.errors` reactive error map by path. Same drill and call shapes.
- `form.fields.<path>` per-field state. Most-touched keys: `value`, `touched`, `interacted`, `blurredAfterInteraction`, `dirty`, `blank`, `displayState`, `showErrors`, `firstError`, `validating`, `valid`, `errors`, `key`, `focused`, `blurred`, `connected`. `displayState` (`idle` / `pending` / `error` / `success`) projects to `showPending` / `showSuccess` / `showIdle` alongside `showErrors`; every field also carries `id` + `aria.{errorId, descriptionId}` for accessibility wiring, and `key` follows an array element across reorders. The default display gate is reward-early/punish-late: it stays `idle` on a clean tab-through and mid-entry, reveals once a field is edited and then left (or on any submit), and clears live on re-focus. `interacted` (sticky on the first user edit) and `blurredAfterInteraction` (sticky on the first blur after an edit, the gate's driver) tell a real, completed edit apart from a tab-through.
- `form.list(path)` / `form.record(path)` per-element reads: one FieldState per array element (index order) or per record entry (keyed), each carrying the stable `key` for a keyed `v-for`. `form.fields(path)` stays the rolled-up container for the whole array or record.
- `form.meta` top-level flags: `valid`, `dirty`, `submitting`, `submitted`, `submissionAttempts`, `submitError`, `errorCount`, `errors`, `key`, `instanceId`. `form.meta` is itself a rolled-up FieldState, so it also carries `displayState` / `show*` aggregated over the form; `form.meta.showPending` additionally tracks the form's own validation, so it stays lit through a submit's validation pass. Gate a submit button on `form.meta.submitting` (the precise "a submit is in flight" flag); use `form.meta.showPending` for an ambient "validating" indicator.
- `form.register(path, opts?)` returns the binding for `v-register`. Options: `transforms`, `autoAria`.
- `form.handleSubmit(onSubmit, onError?)` submit wrapper. Validates, routes errors, calls `onSubmit` with the parsed values.
- `form.setValue(path, value)`, `form.reset(defaults?)`, `form.resetField(path)`, `form.clear(path?)`, `form.unset(path)` programmatic writes.
- `form.append`, `form.prepend`, `form.insert`, `form.remove`, `form.swap`, `form.move`, `form.replace` typed field-array mutations. An element's state (value, errors, dirty, touched) travels with it across reorders.
- `form.validate(path?)`, `form.validateAsync(path?)`, `form.parse(path?)` manual validation. `form.parse` is always async (no sync variant by design) and resolves the parsed Zod output.
- `form.setErrors(errors)`, `form.setErrors(path, errors)`, `form.setErrors(updater)`, `form.clearErrors(path?)` set or clear the manual error layer. A path-less error is form-level at the root `[]`; each error accepts an optional `data` payload.
- `form.history.{undo, redo, clear, canUndo, canRedo, size}` undo/redo namespace.
- `form.applyInvalidSubmitPolicy(policy?)`, `form.focusFirstError()`, `form.scrollToFirstError()` UX primitives.
- `form.touch(path?)`, `form.toRef(path)`, `form.rehydrate()` introspection and lifecycle helpers.

The wizard handle returned by `useWizard({ steps })`:

- `wizard.currentStep`, `wizard.activeForm`, `wizard.activeIndex`, `wizard.count`, `wizard.isFinalStep` position.
- `wizard.next()`, `wizard.back()`, `wizard.goTo(key)`, `wizard.tryNext()`, `wizard.reset()` navigation. `tryNext()` validates the active step and advances only if it passes; the others move the pin without validating.
- `wizard.handleSubmit(onSubmit, onError?)` whole-wizard submit. Validates every step from any position and calls `onSubmit` once with all values; it never advances (compose with `tryNext` / `next` to move between steps).
- `wizard.forms.<key>` typed map of step forms.
- `wizard.allValues`, `wizard.allErrors`, `wizard.statuses` namespaced aggregates.
- `wizard.progress`, `wizard.canAdvance`, `wizard.canGoBack`, `wizard.complete`, `wizard.done` derived signals.
- `wizard.submitting`, `wizard.submissionAttempts`, `wizard.visited` submission state.

## Idioms

Patterns that keep Attaform code clean.

- **Hoist schemas.** Declare `const schema = z.object({...})`, then pass `useForm({ schema })`. Inlining the Zod schema inflates the visible API surface in templates.
- **Use the form handle. Don't destructure.** `const form = useForm(...)`, then reach for `form.register('email')`, `form.setValue(...)`, etc. Destructuring loses the central noun and the reactive bindings.
- **Reach with `?.` on nullable returns.** `injectForm()` and `injectWizard()` return `T | null`. Chain optional access at every consumption site (`form?.register('email')`, `form?.fields.email.showErrors`). Skip the `!` non-null assertion; a single mount-order regression turns a quiet no-op into a runtime crash.
- **Read errors through `field.showErrors` and `field.firstError`.** The visibility heuristic lives in `showErrors`; reaching into `field.errors[0]` directly bypasses it.
- **Accessibility is automatic.** `v-register` keeps `aria-invalid`, `aria-busy`, `aria-required`, and `aria-describedby` in sync with each field's display state and emits them during SSR. Put `form.fields.<path>.aria.errorId` on the error element so `aria-describedby` resolves. Author any aria attribute yourself to take that one over, or pass `autoAria: false` to opt out.
- **Use `key` for stable forms.** Anonymous `useForm({ schema })` works for one-off forms. Pass `key: 'signup'` when you want cross-component lookup via `injectForm('signup')`.
- **Compose, don't nest.** For multistep flows, compose multiple `useForm` instances under `useWizard` rather than nesting concerns into one schema.
- **Native inputs first.** Bind to `<input>`, `<select>`, `<textarea>` with `v-register`. Reach for `useRegister` only when wrapping a custom component.
- **`form.values` is the verbatim input.** Values coerced by `z.coerce.*` or transformed by `z.preprocess` only materialise in the parsed `data` callback inside `form.handleSubmit((data) => ...)`.

<!-- @doc-index -->

## Interactive

- [Demos](https://attaform.dev/demos): every docs demo as a standalone editable playground.

## Optional

- [GitHub](https://github.com/attaform/Attaform): source, issues, discussions.
- [npm](https://www.npmjs.com/package/attaform): published versions and install command.
- [CHANGELOG](https://github.com/attaform/Attaform/blob/main/CHANGELOG.md): release history.

## Author

Attaform is created and maintained by [Oswald Chisala](https://www.linkedin.com/in/chisalao/) ([@ozzyfromspace](https://github.com/ozzyfromspace) on GitHub).
