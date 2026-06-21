---
title: Third-party components
description: Bind a component from any Vue library with the same v-register you use on a native input. Attaform reaches in for the value and the field state, with escape hatches for the rest.
metaRows:
  - label: Category
    value: Directive binding
  - label: Consumer API
    value: none (just v-register)
  - label: Escape hatches
    value: wrapper, custom assigner, useRegister
---

# Third-party components

> Already invested in a component library? Keep it. The same `v-register="form.register(path)"` that binds a native input also binds a component from the kit you already use.

::docs-meta-table
::

Attaform's happy path is markup you control: a native `<input>`, or a small wrapper you wrote. That keeps the binding direct and the surface tiny, and it is what the rest of these docs reach for first. But plenty of teams already lean on a component library, and rewriting every field is not on the table. Attaform meets you there.

There is no separate API to learn for this. You write the same one line you would write on a native input, and Attaform does the reaching.

Here is `v-register` binding real components from two libraries, the same one line on each. Interact with any control and watch its value flow into the form while its field state lights up beside it:

::docs-demo{slug="third-party-reka-ui" label="reka-ui (headless)"}
::

reka-ui ships headless primitives, so each control above is unstyled markup the demo themes itself. PrimeVue ships fully themed components instead. The binding does not care either way:

::docs-demo{slug="third-party-primevue" label="PrimeVue (themed)"}
::

## The one line you write

```vue
<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  // A text field from the component library you already use:
  import { TextField } from 'your-ui-kit'

  const schema = z.object({ email: z.email() })
  const form = useForm({ schema })
</script>

<template>
  <TextField v-register="form.register('email')" />
</template>
```

That is the whole integration. No `control` prop, no options bag, no adapter per library. The `form` handle is the same reactive form you use everywhere else, and `form.register('email')` is the same binding you would hand a native `<input>`.

## How Attaform reaches in

A native input gives `v-register` everything in one element. A component hides its real control behind a wrapper, so Attaform reaches in along two cooperating paths.

**The value rides the component's own `v-model`.** At compile time, Attaform sees `v-register` on a component and wires up the standard Vue model contract for you: it feeds `modelValue` from form state and listens for `update:modelValue` to write back. The value it passes is the typed value your schema expects, not a stringified DOM string, so a number field stores a number and a date field stores a `Date`. Because the value flows through the component's own `modelValue`, the server renders the seeded value straight into the HTML: the form is correct before hydration, no flash, no client-only patch.

**The field state comes from the real control.** At mount, the directive looks inside the component for the native control it renders and binds onto it. When it finds exactly one input, that control becomes the field's anchor: focus and blur tracking, the `connected` bit, the [aria attributes](/docs/binding-inputs/v-register#accessibility-handled), and the focus-and-scroll target for an invalid submit all light up on it, exactly as they would on a bare input.

Composite widgets are welcome too. A PIN input made of several boxes, or a slider built from `<div>`s with no native control at all, has no single element to anchor. Attaform notices, steps back from the single-element latch, and tracks focus at the widget root instead, so the field still knows when the reader is inside it. Tabbing between a widget's own parts stays focused; leaving it reads as a blur.

## When a component has more than one root

Vue hands a runtime directive to a component only when that component renders a **single element root**. A component whose template root is a fragment (several sibling nodes, as some combobox and select roots are) never receives the directive at all.

The value channel still works, because that rides the component's props and emits. What you lose is the directive half: the field's `connected` bit, focus tracking, aria, and scroll-to-error. In development, Attaform notices a value arriving from a component it never attached to and points it out, so the gap is loud rather than silent.

The fix is to give the directive a single element to land on:

```vue
<!-- Wrap the fragment-rooted component so v-register binds the wrapper. -->
<div v-register="form.register('country')">
  <FancyCombobox v-model="..." />
</div>
```

or reach for the component's own single-root option if it offers one.

## When the value lives somewhere else

Most Vue components speak the standard `modelValue` / `update:modelValue` contract, and those bind with nothing extra. For the ones that do not, Attaform has a tool sized to each case:

- **A different model name.** A component that emits `value` / `update:value` instead of the standard pair will not see Attaform's `modelValue`. Wrap it in a thin component that maps one to the other, then bind the wrapper. A few lines of composition, and it joins the happy path.
- **A value that is not a DOM property.** A widget that keeps its value on a method, a dataset attribute, or a custom property needs [a custom assigner](/docs/binding-inputs/custom-assigners): a per-element write function that decides what lands in form state.
- **A wrapper you wrote yourself.** When the component is your own and its root is not the input, [`useRegister`](/docs/binding-inputs/use-register) re-binds the parent's `v-register` onto the inner element directly. It is the most direct path whenever you can edit the component.

## Tested against real libraries

Attaform does not formally promise to support every component library in existence. What it offers is a set of careful heuristics, run at the directive and the compile-time transform, that make most standard Vue components bind without ceremony, plus the escape hatches above for the rest.

The demos above run reka-ui and PrimeVue live. Behind them, the cross-library test suite exercises `v-register` against the real rendered output of all three, [reka-ui](https://reka-ui.com), [PrimeVue](https://primevue.org), and [Nuxt UI](https://ui.nuxt.com): single-input fields, spinbuttons, composite PIN inputs, control-less sliders, and fragment-rooted comboboxes each land in the matrix, so the behavior described on this page is pinned, not promised.

## Where to next

- [The `v-register` directive](/docs/binding-inputs/v-register): the directive doing the reaching, and the accessibility it wires.
- [`useRegister`](/docs/binding-inputs/use-register): re-bind `v-register` inside a wrapper component you author.
- [Custom assigners](/docs/binding-inputs/custom-assigners): the write hook for non-standard value surfaces.
- [`injectForm`](/docs/cross-cutting-state/inject-form): for compound components binding several paths at once.
