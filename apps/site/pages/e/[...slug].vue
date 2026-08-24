<script setup lang="ts">
  import { computed } from 'vue'
  import { PencilLine, ArrowUpRight } from 'lucide-vue-next'

  const route = useRoute()

  // Maps `/e/af01` → repo path `docs/e/af01.md` → GitHub edit URL on
  // `main` (same in-browser-editor deep link as the docs pages).
  const editUrl = computed(
    () => `https://github.com/attaform/Attaform/edit/main/docs${route.path}.md`
  )

  const { data: page } = await useAsyncData(`content-${route.path}`, () =>
    queryCollection('errors').path(route.path).first()
  )

  // Same missing-page posture as pages/docs/[...slug].vue: degrade
  // in-page, emit the 404 status server-side so nuxt-link-checker
  // red-flags any internal link that points at a code with no page.
  if (!page.value) {
    setResponseStatus(404)
  }

  useHead(() => ({
    title: page.value?.title ?? 'Page not found',
  }))
  useSeoMeta({
    description: () =>
      page.value?.description ??
      'No error-code page exists at this URL. The index lists every Attaform diagnostic code.',
    robots: () => (page.value ? null : 'noindex, nofollow'),
  })
</script>

<template>
  <div class="mx-auto w-full max-w-3xl px-6 py-16">
    <template v-if="page">
      <article class="prose prose-neutral max-w-none dark:prose-invert">
        <ContentRenderer :value="page" />
      </article>

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
    </template>

    <div v-else class="prose prose-neutral dark:prose-invert">
      <h1>No page at this address</h1>
      <p>
        Attaform's diagnostic codes each have a page here, but this URL doesn't match one. The index
        lists every code a production build can emit.
      </p>
      <p>
        <NuxtLink to="/e">Browse the error-code index</NuxtLink>
      </p>
    </div>
  </div>
</template>
