<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { useRegister, vRegister } from 'attaform'
  import { z } from 'zod'
  import { defineComponent, h, withDirectives } from 'vue'

  // FieldRow is a wrapper component: its root is a `<label>`, not the
  // input. The parent applies `v-register` to the FieldRow root;
  // FieldRow uses `useRegister()` to capture the binding and re-applies
  // it to its inner `<input>`. Defined inline so the demo stays
  // single-file.
  const FieldRow = defineComponent({
    name: 'FieldRow',
    props: {
      label: { type: String, required: true },
      type: { type: String, default: 'text' },
    },
    setup(props) {
      const rv = useRegister()
      return () =>
        h('label', { class: 'field-row' }, [
          h('span', { class: 'field-label' }, props.label),
          withDirectives(h('input', { type: props.type, class: 'field-input' }), [[vRegister, rv]]),
        ])
    },
  })

  const { register, values } = useForm({
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
    <FieldRow v-register="register('email')" label="Email" type="email" />
    <FieldRow v-register="register('handle')" label="Handle" />
    <pre>{{ JSON.stringify(values, null, 2) }}</pre>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 26rem;
  }
  :deep(.field-row) {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  :deep(.field-label) {
    font-size: 0.8125rem;
  }
  :deep(.field-input) {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
    font-weight: 400;
  }
  :deep(.field-input):focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
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
