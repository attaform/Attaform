<script setup lang="ts">
  // Inline demo widget. Renders an `apps/site/docs-demos/<slug>.vue`
  // SFC as a live preview (default tab), with a Code tab showing the
  // same SFC source — verified-typed because vue-tsc runs against the
  // file — and a link to the standalone /play/<slug> playground.
  //
  // One source of truth per demo: the inline view's SFC and the
  // playground route load the same file. The Code tab pulls from the
  // co-imported `?raw` source, so what readers see is exactly what
  // runs in Preview and what loads in /play.
  //
  // Build-time invariant: every `<DocsDemo slug="...">` referenced in
  // a docs page must resolve to a file in `apps/site/docs-demos/`. A
  // missing file throws at render time, which fails Nuxt's prerender
  // for that page and surfaces in CI before reaching production. The
  // error message names the expected path so authors can react.
  import { computed, ref } from 'vue'
  import { ExternalLink, Eye, Code } from 'lucide-vue-next'

  const props = defineProps<{
    slug: string
  }>()

  // Round-trip path: the playground's "Back to docs" link returns
  // here. Built from the current route so a reader who lands on
  // /docs/getting-started/quick-start and opens the playground sees
  // a back link that actually returns to that page.
  const route = useRoute()
  const playgroundLink = computed(
    () => `/play/${props.slug}?from=${encodeURIComponent(route.path)}`
  )

  // Eager glob: every demo SFC + its raw source is bundled into the
  // docs chunk. With Phase 1's ~7 demos (Phase 4's ~52) this is
  // acceptable — the raw source is plain text (~1–2 KB per demo) and
  // the SFC bundles share Attaform / Vue / Zod which are already on
  // the page. Switching to lazy resolution would buy little and cost
  // <Suspense> boundary management around each tab toggle.
  const modules = import.meta.glob<true, '', { default: unknown }>('../../docs-demos/*.vue', {
    eager: true,
  })
  const sources = import.meta.glob<true, string, string>('../../docs-demos/*.vue', {
    eager: true,
    query: '?raw',
    import: 'default',
  })

  const moduleKey = `../../docs-demos/${props.slug}.vue`
  const componentEntry = modules[moduleKey]
  const sourceText = sources[moduleKey]

  if (componentEntry === undefined || sourceText === undefined) {
    throw new Error(
      `[DocsDemo] no demo found for slug "${props.slug}". ` +
        `Expected: apps/site/docs-demos/${props.slug}.vue. ` +
        `Author the SFC or remove the <DocsDemo slug="${props.slug}" /> reference.`
    )
  }

  const DemoComponent = componentEntry.default as unknown

  // SSR-time syntax highlight via Shiki — same `github-light` / `github-dark`
  // theme pair that @nuxt/content uses for prose code blocks, so the
  // Code tab visually matches every other code block on the page.
  // `useAsyncData` caches the result per slug; client-side hydration
  // reads the cached HTML without re-running the highlighter.
  //
  // The Shiki call runs through `transformerTwoslash`: a Vue-aware
  // twoslasher (`twoslash-vue`) compiles each demo SFC with real
  // TypeScript at SSR time and embeds the resolved hover info — type
  // signatures, JSDoc, inferred return shapes — straight into the
  // emitted HTML as static popovers. Readers get IDE-grade type
  // inference in the Code tab without shipping a single byte of
  // TypeScript or Monaco to the client. Production prerender bakes
  // the result into `_payload.json`, so the cost lives entirely at
  // build time.
  //
  // `onTwoslashError` returns the original source so a single demo's
  // typecheck disagreement falls back to plain Shiki output instead of
  // crashing the page — the warning still surfaces in stderr for the
  // maintainer. Twoslash and vue-tsc occasionally diverge on edge
  // cases; treating the difference as a soft failure beats white-paging
  // the docs.
  //
  // All three packages are dynamically imported so they only resolve
  // server-side — `useAsyncData`'s payload bake means the client never
  // invokes this factory, and the dynamic-import chunks never ship.
  const { data: highlighted } = await useAsyncData(`docs-demo-shiki-${props.slug}`, async () => {
    const [{ codeToHtml }, { transformerTwoslash }, { createTwoslasher }] = await Promise.all([
      import('shiki'),
      import('@shikijs/twoslash'),
      import('twoslash-vue'),
    ])
    return codeToHtml(sourceText, {
      lang: 'vue',
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
      transformers: [
        transformerTwoslash({
          // `twoslash-vue` handles SFC syntax, but the transformer's
          // language filter defaults to `['ts', 'tsx']`. Without `vue`
          // here, `lang: 'vue'` code blocks would be silently skipped
          // — no error, no annotations, no clue.
          langs: ['vue', 'ts', 'tsx'],
          twoslasher: createTwoslasher(),
          // Twoslash spins up its own TypeScript program with its own
          // module-resolution view of the project. Even though the
          // `GlobalDirectives.vRegister` augmentation lives in
          // `attaform`'s published types (see
          // `src/runtime/types/types-api.ts`) and propagates correctly
          // under vue-tsc + strictTemplates, twoslash's standalone
          // program doesn't pick it up through the import graph of a
          // compiled `<script setup>` block. Injecting an extra virtual
          // .d.ts puts the augmentation directly into twoslash's
          // program so `v-register` resolves the same way it does in
          // consumer projects.
          twoslashOptions: {
            extraFiles: {
              'attaform-v-register-augmentation.d.ts': `
                import type { RegisterDirective } from 'attaform'
                declare module 'vue' {
                  interface GlobalDirectives {
                    vRegister: RegisterDirective
                  }
                }
              `,
            },
            // Filter out the @ts-ignore'd auto-import lookup. Volar
            // generates a `// @ts-ignore` line before its directive
            // auto-import probe, but twoslash collects diagnostics
            // before TS applies that suppression — so the 2551 lookup
            // on the setup context bubbles up here even though it
            // never fires under vue-tsc.
            filterNode: (n) => !(n.type === 'error' && n.code === 2551 && /vRegister/.test(n.text)),
          },
          onTwoslashError: (error, code, lang) => {
            // eslint-disable-next-line no-console
            console.error(
              `[DocsDemo] twoslash failed on slug "${props.slug}" (lang=${lang}):`,
              error instanceof Error ? error.message : error
            )
            // Return the original source so Shiki falls back to a plain
            // (non-annotated) highlight instead of leaving the Code tab
            // empty when twoslash hits a real error.
            return code
          },
        }),
      ],
    })
  })

  const activeTab = ref<'preview' | 'code'>('preview')
</script>

<template>
  <div class="not-prose my-6 overflow-hidden rounded-xl border border-border bg-bg shadow-sm">
    <!-- Tab strip + playground link. Tabs hug the left edge; the
         playground link hugs the right. Both share the same chrome
         strip so the eye reads them as a single control row. -->
    <div class="flex items-center justify-between border-b border-border bg-surface/40 px-3">
      <div role="tablist" class="flex gap-1">
        <button
          role="tab"
          type="button"
          class="inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-semibold tracking-wide uppercase transition-colors duration-(--duration-fast)"
          :aria-selected="activeTab === 'preview'"
          :class="
            activeTab === 'preview'
              ? 'border-accent text-fg'
              : 'border-transparent text-fg-subtle hover:text-fg'
          "
          @click="activeTab = 'preview'"
        >
          <Eye class="h-3.5 w-3.5" :stroke-width="2" />
          Preview
        </button>
        <button
          role="tab"
          type="button"
          class="inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-semibold tracking-wide uppercase transition-colors duration-(--duration-fast)"
          :aria-selected="activeTab === 'code'"
          :class="
            activeTab === 'code'
              ? 'border-accent text-fg'
              : 'border-transparent text-fg-subtle hover:text-fg'
          "
          @click="activeTab = 'code'"
        >
          <Code class="h-3.5 w-3.5" :stroke-width="2" />
          Code
        </button>
      </div>

      <NuxtLink
        :to="playgroundLink"
        class="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-fg-subtle transition-colors duration-(--duration-fast) hover:text-fg"
      >
        Open in playground
        <ExternalLink class="h-3.5 w-3.5" :stroke-width="2" />
      </NuxtLink>
    </div>

    <!-- Preview pane. SSR-mounted; client hydrates to interactive.
         `v-show` (not v-if) keeps the SFC's reactivity alive across
         tab toggles — switching to Code and back returns the form in
         whatever state the reader left it in. -->
    <div v-show="activeTab === 'preview'" class="p-6">
      <component :is="DemoComponent" />
    </div>

    <!-- Code pane. SSR-highlighted HTML via Shiki — no client cost.
         `v-html` is safe: the source is bundled at build time (the
         SFC ships in the repo, not from user input) and Shiki output
         is structural — spans with class tokens, no scripts. -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div
      v-show="activeTab === 'code'"
      class="docs-demo-code overflow-x-auto"
      v-html="highlighted ?? ''"
    />
  </div>
</template>

<style>
  /* Match the prose code-block chrome from `pages/docs/[...slug].vue`
     so a docs page's inline Code tab visually matches the H2-and-prose
     code blocks above and below it. github-light / github-dark themes
     paint the spans; this block sets the surrounding plate. */
  .docs-demo-code pre {
    margin: 0;
    padding: 1.25rem 1.5rem;
    font-size: 0.875rem;
    line-height: 1.6;
    overflow-x: auto;
    background: var(--color-gray-50);
  }
  .dark .docs-demo-code pre {
    background: var(--color-gray-950);
  }
</style>
