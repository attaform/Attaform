<script setup lang="ts">
  import { unset, useForm } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

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
  <form class="demo" @submit.prevent>
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
            <span v-else class="muted">·</span>
          </td>
        </tr>
        <tr>
          <td><code>z.string().min(1)</code></td>
          <td><input v-register="form.register('name')" placeholder="name" /></td>
          <td>
            <code>{{ fmt(form.values.name) }}</code>
          </td>
          <td>
            <code :class="{ on: form.fields.name.blank }">{{ form.fields.name.blank }}</code>
          </td>
          <td>
            <code v-if="form.errors.name?.[0]">{{ form.errors.name[0].message }}</code>
            <span v-else class="muted">·</span>
          </td>
        </tr>
        <tr>
          <td><code>z.string()</code></td>
          <td><input v-register="form.register('title')" placeholder="title" /></td>
          <td>
            <code>{{ fmt(form.values.title) }}</code>
          </td>
          <td>
            <code :class="{ on: form.fields.title.blank }">{{ form.fields.title.blank }}</code>
          </td>
          <td>
            <code v-if="form.errors.title?.[0]">{{ form.errors.title[0].message }}</code>
            <span v-else class="muted">·</span>
          </td>
        </tr>
        <tr>
          <td><code>z.string().min(2)</code> + <code>unset</code></td>
          <td>
            <input v-register="form.register('country')" placeholder="country" />
          </td>
          <td>
            <code>{{ fmt(form.values.country) }}</code>
          </td>
          <td>
            <code :class="{ on: form.fields.country.blank }">{{ form.fields.country.blank }}</code>
          </td>
          <td>
            <code v-if="form.errors.country?.[0]">{{ form.errors.country[0].message }}</code>
            <span v-else class="muted">·</span>
          </td>
        </tr>
      </tbody>
    </table>

    <p class="hint">
      <code>age</code> auto-marks blank (numeric storage diverges from DOM display).
      <code>name</code> doesn't auto-mark, but the schema's <code>min(1)</code> rejects
      <code>''</code> reactively. <code>title</code> stays calm because the schema accepts the empty
      string. <code>country</code> opted into blank via <code>unset</code>; type in it to clear the
      blank flag.
    </p>
  </form>
</template>
