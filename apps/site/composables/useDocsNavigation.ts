// Hand-curated docs nav — the canonical reading order. The sidebar
// renders these top-to-bottom; the pager (prev/next) walks the
// flattened list in this order; the breadcrumb derives "Docs /
// Section / Page" from this structure.
//
// IA doctrine: one concept per page, ~70 pages total, twelve top-level
// categories that read as a learning narrative top-to-bottom. The first
// link of each category, read in order, is the library's elevator
// pitch — see the rebuild plan for the editorial argument.
//
// Stubbed during the docs rebuild. Phase 1 lands the spine pages
// (Introduction, Quick start, Schema contract, v-register overview,
// validation timing, handleSubmit, persistence overview,
// troubleshooting). Later phases fill in the remaining ~56 pages.

export type DocsLink = { title: string; to: string }
export type DocsSection = { heading: string; links: DocsLink[] }

export const docsNavigation: DocsSection[] = [
  {
    heading: 'Getting started',
    links: [
      { title: 'Introduction', to: '/docs/getting-started/introduction' },
      { title: 'Why Attaform', to: '/docs/getting-started/why-attaform' },
      { title: 'Installation', to: '/docs/getting-started/installation' },
      { title: 'Quick start', to: '/docs/getting-started/quick-start' },
      { title: 'Your first schema', to: '/docs/getting-started/your-first-schema' },
      { title: 'From schema to inputs', to: '/docs/getting-started/from-schema-to-inputs' },
      { title: 'From inputs to submit', to: '/docs/getting-started/from-inputs-to-submit' },
      { title: 'Playgrounds', to: '/play' },
    ],
  },
  // Phase 1 fills in the remaining categories below as each page
  // lands. Empty `links` arrays render the heading as a disabled
  // sidebar group — visually placeholding the IA without surfacing
  // 404-bound URLs.
  {
    heading: 'Schemas',
    links: [
      { title: 'The schema contract', to: '/docs/schemas/contract' },
      { title: 'Defaults from the schema', to: '/docs/schemas/defaults' },
      { title: 'How values are stored', to: '/docs/schemas/storage-shape' },
      { title: 'Optional, nullable, defaulted', to: '/docs/schemas/optional-nullable' },
      { title: 'Discriminated unions', to: '/docs/schemas/discriminated-unions' },
      { title: 'Arrays & tuples', to: '/docs/schemas/arrays-and-tuples' },
      { title: 'Records & maps', to: '/docs/schemas/records' },
      { title: 'Nested objects', to: '/docs/schemas/nested-objects' },
      { title: 'AbstractSchema', to: '/docs/schemas/abstract-schema' },
    ],
  },
  {
    heading: 'Reading the form',
    links: [
      { title: 'The form object', to: '/docs/reading-the-form/the-form-object' },
      { title: 'values', to: '/docs/reading-the-form/values' },
      { title: 'fields', to: '/docs/reading-the-form/fields' },
      { title: 'errors', to: '/docs/reading-the-form/errors' },
      { title: 'meta', to: '/docs/reading-the-form/meta' },
      { title: 'toRef', to: '/docs/reading-the-form/to-ref' },
    ],
  },
  {
    heading: 'Binding inputs',
    links: [
      { title: 'The v-register directive', to: '/docs/binding-inputs/v-register' },
      { title: 'Text, number, textarea', to: '/docs/binding-inputs/text-number-textarea' },
      { title: 'Checkbox', to: '/docs/binding-inputs/checkbox' },
      { title: 'Radio groups', to: '/docs/binding-inputs/radio' },
      { title: 'Select & multi-select', to: '/docs/binding-inputs/select' },
      { title: 'File inputs', to: '/docs/binding-inputs/file' },
      { title: 'Modifiers', to: '/docs/binding-inputs/modifiers' },
      { title: 'Register transforms', to: '/docs/binding-inputs/transforms' },
      { title: 'Custom assigners', to: '/docs/binding-inputs/custom-assigners' },
      { title: 'useRegister', to: '/docs/binding-inputs/use-register' },
      { title: 'Schema-driven coercion', to: '/docs/binding-inputs/coercion' },
    ],
  },
  {
    heading: 'Writing & mutating',
    links: [
      { title: 'setValue patterns', to: '/docs/writing-and-mutating/set-value' },
      { title: 'reset & resetField', to: '/docs/writing-and-mutating/reset' },
      { title: 'clear & blank values', to: '/docs/writing-and-mutating/clear' },
      { title: 'unset — the absent sentinel', to: '/docs/writing-and-mutating/unset' },
      { title: 'Field-array mutations', to: '/docs/writing-and-mutating/field-arrays' },
      { title: 'Variant memory', to: '/docs/writing-and-mutating/variant-memory' },
    ],
  },
  {
    heading: 'Validation',
    links: [
      { title: 'When validation runs', to: '/docs/validation/when-validation-runs' },
      { title: 'Per-field validation', to: '/docs/validation/per-field-validation' },
      { title: 'Async refinements', to: '/docs/validation/async-refinements' },
      { title: 'The validation lifecycle', to: '/docs/validation/lifecycle' },
      { title: 'Showing errors at the right time', to: '/docs/validation/showing-errors' },
      { title: 'The blank field-state bit', to: '/docs/validation/blank' },
    ],
  },
  {
    heading: 'Submitting',
    links: [
      { title: 'handleSubmit', to: '/docs/submitting/handle-submit' },
      { title: 'Server-side errors', to: '/docs/submitting/server-side-errors' },
      { title: 'Focus & scroll on invalid submit', to: '/docs/submitting/focus-scroll' },
    ],
  },
  {
    heading: 'Persistence',
    links: [
      { title: 'Persistence overview', to: '/docs/persistence/overview' },
      { title: 'Storage backends', to: '/docs/persistence/storage-backends' },
      { title: 'Per-field opt-in', to: '/docs/persistence/per-field-opt-in' },
      { title: 'Sensitive-name protection', to: '/docs/persistence/sensitive-names' },
      { title: 'Imperative persistence', to: '/docs/persistence/imperative' },
      { title: 'Edge cases & hydration', to: '/docs/persistence/edge-cases' },
    ],
  },
  {
    heading: 'Cross-cutting state',
    links: [
      { title: 'Undo & redo', to: '/docs/cross-cutting-state/undo-redo' },
      { title: 'Multi-tab sync', to: '/docs/cross-cutting-state/multi-tab-sync' },
      { title: 'injectForm', to: '/docs/cross-cutting-state/inject-form' },
      { title: 'useStepper', to: '/docs/cross-cutting-state/use-stepper' },
      { title: 'App-wide defaults', to: '/docs/cross-cutting-state/app-defaults' },
    ],
  },
  {
    heading: 'Server & SSR',
    links: [
      { title: 'SSR hydration — Nuxt', to: '/docs/server-and-ssr/ssr-nuxt' },
      { title: 'SSR hydration — bare Vue', to: '/docs/server-and-ssr/ssr-bare-vue' },
      { title: 'Parsing API errors', to: '/docs/server-and-ssr/parse-api-errors' },
      { title: 'Performance', to: '/docs/server-and-ssr/performance' },
    ],
  },
  {
    heading: 'DevTools & debugging',
    links: [
      { title: 'The Attaform DevTools panel', to: '/docs/devtools-and-debugging/devtools-panel' },
      { title: 'Vue DevTools integration', to: '/docs/devtools-and-debugging/vue-devtools' },
      { title: 'Troubleshooting', to: '/docs/devtools-and-debugging/troubleshooting' },
    ],
  },
  {
    heading: 'Reference',
    links: [
      { title: 'Types reference', to: '/docs/reference/types' },
      { title: 'Errors reference', to: '/docs/reference/errors' },
      { title: 'Entry-point reference', to: '/docs/reference/entry-points' },
    ],
  },
]

// All links in canonical reading order. Used by the pager (prev/next)
// and any consumer that needs to walk the nav linearly without
// thinking about section grouping.
export const docsLinksFlat: ReadonlyArray<DocsLink> = docsNavigation.flatMap(
  (section) => section.links
)

// Returns the prev/next link for the current route. Composables that
// rely on `useRoute` only work inside Nuxt's reactivity scope — so
// pager components import and call this directly. Returns nulls at
// the start and end of the list.
export function useDocsPagination() {
  const route = useRoute()
  return computed(() => {
    const idx = docsLinksFlat.findIndex((l) => l.to === route.path)
    return {
      prev: idx > 0 ? docsLinksFlat[idx - 1] : null,
      next: idx >= 0 && idx < docsLinksFlat.length - 1 ? docsLinksFlat[idx + 1] : null,
    }
  })
}

// Derives the breadcrumb trail from the current path + the nav
// structure. Always opens with a clickable "Docs" home, then the
// section heading (text only — sections aren't pages), then the
// current page title (text only — we're already there).
export function useDocsBreadcrumb() {
  const route = useRoute()
  return computed(() => {
    const segments: Array<{ label: string; to?: string }> = [{ label: 'Docs', to: '/docs' }]
    for (const section of docsNavigation) {
      const link = section.links.find((l) => l.to === route.path)
      if (link) {
        segments.push({ label: section.heading })
        segments.push({ label: link.title })
        return segments
      }
    }
    return segments
  })
}
