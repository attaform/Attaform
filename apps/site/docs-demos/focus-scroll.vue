<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const { register, fields, handleSubmit, focusFirstError, scrollToFirstError } = useForm({
    schema: z.object({
      name: z.string().min(1, 'Required'),
      email: z.email('Enter a valid email'),
      bio: z.string().min(20, 'At least 20 characters'),
      newsletter: z.boolean(),
    }),
    defaultValues: { newsletter: false },
    key: 'docs-demo-focus-scroll',
  })

  const onSubmit = handleSubmit(() => {
    /* success path not relevant for this demo */
  })
</script>

<template>
  <form @submit.prevent="onSubmit">
    <p class="hint">
      Submit with empty fields to see focus + scroll pull to the first invalid path. Click the
      buttons to dispatch each helper imperatively.
    </p>

    <label>
      <span>Name</span>
      <input v-register="register('name')" />
      <em v-if="fields.name.showErrors">{{ fields.name.firstError?.message }}</em>
    </label>

    <label>
      <span>Email</span>
      <input v-register="register('email')" />
      <em v-if="fields.email.showErrors">{{ fields.email.firstError?.message }}</em>
    </label>

    <label>
      <span>Bio (at least 20 characters)</span>
      <textarea v-register="register('bio')" rows="3" />
      <em v-if="fields.bio.showErrors">{{ fields.bio.firstError?.message }}</em>
    </label>

    <label class="check">
      <input v-register="register('newsletter')" type="checkbox" />
      Newsletter
    </label>

    <div class="actions">
      <button type="submit">Submit (auto focus on invalid)</button>
      <button type="button" @click="focusFirstError()">focusFirstError()</button>
      <button type="button" @click="scrollToFirstError({ behavior: 'smooth', block: 'center' })">
        scrollToFirstError(…)
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
  .hint {
    font-size: 0.75rem;
    color: #6b7280;
    margin: 0;
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
  input,
  textarea {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
    font-family: inherit;
  }
  input:focus,
  textarea:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  em {
    color: #dc2626;
    font-size: 0.8125rem;
    font-style: normal;
    font-weight: 400;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .actions button {
    padding: 0.5rem 0.85rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    background: #fff;
    font-size: 0.8125rem;
    cursor: pointer;
  }
  .actions button[type='submit'] {
    background: #2563eb;
    border-color: #2563eb;
    color: #fff;
  }
  .actions button:hover {
    filter: brightness(0.95);
  }
</style>
