<script setup lang="ts">
  import { ref } from 'vue'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

  const persistTitle = ref(true)
  const persistBody = ref(true)

  const form = useForm({
    schema: z.object({
      title: z.string(),
      body: z.string(),
    }),
    key: 'docs-demo-per-field-opt-in',
    persist: 'session',
  })

  async function clearAll() {
    await form.clearPersistedDraft()
    form.reset()
  }
</script>

<template>
  <form class="demo" @submit.prevent>
    <label>
      <span class="row-label">
        Title
        <small> <input v-model="persistTitle" type="checkbox" /> Persist this field </small>
      </span>
      <input v-register="form.register('title', { persist: persistTitle })" />
    </label>

    <label>
      <span class="row-label">
        Body
        <small> <input v-model="persistBody" type="checkbox" /> Persist this field </small>
      </span>
      <textarea v-register="form.register('body', { persist: persistBody })" rows="3"></textarea>
    </label>

    <p class="hint">
      Toggle either checkbox, type something, and refresh the page. Only opted-in fields rehydrate;
      the others land empty.
    </p>

    <button type="button" class="ghost" @click="clearAll">Clear persisted draft</button>
  </form>
</template>

<style scoped>
  .row-label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
  }
  small {
    font-weight: 400;
    color: var(--color-fg-muted);
    font-size: 0.75rem;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
</style>
