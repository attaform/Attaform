---
title: Custom assigners
description: For elements whose value surface isn't a DOM property, assignKey installs a per-element function that decides what to write to form state when the directive sees an event.
metaRows:
  - label: Category
    value: Directive binding
  - label: Slot
    value: el[assignKey] = fn
    kind: code
  - label: Signature
    value: (value, registerValue?) => boolean | undefined
    kind: code
  - label: Symbol
    value: Symbol.for('attaform:assign-key')
    kind: code
---

# Custom assigners

> The escape hatch for elements whose value surface isn't a DOM property — install a write function per element, decide what lands in storage when an event fires.

::docs-meta-table
::

Click the color swatches to watch the JSON readout flip. The widget isn't an `<input>` — it's a plain `<div>` with buttons that dispatches `input` events and stores its picked color on `dataset.color`. A custom assigner installed via `el[assignKey] = fn` translates that to a form write. The [Install via `assignKey`](#install-via-assignkey) section walks through the wire-up.

::docs-demo{slug="custom-assigners" label="Custom Assigner Demo"}
::

## When v-register needs help

`v-register`'s default extractor reads `el.value` (or `el.checked` for checkboxes, `el.files` for files). For elements whose value lives somewhere else — a Web Component with `el.color`, a custom widget with `el.dataset.x`, a third-party slider with a method-only surface — the default can't see what to write.

A custom assigner replaces the write step. The directive still fires on the same DOM events; the assigner decides what value to commit.

## Install via `assignKey`

```ts
import { assignKey, type CustomDirectiveRegisterAssignerFn } from 'attaform'

const colorAssigner: CustomDirectiveRegisterAssignerFn = (_value, rv) => {
  if (!rv) return false
  rv.setValueWithInternalPath(widgetEl.dataset.color ?? '')
  return true
}

onMounted(() => {
  widgetEl[assignKey] = colorAssigner
})
```

`assignKey` is `Symbol.for('attaform:assign-key')` — a well-known symbol so multiple installers (your code, a third-party wrapper, the library's defaults) can detect and coordinate.

## The function signature

```ts
type CustomDirectiveRegisterAssignerFn = (
  value: unknown,
  registerValue?: RegisterValue
) => boolean | undefined
```

| Arg             | Use                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `value`         | What the directive extracted from the event. May be `undefined` when the assigner reads its own state.                                                                                            |
| `registerValue` | The `RegisterValue` for the current binding. Call `rv.setValueWithInternalPath(v)` to commit a write. Omitted when installed via `el[assignKey] = fn`; the installer already has the RV in scope. |

Return `true` to signal the write was accepted, `false` to reject. `undefined` is treated as success — simple assigners can `return` nothing.

## Reach for transforms first

If you just want to reshape the value before write — uppercase, trim, parse — reach for [register transforms](/docs/binding-inputs/transforms) instead. Transforms compose into a per-field pipeline declared at the call site, no element-level installation, no symbol indirection.

`assignKey` is for cases where the extracted value isn't right at all — different source, different shape, different element type. Web Components, custom widgets, third-party libraries that don't speak the standard DOM event surface.

## Where to next

- [Register transforms](/docs/binding-inputs/transforms) — the higher-level option for value reshaping.
- [`useRegister`](/docs/binding-inputs/use-register) — the composable for Vue component wrappers that need to re-bind v-register internally.
- [The `v-register` directive](/docs/binding-inputs/v-register) — the directive layer custom assigners plug into.
