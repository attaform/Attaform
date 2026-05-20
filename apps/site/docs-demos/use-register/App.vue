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
  <section class="parent-scope">
    <span class="scope-tag scope-tag--parent">App.vue · parent</span>

    <p class="lede">
      Each <code>FieldRow</code> only takes a <code>label</code> prop. The schema path arrives
      ambiently: the parent below applies <code>v-register</code> to the row, and
      <code>useRegister()</code> inside the row picks it up.
    </p>

    <form @submit.prevent>
      <FieldRow v-register="form.register('email')" label="Email" />
      <FieldRow v-register="form.register('handle')" label="Handle" />

      <pre>{{
        JSON.stringify(form.values, (_, v) => (v === undefined ? '(undefined)' : v), 2)
      }}</pre>
    </form>
  </section>
</template>

<style scoped>
  .parent-scope {
    position: relative;
    border: 1px dashed #93c5fd;
    background: #eff6ff;
    border-radius: 0.5rem;
    padding: 2.25rem 1rem 1rem;
    max-width: 28rem;
  }
  .scope-tag {
    position: absolute;
    top: 0;
    left: 0.75rem;
    transform: translateY(-50%);
    font-size: 0.625rem;
    font-weight: 700;
    letter-spacing: 0.075em;
    text-transform: uppercase;
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
    font-family: ui-monospace, monospace;
  }
  .scope-tag--parent {
    background: #2563eb;
    color: #fff;
  }
  .lede {
    margin: 0 0 1rem 0;
    font-size: 0.8125rem;
    color: #1e40af;
    line-height: 1.5;
  }
  .lede code {
    font-family: ui-monospace, monospace;
    background: #dbeafe;
    padding: 0.05rem 0.35rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
    color: #1e3a8a;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }
  pre {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 0.375rem;
    padding: 0.5rem 0.75rem;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    color: #111827;
    margin: 0;
  }
</style>
