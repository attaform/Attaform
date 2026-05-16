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
  { heading: 'Getting started', links: [] },
  { heading: 'Schemas', links: [] },
  { heading: 'Reading the form', links: [] },
  { heading: 'Binding inputs', links: [] },
  { heading: 'Writing & mutating', links: [] },
  { heading: 'Validation', links: [] },
  { heading: 'Submitting', links: [] },
  { heading: 'Persistence', links: [] },
  { heading: 'Cross-cutting state', links: [] },
  { heading: 'Server & SSR', links: [] },
  { heading: 'DevTools & debugging', links: [] },
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
