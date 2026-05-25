<script setup lang="ts">
  // Playground directory. Lists every `apps/site/docs-demos/<slug>.vue`
  // SFC as its own card linking to `/play/<slug>` — a "show me
  // everything Attaform can do, one widget at a time" entry point
  // (plan §3, sidebar page 8).
  //
  // Discovery is glob-driven, so authoring a new SFC under
  // `docs-demos/` automatically surfaces it here on the next build —
  // no per-demo wiring required.
  import { computed, ref, watch } from 'vue'
  import { ArrowRight, FlaskConical, Search, Sparkles, X } from 'lucide-vue-next'

  // Inherits the docs shell (sidebar + header + footer) so a reader
  // browsing playgrounds isn't stranded in a sidebar-less layout. The
  // breadcrumb + pager render below; both walk `useDocsNavigation.ts`
  // which lists /play under "Getting started".
  definePageMeta({ layout: 'docs' })

  useHead({ title: 'Playgrounds' })
  useSeoMeta({
    description:
      'Open any Attaform docs demo in its own editable playground — every demo in the docs, listed in one place.',
  })

  // `eager: false` (the default) returns lazy-loader functions. We
  // never need the modules themselves here; the slug list comes from
  // the glob keys alone, so loaders stay un-invoked.
  const demoModules = import.meta.glob('../../docs-demos/*.vue')

  function formatTitle(slug: string): string {
    return slug
      .split('-')
      .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
      .join(' ')
  }

  const allSlugs = computed<string[]>(() =>
    Object.keys(demoModules)
      .map((path) => path.match(/\/([^/]+)\.vue$/)?.[1])
      .filter((slug): slug is string => typeof slug === 'string')
      .sort()
  )

  // Substring filter — matches against both the raw slug and its
  // formatted title, so "v-register", "register", and "Register"
  // all surface the same hits. Pagefind (the ⌘K modal) only indexes
  // docs content, not playgrounds, so the playground page carries
  // its own filter rather than deferring to site-wide search.
  const query = ref('')
  const filtered = computed<string[]>(() => {
    const q = query.value.trim().toLowerCase()
    if (!q) return allSlugs.value
    return allSlugs.value.filter(
      (slug) => slug.toLowerCase().includes(q) || formatTitle(slug).toLowerCase().includes(q)
    )
  })

  // Page-size selector. Three options; default 15 fits today's 45-demo
  // corpus into three pages without making the grid feel infinite.
  const pageSizeOptions = [10, 15, 25] as const
  type PageSize = (typeof pageSizeOptions)[number]
  const pageSize = ref<PageSize>(15)

  const currentPage = ref(1)
  const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize.value)))

  // Reset to page 1 whenever the filter or page size changes —
  // otherwise the reader could land on a stale page number that no
  // longer corresponds to any cards.
  watch([query, pageSize], () => {
    currentPage.value = 1
  })

  const visible = computed<string[]>(() => {
    const page = Math.min(currentPage.value, totalPages.value)
    const start = (page - 1) * pageSize.value
    return filtered.value.slice(start, start + pageSize.value)
  })

  const rangeStart = computed(() =>
    filtered.value.length === 0 ? 0 : (currentPage.value - 1) * pageSize.value + 1
  )
  const rangeEnd = computed(() =>
    Math.min(currentPage.value * pageSize.value, filtered.value.length)
  )

  function goToPage(n: number) {
    if (n < 1 || n > totalPages.value) return
    currentPage.value = n
  }
</script>

<template>
  <div>
    <DocsBreadcrumb class="mb-8" />

    <div class="mb-10 max-w-3xl">
      <p class="text-sm font-semibold tracking-wide text-accent uppercase">Live editors</p>
      <h1 class="mt-3 text-display-md font-semibold text-fg">Playgrounds</h1>
      <p class="mt-4 text-lg text-fg-muted">
        Every editor ships with <UiInlineCode>attaform</UiInlineCode> pre-bundled and a live preview
        that updates as you type. Start from a blank canvas to experiment freely, or fork any docs
        demo below.
      </p>
    </div>

    <!-- Blank-canvas lead CTA. Sits above the demo grid so visitors who
         just want to tinker land on it first, instead of scanning to the
         bottom of the page for a buried link. The accent border + gradient
         differentiates it from the curated demo cards below. -->
    <NuxtLink
      to="/play/blank"
      class="group relative mb-8 flex items-center justify-between gap-6 overflow-hidden rounded-xl border border-accent/30 bg-gradient-to-br from-accent/[0.06] via-bg to-bg p-6 shadow-xs transition-[border-color,box-shadow] duration-(--duration-base) ease-(--ease-out-quart) hover:border-accent/60 hover:shadow-md focus-visible:ring-4 focus-visible:ring-accent-ring focus-visible:outline-none"
    >
      <div class="min-w-0">
        <span
          class="inline-flex items-center gap-1.5 text-xs font-semibold tracking-wide text-accent uppercase"
        >
          <Sparkles class="h-3.5 w-3.5" :stroke-width="2" />
          Start blank
        </span>
        <p class="mt-2 text-xl font-semibold text-fg group-hover:text-accent">Blank playground</p>
        <p class="mt-1 text-sm text-fg-muted">
          A minimal Attaform form, schema and all. Edit anything and the preview re-renders on each
          keystroke.
        </p>
      </div>
      <ArrowRight
        class="h-5 w-5 shrink-0 text-fg-subtle transition-transform duration-(--duration-fast) ease-(--ease-out-quart) group-hover:translate-x-1 group-hover:text-accent"
        :stroke-width="2.25"
      />
    </NuxtLink>

    <!-- Search + per-page controls. Stacked on mobile, two-up on sm+. -->
    <div class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="relative flex-1 sm:max-w-sm">
        <Search
          class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle"
          :stroke-width="2"
        />
        <input
          v-model="query"
          type="text"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="Search form demos…"
          class="w-full rounded-md border border-border bg-bg py-2 pr-9 pl-9 text-sm text-fg shadow-xs transition-colors duration-(--duration-fast) placeholder:text-fg-subtle focus:border-accent focus:ring-4 focus:ring-accent-ring focus:outline-none"
        />
        <button
          v-if="query"
          type="button"
          aria-label="Clear filter"
          class="absolute top-1/2 right-2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-subtle transition-colors duration-(--duration-fast) hover:bg-surface hover:text-fg"
          @click="query = ''"
        >
          <X class="h-4 w-4" :stroke-width="2" />
        </button>
      </div>

      <div class="flex items-center gap-2 text-sm text-fg-muted">
        <label for="play-page-size" class="shrink-0">Per page</label>
        <select
          id="play-page-size"
          v-model.number="pageSize"
          class="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-fg shadow-xs focus:border-accent focus:ring-4 focus:ring-accent-ring focus:outline-none"
        >
          <option v-for="opt in pageSizeOptions" :key="opt" :value="opt">{{ opt }}</option>
        </select>
      </div>
    </div>

    <div v-if="visible.length > 0" class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <NuxtLink
        v-for="slug in visible"
        :key="slug"
        :to="`/play/${slug}`"
        class="group flex flex-col gap-2 rounded-xl border bg-bg p-5 shadow-xs transition-[border-color,box-shadow] duration-(--duration-base) ease-(--ease-out-quart) hover:border-accent/40 hover:shadow-md focus-visible:ring-4 focus-visible:ring-accent-ring focus-visible:outline-none"
      >
        <span
          class="inline-flex items-center gap-1.5 text-xs font-semibold tracking-wide text-fg-subtle uppercase"
        >
          <FlaskConical class="h-3.5 w-3.5" :stroke-width="2" />
          {{ slug }}
        </span>
        <span class="text-base font-semibold text-fg group-hover:text-accent">
          {{ formatTitle(slug) }}
        </span>
        <span
          class="mt-1 inline-flex items-center gap-1 text-sm text-fg-subtle group-hover:text-accent"
        >
          Open playground
          <ArrowRight
            class="h-3.5 w-3.5 transition-transform duration-(--duration-fast) ease-(--ease-out-quart) group-hover:translate-x-0.5"
            :stroke-width="2.25"
          />
        </span>
      </NuxtLink>
    </div>

    <!-- No-results state — the filter matched nothing. -->
    <div
      v-else-if="query"
      class="rounded-xl border border-dashed border-border bg-surface/30 p-10 text-center"
    >
      <p class="text-fg-muted">
        No demos match
        <code class="rounded bg-surface px-1.5 py-0.5 font-mono text-[0.8125rem] text-fg">{{
          query
        }}</code
        >.
      </p>
      <button type="button" class="mt-3 text-sm text-accent hover:underline" @click="query = ''">
        Clear filter
      </button>
    </div>

    <!-- Empty state: the docs-demos dir itself is empty (early Phase
         1 before the first SFC lands). Point at the blank-slate
         playground so /play still feels alive. -->
    <div
      v-else
      class="rounded-xl border border-dashed border-border bg-surface/30 p-10 text-center"
    >
      <p class="text-fg-muted">
        No demo playgrounds wired up yet. Try the
        <NuxtLink to="/play/blank" class="text-accent hover:underline"
          >blank-slate playground</NuxtLink
        >
        in the meantime.
      </p>
    </div>

    <!-- Pagination row — page numbers + range readout. Hidden when
         everything fits on one page so it doesn't clutter the
         small-corpus case. -->
    <div
      v-if="filtered.length > 0 && totalPages > 1"
      class="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-between"
    >
      <p class="text-xs text-fg-subtle">
        Showing
        <span class="font-medium text-fg-muted">{{ rangeStart }}–{{ rangeEnd }}</span> of
        <span class="font-medium text-fg-muted">{{ filtered.length }}</span> demos
      </p>
      <div class="flex items-center gap-1">
        <button
          v-for="n in totalPages"
          :key="n"
          type="button"
          :aria-current="n === currentPage ? 'page' : undefined"
          class="inline-flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-sm font-medium transition-colors duration-(--duration-fast)"
          :class="
            n === currentPage
              ? 'bg-accent text-accent-fg'
              : 'border border-border bg-bg text-fg-muted hover:border-border-strong hover:text-fg'
          "
          @click="goToPage(n)"
        >
          {{ n }}
        </button>
      </div>
    </div>

    <DocsPager class="mt-12" />
  </div>
</template>
