<script setup lang="ts">
  // Inline demo widget. Renders an `apps/site/docs-demos/<slug>.vue`
  // SFC live above the prose, with an "Open in playground" link that
  // routes readers who want to inspect or edit the source to the
  // standalone /play/<slug> editor.
  //
  // Build-time invariant: every `<DocsDemo slug="...">` referenced in
  // a docs page must resolve to a file in `apps/site/docs-demos/`. A
  // missing file throws at render time, which fails Nuxt's prerender
  // for that page and surfaces in CI before reaching production. The
  // error message names the expected path so authors can react.
  import { computed } from 'vue'
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
  const route = useRoute()
  const playgroundLink = computed(
    () => `/play/${props.slug}?from=${encodeURIComponent(route.path)}`
  )

  // Eager glob: every demo SFC is bundled into the docs chunk. With
  // Phase 1's ~7 demos (Phase 4's ~52) this is acceptable — each SFC
  // shares Attaform / Vue / Zod which are already on the page.
  //
  // Two shapes supported:
  //   - flat:   docs-demos/<slug>.vue              (single-file demo)
  //   - folder: docs-demos/<slug>/App.vue          (multi-file demo)
  // The folder form wins when both exist; companion files inside the
  // folder (FieldRow.vue, etc.) resolve through normal SFC imports at
  // build time, so the glob only needs to find the entry point.
  const flatModules = import.meta.glob<true, '', { default: unknown }>('../../docs-demos/*.vue', {
    eager: true,
  })
  const folderEntries = import.meta.glob<true, '', { default: unknown }>(
    '../../docs-demos/*/App.vue',
    { eager: true }
  )

  const folderEntry = folderEntries[`../../docs-demos/${props.slug}/App.vue`]
  const flatEntry = flatModules[`../../docs-demos/${props.slug}.vue`]
  const componentEntry = folderEntry ?? flatEntry

  if (componentEntry === undefined) {
    throw new Error(
      `[DocsDemo] no demo found for slug "${props.slug}". ` +
        `Expected: apps/site/docs-demos/${props.slug}.vue ` +
        `or apps/site/docs-demos/${props.slug}/App.vue. ` +
        `Author the SFC or remove the <DocsDemo slug="${props.slug}" /> reference.`
    )
  }

  const DemoComponent = componentEntry.default as unknown
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

    <div class="p-6">
      <component :is="DemoComponent" />
    </div>
  </div>
</template>
