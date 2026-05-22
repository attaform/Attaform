<script setup lang="ts">
  import { useForm, unset } from 'attaform/zod'
  import { z } from 'zod'

  const schema = z.object({
    email: z.string(),
    profile: z.object({
      name: z.string(),
      age: z.number(),
    }),
  })

  const form = useForm({
    schema,
    key: 'docs-demo-unset',
  })

  const profileFields = form.fields as unknown as (p: string) => { blank: boolean }
</script>

<template>
  <form @submit.prevent>
    <label>
      <span>Email (primitive leaf)</span>
      <input v-register="form.register('email')" />
    </label>

    <fieldset>
      <legend>Profile (container)</legend>
      <label>
        <span>Name</span>
        <input v-register="form.register('profile.name')" />
      </label>
      <label>
        <span>Age</span>
        <input type="number" v-register="form.register('profile.age')" />
      </label>
    </fieldset>

    <div class="actions">
      <button type="button" @click="form.setValue('email', unset)">
        setValue('email', unset)
      </button>
      <button type="button" @click="form.setValue('profile', unset)">
        setValue('profile', unset)
      </button>
      <button type="button" @click="form.reset()">reset()</button>
    </div>

    <div class="panel">
      <p>
        <code>form.values</code> =
        <em>{{ JSON.stringify(form.values, null, 2) }}</em>
      </p>
      <p>
        <code>form.blankPaths</code> =
        <em>{{ JSON.stringify([...form.blankPaths.value]) }}</em>
      </p>
      <p>
        <code>form.fields('profile').blank</code> =
        <em>{{ profileFields('profile').blank }}</em>
      </p>
    </div>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 32rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  fieldset {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    border: 1px solid #d1d5db;
    border-radius: 0.5rem;
    padding: 0.75rem;
  }
  legend {
    font-size: 0.8125rem;
    font-weight: 600;
    color: #374151;
    padding: 0 0.375rem;
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
  .panel {
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 0.375rem;
    padding: 0.5rem 0.75rem;
    font-size: 0.8125rem;
    font-family: ui-monospace, monospace;
  }
  .panel p {
    margin: 0.2rem 0;
    white-space: pre-wrap;
  }
  code {
    color: #6b7280;
  }
  em {
    color: #2563eb;
    font-style: normal;
    font-weight: 500;
  }
</style>
