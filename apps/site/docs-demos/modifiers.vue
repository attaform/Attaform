<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      lazyName: z.string(),
      trimmedSlug: z.string(),
      typedAge: z.number(),
    }),
    key: 'docs-demo-modifiers',
  })
</script>

<template>
  <form @submit.prevent>
    <label>
      <span><code>.lazy</code> — writes on change/blur, not on every keystroke</span>
      <input v-register.lazy="form.register('lazyName')" placeholder="Type, then blur" />
      <small>form.values.lazyName = {{ JSON.stringify(form.values.lazyName) }}</small>
    </label>

    <label>
      <span><code>.trim</code> — strips leading/trailing whitespace before the write</span>
      <input
        v-register.trim="form.register('trimmedSlug')"
        placeholder="Pad with spaces around a word"
      />
      <small>form.values.trimmedSlug = {{ JSON.stringify(form.values.trimmedSlug) }}</small>
    </label>

    <label>
      <span
        ><code>.number</code> — coerces the DOM string to a number before storage even when
      </span>
      <input v-register.number="form.register('typedAge')" placeholder="42" />
      <small
        >form.values.typedAge = {{ JSON.stringify(form.values.typedAge) }} (<em>{{
          typeof form.values.typedAge
        }}</em
        >)</small
      >
    </label>
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
</style>
