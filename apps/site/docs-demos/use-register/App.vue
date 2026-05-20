<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import FieldRow from './FieldRow.vue'

  const form = useForm({
    schema: z.object({
      email: z.email('Enter a valid email'),
      handle: z.string().min(2),
    }),
    defaultValues: { handle: '' },
    key: 'docs-demo-use-register',
  })
</script>

<template>
  <form @submit.prevent>
    <p class="lede">
      Each <code>FieldRow</code> only takes a <code>label</code> prop. The schema path arrives
      ambiently: the parent applies <code>v-register</code> to the row, and
      <code>useRegister()</code> inside the row picks it up.
    </p>

    <FieldRow v-register="form.register('email')" label="Email" />
    <FieldRow v-register="form.register('handle')" label="Handle" />

    <pre>{{ JSON.stringify(form.values, (_, v) => (v === undefined ? '(undefined)' : v), 2) }}</pre>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 26rem;
  }
  .lede {
    margin: 0;
    font-size: 0.8125rem;
    color: #4b5563;
    line-height: 1.5;
  }
  .lede code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.35rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
    color: #111827;
  }
  pre {
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 0.375rem;
    padding: 0.5rem 0.75rem;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    color: #111827;
    margin: 0;
  }
</style>
