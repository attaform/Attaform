<script setup lang="ts">
  // Override of `@nuxtjs/mdc`'s default `ProsePre`. Wraps the
  // Shiki-highlighted block in a relative container so a `<UiCopyButton>`
  // can float in the top-right corner of every code block — same
  // affordance every prose ```code``` block now ships with, no
  // per-page wiring required.
  //
  // The default ProsePre only renders `<pre :class>` with a slot
  // for the highlighted code; the raw source comes in via the `code`
  // prop, which the copy button forwards to the clipboard verbatim.
  defineProps<{
    code?: string
    language?: string | null
    filename?: string | null
    highlights?: number[]
    meta?: string | null
    class?: string | null
  }>()
</script>

<template>
  <div class="docs-prose-pre relative">
    <UiCopyButton
      v-if="code"
      :text="code"
      label="Copy code block"
      class="absolute top-2 right-2 z-10"
    />
    <pre :class="$props.class"><slot /></pre>
  </div>
</template>

<style>
  /* Preserve the upstream line-block behaviour. The default ProsePre
     ships this same rule; keeping it here keeps multi-line code
     looking right after the override. */
  .docs-prose-pre pre code .line {
    display: block;
  }
</style>
