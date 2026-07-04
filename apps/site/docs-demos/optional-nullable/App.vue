<script setup lang="ts">
  import { useForm } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

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
  <form class="demo" @submit.prevent>
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
            <span v-else class="muted">·</span>
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
            <span v-else class="muted">·</span>
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
            <span v-else class="muted">·</span>
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
            <span v-else class="muted">·</span>
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
