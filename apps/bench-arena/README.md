# bench-arena

A fair, reproducible, cross-library benchmark for Vue form libraries. It
measures Attaform against the current Vue form-library field in a real browser
(Playwright) across a suite of practical form shapes, and emits a
provenance-stamped `results.json` that the documentation renders directly.

The goal is credibility, not a victory lap. The harness holds the rendered DOM
constant, normalizes triggers, pins one validator version across every entry
that can take it, and reports where Attaform is heavier as plainly as where it
is faster. Every number on the docs page links back to the exact CI run that
produced it.

## The committed numbers come from CI

`results.json` is committed to the repository so the docs can render without a
network call, but **the authoritative copy is always written by CI** on a clean
Ubuntu runner. A local run is for development and sanity-checking; its numbers
should never be committed as the published set. The provenance block in
`results.json` records which run produced it (commit, CI run URL, runner, Node
version, resolved library versions).

## Running it locally

The arena consumes the real published Attaform build, so build it first from
the repo root:

```sh
pnpm prepack                                   # build dist/*.mjs
pnpm --filter attaform-bench-arena exec playwright install chromium
pnpm --filter attaform-bench-arena run arena   # build + drive + write results.json
```

To probe a single cell by hand, run the harness app and open a parameterized
URL:

```sh
pnpm --filter attaform-bench-arena dev
# then open, e.g.:
#   http://localhost:4173/?adapter=attaform&scenario=flat&params=F50&trigger=input&dim=keystroke
```

## The cohort

Attaform is measured against libraries grouped by what layer they own, because
that is the only fair way to compare them. The harness owns the inputs for the
headless libraries so the DOM is identical; libraries that render their own
inputs are measured in their idiomatic mode and labeled as such.

See the documentation's Benchmarks page for the full methodology, the
capability matrix, and the live results.

## Found a fairer setup?

The adapters live in `src/adapters/`. If you can express a library more
idiomatically, or more fairly, open a PR against its adapter. The whole point
is a benchmark the community trusts.
