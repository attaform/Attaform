<script setup lang="ts">
  import { computed } from 'vue'
  import { injectForm } from 'attaform'
  import type { FormShape } from './schema'

  const ctx = injectForm<FormShape>('docs-demo-inject-form')

  const label = computed(() => {
    const count = ctx?.meta.errorCount ?? 0
    return ctx?.meta.valid ? 'ready' : `${count} error${count === 1 ? '' : 's'}`
  })
</script>

<template>
  <span class="pill" :class="ctx?.meta.valid ? 'ok' : 'pending'">{{ label }}</span>
</template>
