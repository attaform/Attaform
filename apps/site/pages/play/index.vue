<script setup lang="ts">
  // Playground directory. Lists every `apps/site/docs-demos/<slug>.vue`
  // SFC as its own card linking to `/play/<slug>` — a "show me
  // everything Attaform can do, one widget at a time" entry point
  // (plan §3, sidebar page 8).
  //
  // Discovery is glob-driven, so authoring a new SFC under
  // `docs-demos/` automatically surfaces it here on the next build —
  // no per-demo wiring required.
  import { computed } from 'vue'
  import { ArrowRight, FlaskConical } from 'lucide-vue-next'

  useHead({ title: 'Playgrounds' })
  useSeoMeta({
    description:
      'Open any Attaform docs demo in its own editable playground — every demo on the site, listed in one place.',
  })

  // `eager: false` (the default) returns lazy-loader functions. We
  // never need the modules themselves here; the slug list comes from
  // the glob keys alone, so loaders stay un-invoked.
  const demoModules = import.meta.glob('../../docs-demos/*.vue')

  const slugs = computed<string[]>(() =>
    Object.keys(demoModules)
      .map((path) => path.match(/\/([^/]+)\.vue$/)?.[1])
      .filter((slug): slug is string => typeof slug === 'string')
      .sort()
  )

  function formatTitle(slug: string): string {
    return slug
      .split('-')
      .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
      .join(' ')
  }
</script>

<template>
  <div class="relative isolate overflow-hidden">
    <UiContainer size="xl">
      <div class="py-12">
        <div class="mb-10 max-w-3xl">
          <p class="text-sm font-semibold tracking-wide text-accent uppercase">Live editors</p>
          <h1 class="mt-3 text-display-md font-semibold text-fg">Playgrounds</h1>
          <p class="mt-4 text-lg text-fg-muted">
            Every demo in the docs has a matching playground, yours to fork and remix. Pick one and
            the editor opens ready to go: the demo's source loaded,
            <UiInlineCode>attaform</UiInlineCode> pre-bundled, and a live preview that updates as
            you type.
          </p>
        </div>

        <div v-if="slugs.length > 0" class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <NuxtLink
            v-for="slug in slugs"
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

        <!-- Empty state: when the docs-demos dir is empty (early Phase
             1 before the first SFC lands), point readers at the
             blank-slate playground so /play still feels alive. -->
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

        <div class="mt-12 rounded-xl border border-border bg-surface/40 p-5">
          <p class="text-sm font-semibold text-fg">Want a blank canvas?</p>
          <p class="mt-1 text-sm text-fg-muted">
            The
            <NuxtLink to="/play/blank" class="text-accent hover:underline"
              >blank-slate playground</NuxtLink
            >
            opens a freeform editor seeded with the shipment demo. Edit anything; the preview
            re-renders on each keystroke.
          </p>
        </div>
      </div>
    </UiContainer>
  </div>
</template>
