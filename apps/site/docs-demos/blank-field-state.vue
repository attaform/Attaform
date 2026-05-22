<script setup lang="ts">
  import { unset, useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      age: z.number(), // auto-marks blank
      name: z.string().min(1, 'Name is required'), // doesn't auto-mark; schema rejects ''
      title: z.string(), // doesn't auto-mark; '' is valid
      country: z.string().min(2, 'Pick a country'), // unset on purpose
    }),
    defaultValues: {
      country: unset,
    },
    key: 'docs-demo-blank-field-state',
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
          <th>Schema</th>
          <th>Input</th>
          <th><code>values</code></th>
          <th><code>blank</code></th>
          <th><code>errors</code></th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><code>z.number()</code></td>
          <td><input v-register="form.register('age')" type="number" placeholder="age" /></td>
          <td>
            <code>{{ fmt(form.values.age) }}</code>
          </td>
          <td>
            <code :class="{ on: form.fields.age.blank }">{{ form.fields.age.blank }}</code>
          </td>
          <td>
            <code v-if="form.errors.age?.[0]">{{ form.errors.age[0].message }}</code>
            <span v-else class="muted">—</span>
          </td>
        </tr>
        <tr>
          <td><code>z.string().min(1)</code></td>
          <td><input v-register="form.register('name')" type="text" placeholder="name" /></td>
          <td>
            <code>{{ fmt(form.values.name) }}</code>
          </td>
          <td>
            <code :class="{ on: form.fields.name.blank }">{{ form.fields.name.blank }}</code>
          </td>
          <td>
            <code v-if="form.errors.name?.[0]">{{ form.errors.name[0].message }}</code>
            <span v-else class="muted">—</span>
          </td>
        </tr>
        <tr>
          <td><code>z.string()</code></td>
          <td><input v-register="form.register('title')" type="text" placeholder="title" /></td>
          <td>
            <code>{{ fmt(form.values.title) }}</code>
          </td>
          <td>
            <code :class="{ on: form.fields.title.blank }">{{ form.fields.title.blank }}</code>
          </td>
          <td>
            <code v-if="form.errors.title?.[0]">{{ form.errors.title[0].message }}</code>
            <span v-else class="muted">—</span>
          </td>
        </tr>
        <tr>
          <td><code>z.string().min(2)</code> + <code>unset</code></td>
          <td>
            <input v-register="form.register('country')" type="text" placeholder="country" />
          </td>
          <td>
            <code>{{ fmt(form.values.country) }}</code>
          </td>
          <td>
            <code :class="{ on: form.fields.country.blank }">{{ form.fields.country.blank }}</code>
          </td>
          <td>
            <code v-if="form.errors.country?.[0]">{{ form.errors.country[0].message }}</code>
            <span v-else class="muted">—</span>
          </td>
        </tr>
      </tbody>
    </table>

    <p class="hint">
      <code>age</code> auto-marks blank (numeric storage diverges from DOM display).
      <code>name</code> doesn't auto-mark — but the schema's <code>min(1)</code> rejects
      <code>''</code> reactively. <code>title</code> stays calm because the schema accepts the empty
      string. <code>country</code> opted into blank via <code>unset</code>; type in it to clear the
      blank flag.
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
    vertical-align: middle;
  }
  th {
    background: #f9fafb;
    font-weight: 600;
    font-size: 0.75rem;
    color: #6b7280;
  }
  input[type='text'],
  input[type='number'] {
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
  code.on {
    background: #fef3c7;
    color: #92400e;
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
