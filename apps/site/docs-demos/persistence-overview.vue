<script setup lang="ts">
  // Phase 1 demo for "Persistence overview". The form persists to
  // sessionStorage; both fields opt in at their register() call
  // sites. Refresh the docs page after typing and the values
  // rehydrate before the first render — no flash, no manual wiring.
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      title: z.string().min(2, 'Tell us the title'),
      body: z.string().min(10, 'A few words please'),
    }),
    key: 'persistence-overview-demo',
    persist: 'session',
  })

  async function clear() {
    await form.clearPersistedDraft()
    form.reset()
  }
</script>

<template>
  <form @submit.prevent>
    <label>
      Title
      <input v-register="form.register('title', { persist: true })" />
      <em v-if="form.fields.title.showErrors">{{ form.fields.title.firstError?.message }}</em>
    </label>
    <label>
      Body
      <textarea v-register="form.register('body', { persist: true })" rows="3"></textarea>
      <em v-if="form.fields.body.showErrors">{{ form.fields.body.firstError?.message }}</em>
    </label>
    <p class="hint">Type a draft, refresh the page — your values come back.</p>
    <button type="button" class="clear" @click="clear">Clear persisted draft</button>
  </form>
</template>
