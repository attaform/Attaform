<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const schema = z.object({
    optional: z.string().optional(),
    nullable: z.string().nullable(),
    defaulted: z.string().default('seed'),
    required: z.string().min(1, 'Name is required'),
  })

  const form = useForm({
    schema,
    defaultValues: { nullable: null },
    key: 'docs-demo-optional-nullable',
  })

  function fmt(v: unknown) {
    if (v === undefined) return 'undefined'
    if (v === null) return 'null'
    return JSON.stringify(v)
  }
</script>

<template>
  <form @submit.prevent>
    <table>
      <thead>
        <tr>
          <th>Modifier</th>
          <th>Input</th>
          <th><code>form.values.&lt;path&gt;</code></th>
          <th><code>form.errors.&lt;path&gt;</code></th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><code>.optional()</code></td>
          <td><input v-register="form.register('optional')" /></td>
          <td
            ><code>{{ fmt(form.values.optional) }}</code></td
          >
          <td>
            <code v-if="form.errors.optional?.[0]">{{ form.errors.optional[0].message }}</code>
            <span v-else class="muted">—</span>
          </td>
        </tr>
        <tr>
          <td><code>.nullable()</code></td>
          <td><input v-register="form.register('nullable')" /></td>
          <td
            ><code>{{ fmt(form.values.nullable) }}</code></td
          >
          <td>
            <code v-if="form.errors.nullable?.[0]">{{ form.errors.nullable[0].message }}</code>
            <span v-else class="muted">—</span>
          </td>
        </tr>
        <tr>
          <td><code>.default('seed')</code></td>
          <td><input v-register="form.register('defaulted')" /></td>
          <td
            ><code>{{ fmt(form.values.defaulted) }}</code></td
          >
          <td>
            <code v-if="form.errors.defaulted?.[0]">{{ form.errors.defaulted[0].message }}</code>
            <span v-else class="muted">—</span>
          </td>
        </tr>
        <tr>
          <td><code>z.string().min(1)</code></td>
          <td><input v-register="form.register('required')" /></td>
          <td
            ><code>{{ fmt(form.values.required) }}</code></td
          >
          <td>
            <code v-if="form.errors.required?.[0]" class="err">{{
              form.errors.required[0].message
            }}</code>
            <span v-else class="muted">—</span>
          </td>
        </tr>
      </tbody>
    </table>

    <p class="hint">
      Watch the empty case for each modifier: <code>.optional()</code> reports
      <code>undefined</code>; <code>.nullable()</code> reports <code>null</code>;
      <code>.default('seed')</code> reports the literal default; the plain required string reports
      <code>''</code> and the refinement error fires.
    </p>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
  }
  th,
  td {
    text-align: left;
    padding: 0.5rem 0.625rem;
    border-bottom: 1px solid #e5e7eb;
  }
  th {
    background: #f9fafb;
    font-weight: 600;
    font-size: 0.75rem;
    color: #6b7280;
  }
  input[type='text'] {
    width: 100%;
    padding: 0.375rem 0.5rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.8125rem;
    font-family: inherit;
  }
  input:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
  }
  code.err {
    background: #fef2f2;
    color: #b91c1c;
  }
  .muted {
    color: #d1d5db;
  }
  .hint {
    margin: 0;
    color: #6b7280;
    font-size: 0.75rem;
  }
</style>
