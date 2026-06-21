<script setup lang="ts">
  // Inline demo widget. Renders an `apps/site/docs-demos/<slug>.vue`
  // SFC live above the prose, with an "Open in playground" link that
  // routes readers who want to inspect or edit the source to the
  // standalone /demos/<slug> editor.
  //
  // Build-time invariant: every `<DocsDemo slug="...">` referenced in
  // a docs page must resolve to a file in `apps/site/docs-demos/`. A
  // missing file throws at render time, which fails Nuxt's prerender
  // for that page and surfaces in CI before reaching production. The
  // error message names the expected path so authors can react.
  import { computed, defineAsyncComponent, type Component } from 'vue'
  import { ExternalLink } from 'lucide-vue-next'

  const props = withDefaults(
    defineProps<{
      slug: string
      label?: string
    }>(),
    { label: 'Demo' }
  )

  // Round-trip path: the playground's "Back to docs" link returns
  // here. Built from the current route so a reader who lands on
  // /docs/getting-started/quick-start and opens the playground sees
  // a back link that actually returns to that page.
  //
  // `/` is allowed inside query components per RFC 3986 §3.4, so we
  // un-encode it after `encodeURIComponent` to keep the URL legible
  // and avoid the link-checker's `no-uppercase-chars` warning on
  // `%2F` escape sequences. Anything else that would actually break a
  // query string (`&`, `=`, `+`, `#`, raw spaces, non-ASCII) stays
  // encoded for future routes that might contain those characters.
  const route = useRoute()
  const playgroundLink = computed(
    () => `/demos/${props.slug}?from=${encodeURIComponent(route.path).replace(/%2F/gi, '/')}`
  )

  // Lazy per-slug load. `import.meta.glob` without `eager` still yields the
  // full slug -> dynamic-importer map at build time, so the existence check
  // below resolves synchronously and a missing demo still fails the page's
  // prerender. Only the matched demo's SFC, with its styles.css and any
  // third-party deps, is fetched, on the page that embeds it.
  //
  // Eager-loading every demo pulled all ~60 stylesheets onto every docs page,
  // so one demo's element rules (`.demo button`, `.demo input`) bled onto
  // another demo's controls, and unrelated demos' deps (reka-ui, PrimeVue)
  // rode along into every page chunk. Lazy loading scopes each page to just
  // the demos it renders. `defineAsyncComponent` resolves during SSR (awaited
  // inside the page's Suspense boundary), so demos still prerender.
  //
  // Lazy loading alone does not stop the element-rule bleed: a demo's
  // stylesheet, once injected, stays in the document and accumulates as the
  // reader navigates between docs pages, so a later demo's `.demo button`
  // still reaches an earlier demo's buttons. The host element below carries a
  // per-demo `demo-<slug>` class that the generated stylesheet scopes every
  // rule to (see scripts/demo-styles/codegen.mjs), so each demo's styles can
  // only touch its own subtree no matter what else is loaded.
  //
  // Two shapes supported:
  //   - flat:   docs-demos/<slug>.vue              (single-file demo)
  //   - folder: docs-demos/<slug>/App.vue          (multi-file demo)
  // The folder form wins when both exist; companion files inside the folder
  // (FieldRow.vue, etc.) resolve through normal SFC imports, so the glob only
  // needs to find the entry point.
  const flatImporters = import.meta.glob<{ default: Component }>('../../docs-demos/*.vue')
  const folderImporters = import.meta.glob<{ default: Component }>('../../docs-demos/*/App.vue')

  const importer =
    folderImporters[`../../docs-demos/${props.slug}/App.vue`] ??
    flatImporters[`../../docs-demos/${props.slug}.vue`]

  if (importer === undefined) {
    throw new Error(
      `[DocsDemo] no demo found for slug "${props.slug}". ` +
        `Expected: apps/site/docs-demos/${props.slug}.vue ` +
        `or apps/site/docs-demos/${props.slug}/App.vue. ` +
        `Author the SFC or remove the <DocsDemo slug="${props.slug}" /> reference.`
    )
  }

  const DemoComponent = defineAsyncComponent(importer)
</script>

<template>
  <div class="not-prose my-6 overflow-hidden rounded-xl border border-border bg-bg shadow-sm">
    <div class="flex items-center justify-between border-b border-border bg-surface/40 px-3">
      <span class="px-3 py-2 text-xs font-semibold text-fg">{{ props.label }}</span>
      <NuxtLink
        :to="playgroundLink"
        class="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-fg-subtle transition-colors duration-(--duration-fast) hover:text-fg"
      >
        Open in playground
        <ExternalLink class="h-3.5 w-3.5" :stroke-width="2" />
      </NuxtLink>
    </div>

    <div class="p-6" :class="`demo-${props.slug}`">
      <component :is="DemoComponent" />
    </div>
  </div>
</template>
