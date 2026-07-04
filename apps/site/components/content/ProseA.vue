<script setup lang="ts">
  // Override Nuxt Content's default <a> rendering inside markdown.
  //
  // External http(s) links open in a new tab — the docs corpus
  // legitimately points at github.com (repo source, issues, releases),
  // npm, MDN, etc., and pulling readers off the docs page on those
  // links is rude. In-site routes (Nuxt Content's normalised paths)
  // pass through to NuxtLink for client-side navigation. Links to a
  // static file the site serves from public/ (llms.txt, skill.md, a
  // per-page .md) render as a plain <a>: NuxtLink would ask Vue Router
  // to resolve and prefetch a route that does not exist. Relative /
  // anchor links also render as plain <a>.
  import { isStaticFilePath } from '~/utils/prose-link'

  const props = defineProps<{
    href?: string
    title?: string
  }>()

  const isExternal = computed(() => /^https?:\/\//i.test(props.href ?? ''))
  const isAnchor = computed(() => (props.href ?? '').startsWith('#'))
  const isProtocolOther = computed(() => {
    const h = props.href ?? ''
    return /^[a-z][a-z0-9+.-]*:/i.test(h) && !isExternal.value
  })
  const isStaticFile = computed(() => isStaticFilePath(props.href))
  const isInternalRoute = computed(
    () =>
      !isExternal.value &&
      !isAnchor.value &&
      !isProtocolOther.value &&
      !isStaticFile.value &&
      Boolean(props.href)
  )
</script>

<template>
  <a v-if="isExternal" :href="href" :title="title" target="_blank" rel="noopener noreferrer">
    <slot />
  </a>
  <NuxtLink v-else-if="isInternalRoute" :to="href!" :title="title">
    <slot />
  </NuxtLink>
  <a v-else :href="href" :title="title">
    <slot />
  </a>
</template>
