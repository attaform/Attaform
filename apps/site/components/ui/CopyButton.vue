<script setup lang="ts">
  import { onBeforeUnmount, ref } from 'vue'
  import { Check, Copy } from 'lucide-vue-next'

  // Small reusable copy-to-clipboard affordance. Renders a square
  // icon button that toggles Copy → Check on success and auto-
  // resets after 1.5s. Clipboard access is gated on `import.meta.client`
  // and wrapped in try/catch — the API can throw in private mode or
  // insecure contexts; we silently no-op so the reader can fall back
  // to selecting by hand.
  const props = withDefaults(
    defineProps<{
      text: string
      label?: string
    }>(),
    { label: 'Copy code' }
  )

  const copied = ref(false)
  let resetTimer: ReturnType<typeof setTimeout> | null = null

  async function copy() {
    if (!import.meta.client) return
    try {
      await navigator.clipboard.writeText(props.text)
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
  <button
    type="button"
    class="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-fg-muted transition-[background-color,color] duration-(--duration-fast) hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
    :aria-label="copied ? 'Copied' : label"
    @click="copy"
  >
    <Check v-if="copied" class="h-4 w-4 text-success" :stroke-width="2.25" />
    <Copy v-else class="h-4 w-4" :stroke-width="2" />
  </button>
</template>
