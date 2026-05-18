<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      name: z.string(),
      email: z.email(),
      newsletter: z.boolean(),
    }),
    defaultValues: { name: 'Alex', email: 'alex@attaform.dev', newsletter: true },
    key: 'docs-demo-form.reset',
  })
</script>

<template>
  <form @submit.prevent>
    <label>
      <span>Name <small v-if="form.fields.name.dirty">— dirty</small></span>
      <input v-register="form.register('name')" />
    </label>

    <label>
      <span>Email <small v-if="form.fields.email.dirty">— dirty</small></span>
      <input v-register="form.register('email')" />
    </label>

    <label class="check">
      <input v-register="form.register('newsletter')" type="checkbox" />
      Newsletter
      <small v-if="form.fields.newsletter.dirty">— dirty</small>
    </label>

    <p class="status">
      Form is <em>{{ form.meta.dirty ? 'dirty' : 'pristine' }}</em>
    </p>

    <div class="actions">
      <button type="button" @click="form.resetField('name')">form.resetField('name')</button>
      <button type="button" @click="form.resetField('email')">form.resetField('email')</button>
      <button type="button" @click="form.reset()">form.reset() — whole form</button>
      <button
        type="button"
        @click="form.reset({ name: 'Champion', email: 'champ@attaform.dev', newsletter: false })"
      >
        form.reset(newDefaults)
      </button>
    </div>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 30rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  label.check {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
    font-weight: 400;
  }
  label.check input {
    margin: 0;
  }
  input {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
  }
  input:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  small {
    font-size: 0.75rem;
    color: #f59e0b;
    font-weight: 400;
  }
  .status {
    font-size: 0.8125rem;
    margin: 0;
    color: #6b7280;
  }
  em {
    color: #111827;
    font-style: normal;
    font-weight: 600;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .actions button {
    padding: 0.35rem 0.7rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    background: #fff;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    cursor: pointer;
  }
  .actions button:hover {
    background: #f3f4f6;
  }
</style>
