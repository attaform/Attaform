<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { schema } from './schema'
  import ProfileFieldset from './ProfileFieldset.vue'
  import StatusPill from './StatusPill.vue'

  const form = useForm({
    schema,
    key: 'docs-demo-inject-form',
  })

  const onSubmit = form.handleSubmit(async (values) => {
    toast.success(`Welcome ${values.profile.name}`, { description: values })
  })
</script>

<template>
  <form @submit.prevent="onSubmit">
    <label>
      Email (in the parent component)
      <input v-register="form.register('email')" autocomplete="email" />
      <em v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</em>
    </label>

    <ProfileFieldset />

    <div class="footer">
      <button type="submit">Submit</button>
      <StatusPill />
    </div>

    <p class="hint">
      The <code>ProfileFieldset</code> and <code>StatusPill</code> components don't receive any
      props. They call <code>injectForm</code> and the registry hands back the same reactive form
      the parent owns.
    </p>
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
  input {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
    font-family: inherit;
  }
  input:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  em {
    color: #dc2626;
    font-size: 0.8125rem;
    font-style: normal;
    font-weight: 400;
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  button {
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    border: 1px solid #2563eb;
    background: #2563eb;
    color: white;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
  }
  button:hover {
    background: #1d4ed8;
  }
  code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
  }
  .hint {
    margin: 0;
    color: #6b7280;
    font-size: 0.75rem;
  }
</style>
