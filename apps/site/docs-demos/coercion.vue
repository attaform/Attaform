<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const { register, values } = useForm({
    schema: z.object({
      count: z.number(),
      enabled: z.boolean(),
    }),
    defaultValues: { count: 0, enabled: false },
    key: 'docs-demo-coercion',
  })
</script>

<template>
  <form @submit.prevent>
    <label>
      <span><code>count</code> — schema is <code>z.number()</code></span>
      <input v-register="register('count')" type="text" placeholder="Type a number…" />
      <small
        >Stored as: <em>{{ JSON.stringify(values.count) }}</em> ({{ typeof values.count }})</small
      >
    </label>

    <label>
      <span><code>enabled</code> — schema is <code>z.boolean()</code></span>
      <input v-register="register('enabled')" type="text" placeholder="Type 'true' or 'false'" />
      <small
        >Stored as: <em>{{ JSON.stringify(values.enabled) }}</em> ({{
          typeof values.enabled
        }})</small
      >
    </label>

    <p class="note">
      Both inputs are <code>type="text"</code>. The default coercion registry handles
      string&nbsp;→&nbsp;number and string&nbsp;→&nbsp;boolean automatically.
    </p>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 28rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8125rem;
    font-weight: 500;
  }
  code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
    font-weight: 600;
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
    font-weight: 400;
    color: #374151;
    font-family: ui-monospace, monospace;
  }
  em {
    color: #2563eb;
    font-style: normal;
    font-weight: 500;
  }
  .note {
    font-size: 0.75rem;
    color: #6b7280;
    margin: 0;
  }
</style>
