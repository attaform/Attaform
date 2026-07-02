<script setup lang="ts">
  // Standalone playground for one `apps/site/docs-demos/<slug>.vue`
  // SFC. The route loads the matching SFC source via Vite's `?raw`
  // query and seeds it into the editor, sharing one source of truth
  // with the inline <DocsDemo>; a reader's "Open in playground" link
  // arrives in an editor preloaded with exactly what they saw on the
  // docs page.
  //
  // Per plan section 3, the page also surfaces a "Back to docs" link
  // that returns to the page hosting the inline demo. The originating
  // path travels through the `from` query parameter set by
  // <DocsDemo>; values that don't start with `/docs/` are dropped to
  // close the open-redirect angle. When no `from` is supplied (a
  // direct visit to /demos/<slug>), the back link points at the
  // demos index.
  import { computed } from 'vue'
  import { ArrowLeft, ArrowUpRight } from 'lucide-vue-next'

  const route = useRoute()
  const slug = computed(() => String(route.params['slug'] ?? ''))

  // Lazy globs: the keys (every demo's path) are known at build time, so the
  // slug-existence check and `sourceLabel` below resolve synchronously, but a
  // demo's raw source is fetched only when its own playground is opened.
  // Eager loading shipped every demo's source in every playground page's
  // chunk, the source-text twin of the styles.css collision DocsDemo had.
  //
  // Two shapes supported, mirroring DocsDemo's resolution:
  //   - flat:   docs-demos/<slug>.vue
  //   - folder: docs-demos/<slug>/{App.vue, FieldRow.vue, schema.ts, styles.css}
  // The folder form wins when both exist; every supported file inside the
  // folder seeds into the REPL store under src/, preserving the import path so
  // `import Foo from './Foo.vue'`, `import { schema } from './schema'`, and
  // `import './styles.css'` all keep resolving without explicit extensions.
  const flatImporters = import.meta.glob<false, string, string>('../../docs-demos/*.vue', {
    query: '?raw',
    import: 'default',
  })
  const folderImporters = import.meta.glob<false, string, string>(
    '../../docs-demos/*/*.{vue,ts,js,css}',
    {
      query: '?raw',
      import: 'default',
    }
  )

  function folderEntriesFor(slugValue: string): [string, () => Promise<string>][] {
    const prefix = `../../docs-demos/${slugValue}/`
    return Object.entries(folderImporters).filter(([key]) => key.startsWith(prefix))
  }

  // Synchronous existence check from the glob keys (built at compile time), so
  // an unknown slug still returns a real 404 during SSR before any source is
  // fetched.
  const exists =
    folderEntriesFor(slug.value).length > 0 || `../../docs-demos/${slug.value}.vue` in flatImporters
  if (!exists) {
    throw createError({
      statusCode: 404,
      statusMessage: `No demo for slug "${slug.value}"`,
      fatal: true,
    })
  }

  // Display name for the "Editing apps/site/docs-demos/..." inline code on the
  // page header. Folder demos point at the directory; flat demos at the single
  // file. Reads glob keys only, so it stays synchronous.
  const sourceLabel = computed(() =>
    folderEntriesFor(slug.value).length > 0 ? `${slug.value}/` : `${slug.value}.vue`
  )

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

  // Fetch only the matched demo's source(s) and build the REPL's seed file
  // map. Folder demos produce `{ 'src/App.vue': ..., 'src/schema.ts': ... }`;
  // flat demos collapse to `{ 'src/App.vue': ... }`. `useAsyncData` resolves
  // during SSR, so one slug's source lands in this page's payload (not all of
  // them in the shared chunk), and re-runs when the route slug changes.
  //
  // The key MUST carry the slug. `useAsyncData` stores one payload per key, so
  // a constant key would make every `/demos/<slug>` route share a single cache
  // entry: remounting the page (navigating out to the demos index and back
  // into a different demo, say) replays whichever demo populated the key first,
  // because a fresh mount reads `getCachedData` before `watch` can react.
  // Per-slug keys mirror the docs route's `content-${route.path}`.
  const { data: initialFiles } = await useAsyncData(
    `playground-demo-files:${slug.value}`,
    async (): Promise<Record<string, string>> => {
      const folderEntries = folderEntriesFor(slug.value)
      if (folderEntries.length > 0) {
        const prefix = `../../docs-demos/${slug.value}/`
        const files = await Promise.all(
          folderEntries.map(async ([key, importer]) => {
            const source = await importer()
            return [`src/${key.slice(prefix.length)}`, source] as const
          })
        )
        return Object.fromEntries(files)
      }
      const flat = flatImporters[`../../docs-demos/${slug.value}.vue`]
      return flat ? { 'src/App.vue': await flat() } : {}
    },
    { watch: [slug] }
  )

  // `useAsyncData` types `data` as `T | null`; the editor prop wants
  // `Record<string, string> | undefined`.
  const replFiles = computed(() => initialFiles.value ?? undefined)
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
              >. The playground runs in your browser and saves your source edits on this device, so
              a refresh or a stray back-swipe won't lose your work. Use Reset below the editor to
              restore the original.
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

        <DemoRepl
          height="calc(100vh - 16rem)"
          :initial-files="replFiles"
          :scope-slug="slug"
          :persist-key="`demo:${slug}`"
        />
      </div>
    </UiContainer>
  </div>
</template>
