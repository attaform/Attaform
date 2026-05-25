<script setup lang="ts">
  // Standalone playground for one `apps/site/docs-demos/<slug>.vue`
  // SFC. The route loads the matching SFC source via Vite's `?raw`
  // query and seeds it into the editor, sharing one source of truth
  // with the inline <DocsDemo>; a reader's "Open in playground" link
  // arrives in an editor preloaded with exactly what they saw on the
  // docs page.
  //
  // Per plan §3, the page also surfaces a "Back to docs" link that
  // returns to the page hosting the inline demo. The originating
  // path travels through the `from` query parameter set by
  // <DocsDemo>; values that don't start with `/docs/` are dropped to
  // close the open-redirect angle. When no `from` is supplied (a
  // direct visit to /demos/<slug>), the back link points at the
  // demos index.
  import { computed } from 'vue'
  import { ArrowLeft, ArrowUpRight } from 'lucide-vue-next'

  const route = useRoute()
  const slug = computed(() => String(route.params['slug'] ?? ''))

  // Eager glob: ships every demo's raw source in the page chunk.
  // Lazy resolution is technically possible but buys little. The
  // raw source is plain text (~1–2 KB) and the playground is
  // already loading the heavyweight @vue/repl + Monaco bundle.
  //
  // Two shapes supported, mirroring DocsDemo's resolution:
  //   - flat:   docs-demos/<slug>.vue
  //   - folder: docs-demos/<slug>/{App,Foo,Bar}.vue
  // The folder form wins when both exist; every .vue inside the
  // folder seeds into the REPL store under src/, preserving the
  // import path so `import Foo from './Foo.vue'` keeps resolving.
  const flatSources = import.meta.glob<true, string, string>('../../docs-demos/*.vue', {
    eager: true,
    query: '?raw',
    import: 'default',
  })
  const folderSources = import.meta.glob<true, string, string>('../../docs-demos/*/*.vue', {
    eager: true,
    query: '?raw',
    import: 'default',
  })

  // Build the file map the REPL editor will seed. Folder demos
  // produce `{ 'src/App.vue': ..., 'src/FieldRow.vue': ... }`; flat
  // demos collapse to `{ 'src/App.vue': ... }`. The REPL store also
  // accepts a single entry, so the single-file case stays simple.
  const initialFiles = computed<Record<string, string> | undefined>(() => {
    const folderPrefix = `../../docs-demos/${slug.value}/`
    const folderFiles: Record<string, string> = {}
    for (const [key, source] of Object.entries(folderSources)) {
      if (key.startsWith(folderPrefix)) {
        const name = key.slice(folderPrefix.length)
        folderFiles[`src/${name}`] = source
      }
    }
    if (Object.keys(folderFiles).length > 0) return folderFiles

    const flat = flatSources[`../../docs-demos/${slug.value}.vue`]
    if (flat !== undefined) return { 'src/App.vue': flat }
    return undefined
  })

  if (!initialFiles.value) {
    throw createError({
      statusCode: 404,
      statusMessage: `No demo for slug "${slug.value}"`,
      fatal: true,
    })
  }

  // Display name for the "Editing apps/site/docs-demos/..." inline
  // code on the page header. Folder demos point at the directory;
  // flat demos point at the single file.
  const sourceLabel = computed(() => {
    const folderPrefix = `../../docs-demos/${slug.value}/`
    const hasFolder = Object.keys(folderSources).some((k) => k.startsWith(folderPrefix))
    return hasFolder ? `${slug.value}/` : `${slug.value}.vue`
  })

  function formatTitle(value: string): string {
    return value
      .split('-')
      .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
      .join(' ')
  }

  const title = computed(() => formatTitle(slug.value))

  useHead(() => ({ title: `${title.value} demo` }))
  useSeoMeta({
    description: () =>
      `Edit the "${title.value}" Attaform demo live; the same source you saw on the docs, opened in a standalone editor.`,
  })

  // Sanitize the back-to-docs URL: accept only paths that resolve
  // inside the docs tree. Anything else (an external URL, a non-docs
  // path) falls back to the demos index.
  const backLink = computed<{ to: string; label: string }>(() => {
    const from = route.query['from']
    if (typeof from === 'string' && from.startsWith('/docs/')) {
      return { to: from, label: 'Back to docs' }
    }
    return { to: '/demos', label: 'Back to demos' }
  })
</script>

<template>
  <div class="relative isolate overflow-hidden">
    <UiContainer size="xl">
      <div class="py-12">
        <div class="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div class="max-w-3xl">
            <p class="text-sm font-semibold tracking-wide text-accent uppercase">Demo</p>
            <h1 class="mt-3 text-display-md font-semibold text-fg">{{ title }}</h1>
            <p class="mt-4 text-sm text-fg-muted">
              Editing <UiInlineCode>apps/site/docs-demos/{{ sourceLabel }}</UiInlineCode
              >. The playground is a self-contained sandbox: source edits and form state stay local
              to this tab so you can experiment freely. To see cross-tab features in action
              (multi-tab sync, persistence across reloads), open the inline demo on the docs page in
              two browser tabs.
            </p>
          </div>
          <div class="flex items-center gap-3 text-sm">
            <NuxtLink
              :to="backLink.to"
              class="inline-flex items-center gap-1.5 text-fg-muted transition-colors duration-(--duration-fast) hover:text-fg"
            >
              <ArrowLeft class="h-3.5 w-3.5" :stroke-width="2" />
              {{ backLink.label }}
            </NuxtLink>
            <NuxtLink
              to="/demos"
              class="inline-flex items-center gap-1.5 text-fg-muted transition-colors duration-(--duration-fast) hover:text-fg"
            >
              All demos
              <ArrowUpRight class="h-3.5 w-3.5" :stroke-width="2" />
            </NuxtLink>
          </div>
        </div>

        <DemoRepl height="calc(100vh - 16rem)" :initial-files="initialFiles" />
      </div>
    </UiContainer>
  </div>
</template>
