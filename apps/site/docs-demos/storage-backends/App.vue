<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

  const form = useForm({
    schema: z.object({
      note: z.string(),
      score: z.number(),
      due: z.date().nullable(),
    }),
    defaultValues: { due: null },
    key: 'docs-demo-storage-backends',
    persist: 'indexeddb',
  })

  async function clearAll() {
    await form.clearPersistedDraft()
    form.reset()
  }
</script>

<template>
  <form class="demo" @submit.prevent>
    <label>
      Note
      <textarea
        v-register="form.register('note', { persist: true })"
        rows="2"
        placeholder="Plain string, survives JSON."
      ></textarea>
    </label>

    <label>
      Score
      <input
        v-register="form.register('score', { persist: true })"
        type="number"
        placeholder="Number, fine on every backend."
      />
    </label>

    <label>
      Due date
      <input v-register="form.register('due', { persist: true })" type="date" />
      <small>
        Stored as <code>Date</code> in form values; round-trips verbatim through
        <code>'indexeddb'</code> via structured clone. <code>'local'</code> /
        <code>'session'</code> would serialize through <code>JSON.stringify</code> and lose the
        <code>Date</code> prototype.
      </small>
    </label>

    <p class="hint">
      This form persists to <code>'indexeddb'</code>: type, refresh, and your draft (including the
      live <code>Date</code> instance) hydrates back. Switching to <code>'local'</code> or
      <code>'session'</code> is a one-word change in <code>persist</code>; the bundle pulls in only
      the backend you pick.
    </p>

    <button type="button" class="ghost" @click="clearAll">Clear persisted draft</button>
  </form>
</template>

<style scoped>
  small {
    font-weight: 400;
    color: var(--color-fg-muted);
    font-size: 0.75rem;
  }
</style>
