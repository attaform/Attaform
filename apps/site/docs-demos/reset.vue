<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const { register, reset, resetField, fields, meta } = useForm({
    schema: z.object({
      name: z.string(),
      email: z.email(),
      newsletter: z.boolean(),
    }),
    defaultValues: { name: 'Alex', email: 'alex@attaform.dev', newsletter: true },
    key: 'docs-demo-reset',
  })
</script>

<template>
  <form @submit.prevent>
    <label>
      <span>Name <small v-if="fields.name.dirty">— dirty</small></span>
      <input v-register="register('name')" type="text" />
    </label>

    <label>
      <span>Email <small v-if="fields.email.dirty">— dirty</small></span>
      <input v-register="register('email')" type="email" />
    </label>

    <label class="check">
      <input v-register="register('newsletter')" type="checkbox" />
      Newsletter
      <small v-if="fields.newsletter.dirty">— dirty</small>
    </label>

    <p class="status">
      Form is <em>{{ meta.dirty ? 'dirty' : 'pristine' }}</em>
    </p>

    <div class="actions">
      <button type="button" @click="resetField('name')">resetField('name')</button>
      <button type="button" @click="resetField('email')">resetField('email')</button>
      <button type="button" @click="reset()">reset() — whole form</button>
      <button
        type="button"
        @click="reset({ name: 'Champion', email: 'champ@attaform.dev', newsletter: false })"
      >
        reset(newDefaults)
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
