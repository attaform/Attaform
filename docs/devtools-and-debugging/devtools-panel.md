---
title: The Attaform DevTools panel
description: Every registered form shows up in the Nuxt DevTools sidebar with values, errors, aggregates, and a timeline of every change. Auto-wired by attaform/nuxt, dev-gated at the module level.
metaRows:
  - label: Category
    value: Module
  - label: Where
    value: Nuxt DevTools sidebar
  - label: Install
    value: attaform/nuxt, nothing else
    kind: code
  - label: Production
    value: route injection skipped, no @nuxt/devtools-kit import
---

# The Attaform DevTools panel

> A first-class native tab in the Nuxt DevTools sidebar. Every form's value, errors, aggregates, and event timeline, with an editable JSON tree for the values.

::docs-meta-table
::

This page is code-only; the panel lives in your browser's Nuxt DevTools overlay, not inside the docs site. Open any Nuxt-powered Attaform consumer in dev (`Shift + Option + D` opens the overlay) and pick **Attaform** in the sidebar to see it.

## Installing

The integration is automatic; adding `attaform/nuxt` to your Nuxt config wires the tab:

```ts
// nuxt.config.ts: no devtools-specific config needed
export default defineNuxtConfig({
  modules: ['attaform/nuxt'],
  devtools: { enabled: true },
})
```

No peer dependency to add, no extension to install, no Vite plugin to configure. Open the Nuxt DevTools overlay (`Shift + Option + D` or click the Nuxt logo in the bottom corner) and select **Attaform** from the sidebar.

The tab is dev-only; production builds skip the route injection and the `@nuxt/devtools-kit` import entirely. Nothing ships in production.

## What you see

### Form list

One entry per registered form, keyed by the form's `key`. Click a form to inspect it.

### Form value

The current `form.values` as an interactive JSON tree. **Editable from the panel:** your edit flows through `setValueAtPath` and drives the whole reactive pipeline (validation, persistence opt-in, history). The panel writes back into the same store the form reads from, so a value edited in DevTools is indistinguishable from one typed into an input.

Values render verbatim. The panel is dev-only, so it doesn't mask passwords / tokens / secrets; debugging a credential flow typically needs the actual value. The sensitive-name heuristic still applies elsewhere in Attaform (persistence writes, multi-tab broadcasts), it's just not applied to the dev surface. Close the panel before a screen share if a value would be sensitive on camera, the same hygiene as the browser's own DevTools console.

### Schema Errors / User Errors

The error map keyed by path, split by source:

- **Schema Errors**: what the validator (Zod adapter) produced. Cleared by `reset()` / `handleSubmit` success.
- **User Errors**: what you wrote via `setFieldErrors` / `addFieldErrors` / the `parseApiErrors` server-error pipeline. Persists across revalidation and successful submits.

Splitting them tells you instantly whether validation or your application code emitted each error.

### Aggregates

The reactive bundle:

- `submitting`
- `submissionAttempts`
- `submitError`
- `activeValidations`

Useful for confirming your loading-state wiring is reading the right reactive thing.

### Timeline

A scrollable log of recent events. Each entry shows a timestamp, an event type, and the form key, with the form value at the moment of fire available on click.

| Event            | Fires on                                                                 |
| ---------------- | ------------------------------------------------------------------------ |
| `form.change`    | Every mutation: register inputs, `setValue`, array helpers, undo / redo. |
| `submit.success` | A submit handler's `onSubmit` callback resolves.                         |
| `reset`          | `reset()` completes.                                                     |

Capacity is capped at 200 events per session; older entries fall off the back. Hit **clear** to wipe the log mid-debug.

## Sensitive-path redaction

Values at paths matching the resolved `sensitiveNames` list render as `<redacted>` in the tree, the same list that gates persistence opt-ins and multi-tab broadcasts. Extend it once at the app level via `createAttaform({ defaults: { sensitiveNames } })` and the DevTools panel respects the broader list.

The redaction is render-time only; the panel still reads the underlying value (it has to, the redaction lives between the store and the inspector tree). For deep production-data spelunking on a sensitive surface, use a non-prod environment with synthetic data instead of relying on the redact walk.

## What's coming

- **Field flags** (touched / focused / blurred) in the inspector: values + errors are surfaced today, UI interaction state isn't.
- **History stack visualization.** Undo / redo snapshots show on the timeline via `form.change` entries; the stack itself isn't a separate node yet.
- **Persisted payload preview.** Inspect live form state in the inspector; for the serialized payload on disk, open Application → Storage in the browser DevTools.

## Caveats

- **Panel edits bypass your component bindings.** Fine for poking at state during debugging; don't rely on the path mirroring production interaction exactly.
- **Multi-app setups.** The Nuxt overlay panel reads from the most recent `createAttaform()` install; micro-frontend setups with parallel apps will only see one app's forms in the Nuxt panel. Reach for [Vue DevTools integration](/docs/devtools-and-debugging/vue-devtools) when you need per-app inspection.
- **Screen-share hygiene.** The panel renders raw values (modulo the sensitive-name redact). Close it before screen-sharing, the same way you'd close the browser DevTools console.

## Where to next

- [Vue DevTools integration](/docs/devtools-and-debugging/vue-devtools): the alternative for Vite / bare-Vue projects, or as a complement on Nuxt.
- [Troubleshooting](/docs/devtools-and-debugging/troubleshooting): what the panel surfaces, in narrative form.
- [Sensitive-name protection](/docs/persistence/sensitive-names): the list the redact walk reads.
