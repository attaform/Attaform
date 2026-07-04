// Link classification shared with ProseA.vue (the markdown <a> renderer).
// Extracted so the non-obvious "is this a static file, not a route?"
// rule carries a fast unit test without mounting the component.

/**
 * True when an href points at a static file the site serves from
 * `public/` (for example `/llms.txt`, `/skill.md`, or a per-page
 * `/docs/foo.md`) rather than a Nuxt route.
 *
 * Such links must render as a plain `<a>`: routed through NuxtLink, Vue
 * Router tries to resolve and prefetch a route that does not exist,
 * which logs "No match found" in dev and wastes a prefetch in prod. Docs
 * routes are extensionless, so a file extension on the last path segment
 * is the tell. Query and hash are ignored.
 */
export function isStaticFilePath(href: string | undefined): boolean {
  if (!href) return false
  const path = href.replace(/[?#].*$/, '')
  return /\/[^/]+\.[a-z0-9]+$/i.test(path)
}
