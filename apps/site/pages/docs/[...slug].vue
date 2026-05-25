<script setup lang="ts">
  import { computed, provide } from 'vue'
  import { PencilLine, ArrowUpRight, TriangleAlert } from 'lucide-vue-next'

  definePageMeta({ layout: 'docs' })

  const route = useRoute()

  // Maps `/docs/recipes/transforms` → repo path `docs/recipes/transforms.md`
  // → GitHub edit URL on `main`. The /edit/main/ link drops the
  // visitor straight into the in-browser editor with the right file
  // open (anonymous viewers see a "fork to edit" prompt; signed-in
  // contributors get the editor immediately).
  const editUrl = computed(
    () => `https://github.com/attaform/attaform/edit/main${route.path.replace('/docs', '/docs')}.md`
  )

  const { data: page } = await useAsyncData(`content-${route.path}`, () =>
    queryCollection('docs').path(route.path).first()
  )

  // Missing-page handling: degrade in-page rather than fatal-throw.
  //
  // Previously this branch did `throw createError({ statusCode: 404,
  // fatal: true })`. The throw fires inside an `async setup`, mid-
  // Suspense-resolve, in the middle of a vue-router navigation —
  // and the rest of the page template still expects `page.value`
  // to be non-null. The result is a cascade of "Invalid vnode type"
  // warnings as the template renders against null, followed by
  // `suspense.resolve() is called on an already unmounted suspense
  // boundary` when Nuxt's `showError` unmounts the in-flight page,
  // followed by a TypeError reading `.type` on a null vnode during
  // the unmount cleanup. The visible end-state is a white page.
  //
  // The pattern that doesn't crash: keep the page mounted, render
  // a not-found state below the template's `v-if="page"` gate, and
  // emit the 404 status server-side via `setResponseStatus`. That
  // status is what `nuxt-link-checker` (configured with
  // `failOnError: true` in the `linkChecker:` block of
  // `nuxt.config.ts`) probes for at build time, so any link the
  // crawler reaches that resolves to a missing path still red-flags
  // the build the same way the old throw did. Runtime stays clean,
  // CI gate stays loud.
  if (!page.value) {
    setResponseStatus(404)
  }

  // Dev-branch gate for the not-found callout. `import.meta.dev`
  // is the Vite-stamped dev flag, constant-folded at build time —
  // the production bundle ships a literal `false` here and the
  // dev-only callout template branch tree-shakes out entirely.
  const isDev = import.meta.dev

  // Provide frontmatter values that the markdown body's inline MDC
  // components consume without props: <DocsMetaTable /> reads the
  // `metaRows:` rows, <SourceLink /> reads the `source:` URL.
  // Authors declare both in frontmatter once and reference the
  // components bare in the body; explicit `:rows` / `:href` props
  // still win for the rare case a page computes meta dynamically.
  //
  // The frontmatter key is `metaRows`, not `meta` — `meta` is
  // already claimed by @nuxtjs/seo's frontmatter shape and gets
  // mapped onto SEO meta tags rather than reaching `page.value`.
  provide(
    'docsPageMeta',
    computed(() => page.value?.metaRows)
  )
  provide(
    'docsPageSource',
    computed(() => page.value?.source)
  )

  // Title falls back to "Page not found" on the 404 branch so the
  // browser tab + SERP title reflect the missing-page state.
  // Description does the same so og:description / twitter:description
  // don't carry stale prose from a previously rendered page. The
  // site-wide titleTemplate in app.vue appends " · Attaform" to
  // whatever lands here.
  useHead(() => ({
    title: page.value?.title ?? 'Page not found',
  }))
  useSeoMeta({
    description: () =>
      page.value?.description ??
      'No docs page exists at this URL. Head back to the docs hub to find your way.',
    // Keep search engines out of 404 paths. The site-wide
    // `indexable` gate pins robots site-wide based on
    // `VERCEL_ENV === 'production'`; this per-page override pins
    // 404s to noindex even when the rest of the site is indexable,
    // so a transient broken link doesn't end up indexed before we
    // ship a real page at that path.
    robots: () => (page.value ? null : 'noindex, nofollow'),
  })

  // Structured data per doc page. Two nodes:
  //
  //   1. BreadcrumbList — drives the breadcrumb display in SERPs
  //      (replaces the URL line under the result title with a
  //      readable trail). Reuses the same segment array as the on-
  //      page <DocsBreadcrumb> via useDocsBreadcrumb so on-page text
  //      and the structured trail can never drift apart. We keep
  //      only segments that have a URL; section labels (e.g. the
  //      middle "Recipes" entry, which is a sidebar grouping rather
  //      than a navigable page) are dropped because Google's
  //      BreadcrumbList parser expects every non-final item to
  //      resolve to a page.
  //
  //   2. TechArticle — adds article-class signals (headline, author,
  //      description, mainEntityOfPage) so a docs page reads as
  //      "technical article about a software topic" rather than a
  //      generic page. Pairs with the SoftwareApplication node on
  //      the homepage to build out a coherent knowledge graph.
  //
  // defineBreadcrumb / defineArticle come from nuxt-schema-org's
  // auto-imports (registered by @nuxtjs/seo). They handle the
  // @context / @type boilerplate and resolve relative URLs against
  // site.url. Both nodes are emitted only when a page exists —
  // emitting Article schema for a 404 path would feed crawlers
  // false structured data about content that isn't there.
  const breadcrumbs = useDocsBreadcrumb()
  useSchemaOrg(
    computed(() =>
      page.value
        ? [
            defineBreadcrumb({
              itemListElement: breadcrumbs.value
                .filter((seg) => seg.to)
                .map((seg, idx) => ({
                  name: seg.label,
                  item: seg.to as string,
                  position: idx + 1,
                }))
                .concat([
                  {
                    name: page.value?.title ?? 'Documentation',
                    item: route.path,
                    position: breadcrumbs.value.filter((seg) => seg.to).length + 1,
                  },
                ]),
            }),
            defineArticle({
              '@type': 'TechArticle',
              headline: page.value?.title ?? 'Documentation',
              description: page.value?.description ?? '',
              author: { '@type': 'Person', name: 'Oswald Chisala' },
              // mainEntityOfPage is inferred from the current route by
              // defineArticle when omitted — let it resolve against
              // site.url so we don't have to construct the canonical
              // URL ourselves.
            }),
          ]
        : []
    )
  )
</script>

<template>
  <div class="flex gap-12">
    <!-- Article — capped at max-w-3xl (768px) for comfortable reading
         line length. min-w-0 prevents overflow from wide code blocks
         pushing the TOC off-screen. flex-1 lets it grow into available
         space when the TOC is hidden (lg-xl viewports).
         The whole article fades in on first paint (`docs-article-enter`
         class — keyframe just below `docs-prose`) so the prose lands
         deliberately rather than popping. The breadcrumb is excluded
         from this since it has its own segment-stagger animation. -->
    <article class="min-w-0 max-w-3xl flex-1">
      <DocsBreadcrumb class="mb-8" />
      <template v-if="page">
        <div class="docs-article-enter docs-prose prose prose-neutral max-w-none dark:prose-invert">
          <ContentRenderer :value="page" />
        </div>

        <!-- Edit link sits between prose and pager — same visual weight
             as a footer note (text-sm, fg-muted) so it doesn't compete
             with the article body but stays discoverable for someone
             who'd file a PR. Hidden on the not-found branch below;
             there is no underlying .md to edit. -->
        <div class="mt-12 flex justify-end border-t border-border pt-6">
          <a
            :href="editUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-1.5 text-sm text-fg-muted transition-colors duration-(--duration-fast) hover:text-fg"
          >
            <PencilLine class="h-3.5 w-3.5" :stroke-width="2" />
            <span>Edit this page on GitHub</span>
            <ArrowUpRight class="h-3.5 w-3.5" :stroke-width="2" />
          </a>
        </div>

        <DocsPager class="mt-10" />
      </template>

      <!-- Not-found state. Two flavours: dev gets a maintainer-
           targeted callout with the broken path + remediation
           checklist; production gets a graceful visitor message.
           `isDev` is constant-folded at build time so the dev
           branch never ships to readers. -->
      <div
        v-else-if="isDev"
        class="docs-article-enter not-prose my-8 rounded-xl border-2 border-dashed border-amber-400 bg-amber-50 p-6 text-amber-950 dark:border-amber-500/60 dark:bg-amber-950/30 dark:text-amber-100"
      >
        <div
          class="mb-3 inline-flex items-center gap-2 text-xs font-semibold tracking-wide uppercase"
        >
          <TriangleAlert class="h-4 w-4" :stroke-width="2.25" />
          <span>Missing docs page · dev-only callout</span>
        </div>
        <h1 class="mb-3 text-2xl font-semibold">
          No docs page at
          <code
            class="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[0.85em] dark:bg-amber-900/40"
            >{{ route.path }}</code
          >
        </h1>
        <p class="mb-4 text-sm leading-relaxed">
          CI will fail on this.
          <code class="font-mono text-[0.92em]">nuxt-link-checker</code> probes every internal link
          during <code class="font-mono text-[0.92em]">pnpm build</code> and exits non-zero on any
          path that responds 404, so this page can't ship to production. Pick one of the three
          fixes:
        </p>
        <ol class="mb-4 list-decimal space-y-2 pl-6 text-sm leading-relaxed">
          <li>
            <strong>Write the page.</strong> Add
            <code class="font-mono text-[0.92em]"
              >docs{{ route.path.replace('/docs', '') }}.md</code
            >
            in the content tree and slot it into the right Phase 1 category.
          </li>
          <li>
            <strong>Redirect it.</strong> Add a
            <code class="font-mono text-[0.92em]">routeRules</code>
            entry in <code class="font-mono text-[0.92em]">apps/site/nuxt.config.ts</code>
            pointing this path at an existing destination (301).
          </li>
          <li>
            <strong>Remove the link.</strong> If nothing should point here, grep for the source link
            and drop it. Link-checker only flags paths something else links to — orphan paths don't
            fail the build.
          </li>
        </ol>
        <p class="text-xs opacity-80">
          This callout renders only in dev. Production builds get a graceful visitor message instead
          — but they shouldn't get there in the first place, because CI will have stopped the build.
        </p>
      </div>

      <!-- Production not-found state. Mirrors the docs-prose chrome
           so the visual rhythm matches the rest of the docs surface;
           the "wander back" link is the only call to action because
           the docs sidebar on the left already gives the visitor
           every other path. -->
      <div
        v-else
        class="docs-article-enter docs-prose prose prose-neutral max-w-none dark:prose-invert"
      >
        <h1>This page hasn't landed here yet</h1>
        <p>
          No docs page exists at
          <code>{{ route.path }}</code>
          — the URL might be a typo, a stale link from before the docs got their current shape, or a
          section still on the way.
        </p>
        <p>
          Head back to the
          <NuxtLink to="/docs">docs hub</NuxtLink>
          to find your way, or pick a category from the sidebar.
        </p>
      </div>
    </article>
    <DocsTOC v-if="page" :links="page?.body?.toc?.links" />
  </div>
</template>

<!-- Prose styling for this page lives in `assets/css/docs-prose.css`
     and ships through the static CSS bundle (imported from
     `tailwind.css`). Keeping it out of a `<style>` block here means
     the rules don't ride the dev-mode JS-injection path, so the
     `.docs-prose` chrome (blockquote border, code chip, heading
     hash) is in effect from the first paint of every back/forward
     navigation instead of flashing in mid-`docs-article-enter`. -->
