<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

  const form = useForm({
    schema: z.object({
      score: z.number().min(0).max(100),
      tags: z.array(z.string()),
    }),
    defaultValues: { tags: [] },
    key: 'docs-demo-persistence-edge-cases',
    persist: { storage: 'session', clearOnSubmitSuccess: false },
  })

  const onSubmit = form.handleSubmit(async (values) => {
    await new Promise((r) => setTimeout(r, 300))
    toast.success('Submitted, draft kept (clearOnSubmitSuccess: false)', {
      description: values,
    })
  })

  function addTag() {
    form.append('tags', 'new')
  }
</script>

<template>
  <form class="demo" @submit.prevent="onSubmit">
    <label>
      Score (typed as <code>number</code>, round-trips cleanly through any backend)
      <input v-register="form.register('score', { persist: true })" type="number" />
    </label>

    <fieldset>
      <legend>Tags (array: append, watch the persisted shape grow)</legend>
      <div v-for="(_, i) in form.values.tags" :key="i" class="row">
        <input v-register="form.register(`tags.${i}`, { persist: true })" />
        <button type="button" class="ghost" @click="form.remove('tags', i)">−</button>
      </div>
      <button type="button" class="ghost" @click="addTag">Add tag</button>
    </fieldset>

    <p class="hint">
      <code>clearOnSubmitSuccess: false</code> keeps the draft after a successful submit, useful for
      wizards with review pages or retry-prone APIs. Refresh the page after editing; the draft
      hydrates before the first render.
    </p>

    <button type="submit" :disabled="form.meta.submitting">
      {{ form.meta.submitting ? 'Submitting…' : 'Submit (draft survives)' }}
    </button>
  </form>
</template>

<style scoped>
  .row input {
    flex: 1;
  }
</style>
