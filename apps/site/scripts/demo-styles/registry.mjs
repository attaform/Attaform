// Single source of truth for docs-demo styling. `codegen.mjs` composes a
// per-demo `styles.css` from `core` (always) plus the fragments a demo names
// in its `styles.json` ({ "with": ["input", "button", ...] }).
//
// Every selector is scoped under `.demo` so a demo's generated stylesheet,
// imported globally by its App.vue, only ever touches that demo's subtree
// (it cannot leak onto the surrounding docs page). The theme is fully
// self-contained: `core` defines its own `--color-*` tokens as resolved
// hexes rather than borrowing the site's, so demos render identically inside
// the playground iframe (which has no site stylesheet) and when copy-pasted
// out. Dark mode keys off the `.dark` ancestor class that @nuxtjs/color-mode
// toggles on the docs page; the playground re-creates that class from
// `prefers-color-scheme` (see DemoReplEditor.client.vue), so one selector
// serves both render paths.
//
// Token values mirror the resolved semantic aliases in
// apps/site/assets/css/tailwind.css (light `@theme`, dark `.dark`). Keep them
// in sync if the site palette moves; the decoupling is deliberate (demos must
// not depend on site tokens), so this is a conscious copy, not an oversight.

export const core = `
.demo {
  --color-bg: #ffffff;
  --color-fg: #101828;
  --color-fg-muted: #475467;
  --color-fg-subtle: #667085;
  --color-surface: #f9fafb;
  --color-surface-2: #f2f4f7;
  --color-surface-3: #eaecf0;
  --color-border: #eaecf0;
  --color-border-strong: #d0d5dd;
  --color-accent: #6938ef;
  --color-accent-hover: #5925dc;
  --color-accent-fg: #ffffff;
  --color-accent-soft: #f4f3ff;
  --color-accent-soft-fg: #5925dc;
  --color-success: #17b26a;
  --color-success-soft: #ecfdf3;
  --color-warning: #f79009;
  --color-warning-soft: #fffaeb;
  --color-danger: #f04438;
  --color-danger-soft: #fef3f2;

  display: flex;
  flex-direction: column;
  gap: 0.875rem;
  max-width: 30rem;
  color: var(--color-fg);
  font-size: 0.875rem;
}

.dark .demo {
  --color-bg: #0c111d;
  --color-fg: #f9fafb;
  --color-fg-muted: #98a2b3;
  --color-fg-subtle: #667085;
  --color-surface: #101828;
  --color-surface-2: #1d2939;
  --color-surface-3: #344054;
  --color-border: #1d2939;
  --color-border-strong: #344054;
  --color-accent: #7a5af8;
  --color-accent-hover: #9b8afb;
  --color-accent-fg: #0c111d;
  --color-accent-soft: #27115f;
  --color-accent-soft-fg: #bdb4fe;
  --color-success: #47cd89;
  --color-success-soft: #074d31;
  --color-warning: #fdb022;
  --color-warning-soft: #7a2e0e;
  --color-danger: #f97066;
  --color-danger-soft: #7a271a;
}
`

// Insertion order here is the emit order in the generated stylesheet, so it
// stays stable regardless of the order a demo lists fragments in.
export const fragments = {
  // Text-like inputs only. The `:where(:not(...))` guard keeps padding and
  // borders off native checkboxes, radios, file, range and colour controls,
  // so a demo that mixes a text field with a checkbox can select `input`
  // without distorting the checkbox. `:where()` adds no specificity, so a
  // demo's own rules still override.
  input: `
.demo input:where(:not([type='checkbox'], [type='radio'], [type='file'], [type='range'], [type='color'])) {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  background: var(--color-bg);
  color: var(--color-fg);
  font-family: inherit;
  font-size: 0.875rem;
}
.demo input:where(:not([type='checkbox'], [type='radio'], [type='file'], [type='range'], [type='color'])):focus {
  outline: 2px solid var(--color-accent);
  outline-offset: -1px;
}
`,

  textarea: `
.demo textarea {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  background: var(--color-bg);
  color: var(--color-fg);
  font-family: inherit;
  font-size: 0.875rem;
  resize: vertical;
}
.demo textarea:focus {
  outline: 2px solid var(--color-accent);
  outline-offset: -1px;
}
`,

  select: `
.demo select {
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  background: var(--color-bg);
  color: var(--color-fg);
  font-family: inherit;
  font-size: 0.875rem;
}
.demo select:focus {
  outline: 2px solid var(--color-accent);
  outline-offset: -1px;
}
`,

  label: `
.demo label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.875rem;
  font-weight: 500;
}
`,

  // Primary submit button. `actions` below restyles buttons that live inside
  // an `.actions` group, so the two compose without fighting.
  button: `
.demo button {
  align-self: flex-start;
  margin-top: 0.25rem;
  padding: 0.625rem 1rem;
  border: 1px solid var(--color-accent);
  border-radius: 0.375rem;
  background: var(--color-accent);
  color: var(--color-accent-fg);
  font-family: inherit;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
}
.demo button:hover {
  background: var(--color-accent-hover);
  border-color: var(--color-accent-hover);
}
.demo button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
`,

  // Secondary button group. The `.demo .actions button` selector outranks the
  // primary `.demo button` rule, so an `.actions` group reads as neutral
  // pills even when `button` is also selected.
  actions: `
.demo .actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.demo .actions button {
  align-self: auto;
  margin-top: 0;
  padding: 0.35rem 0.7rem;
  border: 1px solid var(--color-border-strong);
  border-radius: 0.375rem;
  background: var(--color-bg);
  color: var(--color-fg);
  font-size: 0.75rem;
  font-weight: 500;
}
.demo .actions button:hover:not(:disabled) {
  background: var(--color-surface-2);
}
`,

  fieldset: `
.demo fieldset {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin: 0;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
}
.demo legend {
  padding: 0 0.4rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
`,

  // Inline checkbox/radio row. Overrides `label`'s column direction (higher
  // class count) so a `<label class="row">` lays its control beside the text.
  row: `
.demo .row {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  font-weight: 400;
}
.demo .row input {
  margin: 0;
}
`,

  // Inline checkbox label used for a single toggle (e.g. "make saves fail").
  toggle: `
.demo .toggle {
  flex-direction: row;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.75rem;
  font-weight: 400;
  color: var(--color-fg-subtle);
}
.demo .toggle input {
  width: auto;
  margin: 0;
}
`,

  error: `
.demo em,
.demo .error {
  color: var(--color-danger);
  font-size: 0.8125rem;
  font-style: normal;
  font-weight: 400;
}
`,

  hint: `
.demo .hint {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--color-fg-muted);
}
.demo .hint code {
  padding: 0.05rem 0.3rem;
  border-radius: 0.25rem;
  background: var(--color-surface-2);
  font-family: ui-monospace, monospace;
  font-size: 0.75rem;
}
`,

  lede: `
.demo .lede {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--color-fg-muted);
}
`,

  pre: `
.demo pre {
  margin: 0;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  background: var(--color-surface);
  color: var(--color-fg);
  font-family: ui-monospace, monospace;
  font-size: 0.75rem;
  overflow: auto;
}
`,

  // Status pill with a state modifier (idle/pending/saving/saved/error).
  status: `
.demo .status {
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 500;
}
.demo .status.idle {
  background: var(--color-surface-2);
  color: var(--color-fg-muted);
}
.demo .status.pending {
  background: var(--color-accent-soft);
  color: var(--color-accent-soft-fg);
}
.demo .status.saving {
  background: var(--color-warning-soft);
  color: var(--color-warning);
}
.demo .status.saved {
  background: var(--color-success-soft);
  color: var(--color-success);
}
.demo .status.error {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}
`,

  // Aggregate status banner with a state modifier.
  banner: `
.demo .banner {
  padding: 0.45rem 0.7rem;
  border-radius: 0.375rem;
  font-size: 0.75rem;
  font-weight: 500;
}
.demo .banner.idle {
  background: var(--color-surface-2);
  color: var(--color-fg-muted);
}
.demo .banner.pending {
  background: var(--color-accent-soft);
  color: var(--color-accent-soft-fg);
}
.demo .banner.busy {
  background: var(--color-warning-soft);
  color: var(--color-warning);
}
.demo .banner.saved {
  background: var(--color-success-soft);
  color: var(--color-success);
}
.demo .banner.failed {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}
`,
}
