---
title: Benchmarks
description: 'How Attaform compares across the Vue form-library field: bundle size, supply-chain scores, and per-scenario runtime measured in a real browser, every number traced to the run that produced it.'
metaRows:
  - label: Category
    value: Comparison
  - label: Method
    value: Playwright, real Chromium
  - label: Provenance
    value: committed results.json
---

# Benchmarks

> How Attaform holds up across the Vue form-library field on the same demanding forms, measured in a real browser. Bundle size, supply-chain health, and per-scenario runtime, with every number traced to the run that produced it.

::docs-meta-table
::

This page is an honest scoreboard. The numbers come from `apps/bench-arena`, a self-contained harness that drives every library through identical scenarios in real Chromium via Playwright, then writes one provenance-stamped `results.json` that this page renders directly. Nothing is hand-entered. Where Attaform leads, the run says so; where it pays a cost, the run says that too. Both ship from the same green run.

## How to read this

A fair cross-library comparison has to account for the fact that these libraries do different amounts of work. The harness handles that with a few rules:

- **Layers are the fairness axis.** Form-state libraries (Attaform among them) own reactive values, validation, and input binding. Validation-only libraries own validation against state you wire yourself. A batteries-included library renders its own inputs. Each row is labeled with its layer, so a validation-only engine mounting faster than a full form-state library is read as owning less, not as winning.
- **The DOM is held constant.** Every headless library drives the same bare `<input>` markup over the same field count and the same schema, so a runtime number reflects the library's own machinery, not its choice of components.
- **Every library runs in its fastest idiomatic configuration.** Debounces are neutralized, validation triggers are normalized, and array and union primitives use each library's native fast path. Attaform is measured on its shipping default, strict mode, never a relaxed setting.
- **Real builds, pinned validators.** Attaform is consumed as its published `dist`, the same artifact an installer gets, minified in the same build as every other library. Zod v3 is pinned across the Zod-capable cohort.
- **Numbers normalize two ways.** A _ratio_ compares each library to Attaform at the same size. A _slope_ compares a library to itself at the scenario's smallest size, so the shape of growth survives a change of machine.

The harness, every adapter, and the scenario generators live in [`apps/bench-arena`](https://github.com/attaform/Attaform/tree/main/apps/bench-arena). Found a fairer configuration for a library? The adapters are small and the README invites a pull request.

## What it costs to adopt

Before any runtime number, three figures decide whether a library is worth reaching for: what it can express, what it adds to your bundle, and how its supply chain scores.

### Capability coverage

What each library expresses as a first-class primitive versus composes by hand. A gap here becomes honest expressiveness data, never a rigged timing loss: a shape a library cannot express idiomatically is left out of its runtime rows rather than forced into a slow number.

::bench-arena{dimension="capabilities"}
::

### Bundle size

Attaform is the heaviest in the cohort. That is the cost of shipping reactive form state, schema validation binding, persistence, undo and redo, and a multi-step wizard in one zero-dependency package, and it is the honest price of admission. The figure is the full bundle; an app that route-splits its forms pulls less on a first paint.

::bench-arena{dimension="bundle"}
::

### Supply-chain health

The [OpenSSF Scorecard](https://scorecard.dev) rates a project's adoption of supply-chain practices: branch protection, signed releases, pinned dependencies, CI hardening, and more. For a form library headed into an audited setting, that posture is part of the cost of adoption, so the benchmark stamps each project's current score alongside the size and runtime figures.

::bench-arena{dimension="scorecard"}
::

## Typing into a form

### Keystroke latency

The headline interaction. A keystroke runs the value write, validation, and the re-render it triggers. On a flat form Attaform clears a 60 fps frame budget with room to spare.

::bench-arena{scenario="flat" dimension="keystroke"}
::

At five thousand fields the picture tightens. The harness reports where Attaform lands plainly, and it is a scenario worth a future look.

::bench-arena{scenario="massive" dimension="keystroke"}
::

### Re-render scope

Editing one cell of a large grid should re-render one field, not the form. Configured optimally, the modern headless cohort all reaches that bound, and there is no lower number to beat.

::bench-arena{scenario="grid" dimension="rerender"}
::

## Standing up a form

### Mounting a large form

Building a two-thousand-field form from scratch is where the form-state libraries separate. Attaform mounts the whole reactive tree, validation wiring included, every value and validation path live before the first paint.

::bench-arena{scenario="massive" dimension="mount"}
::

### Memory

Retained heap after mount, the library's reactive and validation state at scenario size. Churn is the per-cycle allocation pressure, and leak is the residual across mount and teardown cycles. The sparkline traces retained heap across the measured cycles.

::bench-arena{scenario="massive" dimension="memory"}
::

## Working the harder shapes

### Validation throughput

A full-form validation pass over a massive form, the cost of a submit on the largest shape in the suite.

::bench-arena{scenario="massive" dimension="validate"}
::

### Discriminated unions

Writing into and flipping between variants of a discriminated union. Attaform walks only the active branch, so a variant flip touches the branch in play rather than every alternative.

::bench-arena{scenario="discriminated-union" dimension="variantFlip"}
::

### Dynamic arrays

Appending and reordering rows in a growing list. Attaform's array helpers copy the target array before mutating, which keeps reads fast and identity stable but shows up as real cost on a reorder at a hundred rows. It is an honest line on the board.

::bench-arena{scenario="arrays" dimension="arrayAdd"}
::

::bench-arena{scenario="arrays" dimension="arrayReorder"}
::

### Multi-step wizard

Most of the cohort has no wizard primitive and composes a multi-step flow by hand, so this is an expressiveness comparison as much as a timing one. Where a comparable step transition exists, here is its cost; Attaform's `useWizard` ships the flow as a first-class shape.

::bench-arena{scenario="wizard" dimension="stepTransition"}
::

## Caveats

The methodology is only as good as what it admits.

- **FormKit owns its inputs.** It cannot drive the shared bare field, so its re-render figure is a DOM-mutation proxy, marked in the tables, and its mount and memory figures include its own component tree. It is labeled batteries-included throughout and never placed silently beside bare-input libraries.
- **Heap is Chromium-quantized.** `usedJSHeapSize` reports rounded magnitudes, not byte-exact values, so memory figures show whole kilobytes and the slope across sizes carries more signal than any single number.
- **Every cell shares one time budget.** Each measured cell gets the same per-cell ceiling on the CI runner, identical for every library. A cell that cannot settle to a stable median inside it (a single mount of thousands of fields, or a full-form validation at the largest sizes on the heaviest libraries) is recorded as "did not finish" rather than dropped or estimated. The ceiling is uniform across the cohort, so it marks where a shape outgrows one measurement window, never a verdict on a library.
- **Bundle is total, not first-paint.** Every figure is the full minified and gzipped cost with the validator weighed in. Vue is external, since every app ships it once. Code-splitting changes what a first paint actually pulls.
- **An absent score has two distinct meanings.** "Not published" means a project has not opted into a Scorecard, which is a choice and not a deficiency. "Unavailable" means the lookup did not complete on that run, a network gap on our side and never a statement about the project. The viewer linked on each row shows the live result either way, and scores are point-in-time.
- **Local versus CI.** The committed numbers come from CI on a fixed runner. A figure stamped "local run" is illustrative shape data from a developer machine, superseded the next time CI refreshes the page.

## Reproduce it yourself

The harness is meant to be run by hand. Clone the repo, build Attaform's real `dist` with `pnpm prepack`, then from `apps/bench-arena` install the browser and run the arena. The full instructions live in the [bench-arena README](https://github.com/attaform/Attaform/tree/main/apps/bench-arena). Every adapter mounts by query parameter, so you can also open a single library and scenario in a browser and watch it work.

## Where to next

- [Performance](/docs/server-and-ssr/performance): Attaform's own hot-path numbers, measured against a per-PR regression gate.
- [How values are stored](/docs/schemas/storage-shape): the slim write shape behind the keystroke and validation figures.
- [Field-array mutations](/docs/writing-and-mutating/field-arrays): the array-helper characteristics behind the dynamic-array rows.
