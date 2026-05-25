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

<style scoped>
  .pill {
    font-size: 0.75rem;
    padding: 0.25rem 0.625rem;
    border-radius: 999px;
    font-family: ui-monospace, monospace;
  }
  .pill.ok {
    background: #ecfdf5;
    color: #047857;
    border: 1px solid #6ee7b7;
  }
  .pill.pending {
    background: #fef3c7;
    color: #92400e;
    border: 1px solid #fcd34d;
  }
</style>
