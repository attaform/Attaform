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
      { title: 'Quick start', to: '/docs/getting-started/quick-start' },
      { title: 'Installation', to: '/docs/getting-started/installation' },
      { title: 'Your first schema', to: '/docs/getting-started/your-first-schema' },
      { title: 'From schema to inputs', to: '/docs/getting-started/from-schema-to-inputs' },
      { title: 'From inputs to submit', to: '/docs/getting-started/from-inputs-to-submit' },
    ],
  },
  // Phase 1 fills in the remaining categories below as each page
  // lands. Empty `links` arrays render the heading as a disabled
  // sidebar group — visually placeholding the IA without surfacing
  // 404-bound URLs.
  { heading: 'Schemas', links: [] },
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
    ],
  },
  {
    heading: 'Validation',
    links: [
      { title: 'When validation runs', to: '/docs/validation/when-validation-runs' },
      { title: 'Showing errors at the right time', to: '/docs/validation/showing-errors' },
    ],
  },
  {
    heading: 'Submitting',
    links: [{ title: 'handleSubmit', to: '/docs/submitting/handle-submit' }],
  },
  {
    heading: 'Persistence',
    links: [{ title: 'Persistence overview', to: '/docs/persistence/overview' }],
  },
  { heading: 'Cross-cutting state', links: [] },
  { heading: 'Server & SSR', links: [] },
  {
    heading: 'DevTools & debugging',
    links: [{ title: 'Troubleshooting', to: '/docs/devtools-and-debugging/troubleshooting' }],
  },
  { heading: 'Reference', links: [] },
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
