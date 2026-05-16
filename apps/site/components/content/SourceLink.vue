<script setup lang="ts">
  // Persistent link to a symbol's implementation. Sits at the foot of
  // every reference page, one click away for a reader who's read the
  // prose and wants to step into the code.
  //
  // Two access patterns mirror `<DocsMetaTable>`:
  //
  //   1. Plain `<SourceLink />` inside markdown — auto-reads `source:`
  //      from the page frontmatter via the `docsPageSource` injection
  //      provided by `pages/docs/[...slug].vue`.
  //
  //   2. `<SourceLink :href="..." />` — explicit override.
  //
  // The frontmatter author picks a commit SHA (or `main`, or a tag)
  // and writes the GitHub URL directly. Pinning to a SHA keeps a doc
  // page's link stable across releases; readers shared a doc today
  // see the same source N versions later.
  import { computed, inject, type Ref } from 'vue'
  import { Github, ArrowUpRight } from 'lucide-vue-next'

  const props = defineProps<{
    href?: string
    label?: string
  }>()

  const injectedSource = inject<Ref<string | undefined>>('docsPageSource')
  const resolvedHref = computed<string | undefined>(() => props.href ?? injectedSource?.value)
</script>

<template>
  <a
    v-if="resolvedHref"
    :href="resolvedHref"
    target="_blank"
    rel="noopener noreferrer"
    class="not-prose inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-fg-muted transition-colors duration-(--duration-fast) hover:border-accent/40 hover:text-fg focus-visible:ring-4 focus-visible:ring-accent-ring focus-visible:outline-none"
  >
    <Github class="h-3.5 w-3.5" :stroke-width="2" />
    <span>{{ props.label ?? 'View source on GitHub' }}</span>
    <ArrowUpRight class="h-3.5 w-3.5" :stroke-width="2" />
  </a>
</template>
