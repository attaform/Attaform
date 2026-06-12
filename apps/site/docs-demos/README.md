# Docs demo styles

Every demo under `apps/site/docs-demos/` is a folder:

```
docs-demos/
  <slug>/
    App.vue       # the demo (committed)
    styles.json   # which shared style fragments it pulls in (committed)
    styles.css    # generated, gitignored, never edit by hand
```

Styling is built once from a single source so a demo renders identically in two
places: inline on the docs page (SSR / prerendered) and inside the playground
iframe (which carries no site stylesheet). Demos stay decoupled from the site's
design tokens, so opening one in the playground, or copy-pasting it out, never
leaves an undefined `var(--...)` behind.

## How it works

`scripts/demo-styles/registry.mjs` is the single source of truth. It exports:

- `core`: the demo's own semantic tokens (resolved hexes under a `.demo` root,
  plus a `.dark .demo` block for dark mode) and the base container. Always
  included.
- `fragments`: a `name -> css` map. Every selector is scoped under `.demo`.

`scripts/demo-styles/codegen.mjs` reads each `<slug>/styles.json`, validates the
names against `fragments` (an unknown name throws, naming the valid set), and
writes `<slug>/styles.css` as `core` plus the named fragments in registry order.
`App.vue` does a plain `import './styles.css'`, which Vite extracts on the
inline path and the REPL injects on the playground path.

Codegen runs automatically in `dev`, `build`, `generate`, and the test
`globalSetup`. To regenerate by hand:

```
node apps/site/scripts/demo-styles/codegen.mjs
```

The generated `styles.css` is gitignored. If your editor flags the
`import './styles.css'` on a fresh checkout, run that command once.

## Authoring a demo

1. Give the root element `class="demo"`. For a grid root, add `layout` (and
   `split` / `split3`), e.g. `class="demo layout split"`.
2. Reach for the shared markup vocabulary: `<label>`, `<input>`, `<button>`,
   `<button class="ghost">` / `class="primary"`, `<p class="hint">`, `<pre>`
   for JSON / state readouts, `<span class="badge valid">`, and so on.
3. List the fragments you use in `styles.json`:

   ```json
   { "with": ["label", "input", "button", "error", "hint"] }
   ```

   The names are the keys of `fragments` in `registry.mjs`. Read that file for
   the current set: the comment above each fragment says what it styles and how
   the variants compose. `core` is implicit, never list it.

## Colors

Reference the demo's own tokens, never the site's. The families are `fg` /
`fg-muted` / `fg-subtle`, `bg`, `surface` / `surface-2` / `surface-3`, `border`
/ `border-strong`, `accent` (with `-hover` / `-fg` / `-soft` / `-soft-fg`), and
`success` / `warning` / `danger` (each with a `-soft` companion). They flip for
dark mode in one place (`core`), so any fragment that uses them is
theme-adaptive for free. See the `core` block in `registry.mjs` for the full
list.

## Bespoke styling (the escape hatch)

If a demo needs something no fragment provides, and no other demo shares it,
keep a small residual `<style scoped>` in its `App.vue`. Scope each rule under
`.demo`, reference `var(--color-*)` tokens, and for an off-palette pedagogical
color define demo-local custom properties with a `:global(.dark) .demo ...`
override (see `use-register` and `step-slots` for the pattern).

If two or more demos would carry the same bespoke rule, add a fragment to
`registry.mjs` and name it from both `styles.json` files instead. Shared
styling lives in the registry; only genuinely one-off styling lives in a demo.
