<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const schema = z.object({
    email: z.email('Enter a valid email'),
    name: z.string().min(2, 'At least 2 characters'),
  })

  const form = useForm({
    schema,
    defaultValues: { email: '', name: '' },
    key: 'docs-demo-the-form',
  })

  const onSubmit = form.handleSubmit(async (values) => {
    await new Promise((r) => setTimeout(r, 500))
    toast.success('Saved', { description: values })
  })
</script>

<template>
  <div class="layout">
    <form @submit.prevent="onSubmit">
      <label>
        Email
        <input v-register="form.register('email')" autocomplete="email" />
        <em v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</em>
      </label>
      <label>
        Name
        <input v-register="form.register('name')" autocomplete="name" />
        <em v-if="form.fields.name.showErrors">{{ form.fields.name.firstError?.message }}</em>
      </label>
      <div class="actions">
        <button type="submit" :disabled="form.meta.submitting">
          {{ form.meta.submitting ? 'Saving…' : 'Submit' }}
        </button>
        <button type="button" class="ghost" @click="form.reset()">Reset</button>
        <button type="button" class="ghost" @click="form.clear()">Clear</button>
      </div>
    </form>

    <div class="panels">
      <section>
        <h4><code>form.values</code></h4>
        <pre>{{ JSON.stringify(form.values, null, 2) }}</pre>
      </section>

      <section>
        <h4><code>form.errors</code></h4>
        <pre>{{
          JSON.stringify({ email: form.errors.email, name: form.errors.name }, null, 2)
        }}</pre>
      </section>

      <section>
        <h4><code>form.meta</code></h4>
        <pre>{{
          JSON.stringify(
            {
              dirty: form.meta.dirty,
              valid: form.meta.valid,
              errorCount: form.meta.errorCount,
              submitting: form.meta.submitting,
              submissionAttempts: form.meta.submissionAttempts,
              submitted: form.meta.submitted,
            },
            null,
            2
          )
        }}</pre>
      </section>
    </div>
  </div>
</template>

<style scoped>
  .layout {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1.25rem;
  }
  @media (min-width: 760px) {
    .layout {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8125rem;
    color: #374151;
  }
  input {
    padding: 0.5rem 0.625rem;
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
    color: #b91c1c;
    font-size: 0.8125rem;
    font-style: normal;
    font-weight: 500;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  button {
    align-self: flex-start;
    padding: 0.5rem 0.875rem;
    border-radius: 0.375rem;
    border: 1px solid #2563eb;
    background: #2563eb;
    color: white;
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
  }
  button:hover:not(:disabled) {
    background: #1d4ed8;
  }
  button:disabled {
    background: #9ca3af;
    border-color: #9ca3af;
    cursor: progress;
  }
  button.ghost {
    background: white;
    color: #374151;
    border-color: #d1d5db;
  }
  button.ghost:hover {
    background: #f3f4f6;
  }
  .panels {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.75rem;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  h4 {
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 600;
  }
  code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
  }
  pre {
    margin: 0;
    padding: 0.5rem 0.625rem;
    background: #0f172a;
    color: #a5f3fc;
    border-radius: 0.375rem;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    overflow: auto;
  }
</style>
