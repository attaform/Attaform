<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const { register, values } = useForm({
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
      <input v-register.lazy="register('lazyName')" placeholder="Type, then blur" />
      <small>values.lazyName = {{ JSON.stringify(values.lazyName) }}</small>
    </label>

    <label>
      <span><code>.trim</code> — strips leading/trailing whitespace before the write</span>
      <input
        v-register.trim="register('trimmedSlug')"
        placeholder="Pad with spaces around a word"
      />
      <small>values.trimmedSlug = {{ JSON.stringify(values.trimmedSlug) }}</small>
    </label>

    <label>
      <span
        ><code>.number</code> — coerces the DOM string to a number before storage even when
      </span>
      <input v-register.number="register('typedAge')" placeholder="42" />
      <small
        >values.typedAge = {{ JSON.stringify(values.typedAge) }} (<em>{{
          typeof values.typedAge
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
