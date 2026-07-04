<script setup lang="ts">
  import { computed, onBeforeUnmount, ref } from 'vue'
  import { Check, Copy, FileText } from 'lucide-vue-next'

  // The page-level "copy as markdown" pair that sits by the docs title.
  // Copy fetches the page's cleaned .md endpoint (written into public/ by
  // generate-llms.mjs) and writes it to the clipboard; the .md link opens
  // that same file. Both point at `${route.path}.md`, e.g.
  // /docs/reference/ai-agents.md. Clipboard access is client-gated and
  // wrapped in try/catch — it can throw in private mode or an insecure
  // context — so a failed copy silently no-ops and the .md link remains.
  const props = defineProps<{ path: string }>()

  // Strip a trailing slash before appending .md so a trailing-slash route
  // (e.g. /docs/foo/) still points at /docs/foo.md rather than /docs/foo/.md.
  const mdHref = computed(() => `${props.path.replace(/\/$/, '')}.md`)

  const copied = ref(false)
  let resetTimer: ReturnType<typeof setTimeout> | null = null

  async function copyMarkdown() {
    if (!import.meta.client) return
    try {
      const md = await $fetch<string>(mdHref.value, { responseType: 'text' })
      await navigator.clipboard.writeText(md)
      copied.value = true
      if (resetTimer) clearTimeout(resetTimer)
      resetTimer = setTimeout(() => (copied.value = false), 1500)
    } catch {
      // Silent fallback — see comment above.
    }
  }

  onBeforeUnmount(() => {
    if (resetTimer) clearTimeout(resetTimer)
  })
</script>

<template>
  <div class="flex items-center gap-1 text-xs">
    <button
      type="button"
      class="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-fg-muted transition-[background-color,color] duration-(--duration-fast) hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      :aria-label="copied ? 'Copied' : 'Copy page as markdown'"
      @click="copyMarkdown"
    >
      <Check v-if="copied" class="h-3.5 w-3.5 text-success" :stroke-width="2.25" />
      <Copy v-else class="h-3.5 w-3.5" :stroke-width="2" />
      <span>{{ copied ? 'Copied' : 'Copy' }}</span>
    </button>
    <a
      :href="mdHref"
      class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-fg-muted transition-[background-color,color] duration-(--duration-fast) hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
    >
      <FileText class="h-3.5 w-3.5" :stroke-width="2" />
      <span>.md</span>
    </a>
  </div>
</template>
