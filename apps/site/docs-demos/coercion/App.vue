<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

  const form = useForm({
    schema: z.object({
      count: z.number(),
      enabled: z.boolean(),
    }),
    defaultValues: { count: 0, enabled: false },
    key: 'docs-demo-coercion',
  })
</script>

<template>
  <form class="demo" @submit.prevent>
    <label>
      <span><code>count</code>: schema is <code>z.number()</code></span>
      <input v-register="form.register('count')" placeholder="Type a number…" />
      <small
        >Stored as: <em>{{ JSON.stringify(form.values.count) }}</em> ({{
          typeof form.values.count
        }})</small
      >
    </label>

    <label>
      <span><code>enabled</code>: schema is <code>z.boolean()</code></span>
      <input v-register.lazy="form.register('enabled')" placeholder="Type 'true' or 'false'" />
      <small
        >Stored as: <em>{{ JSON.stringify(form.values.enabled) }}</em> ({{
          typeof form.values.enabled
        }})</small
      >
    </label>

    <p class="hint">
      Both inputs are <code>type="text"</code>. The default coercion registry handles
      string&nbsp;→&nbsp;number and string&nbsp;→&nbsp;boolean automatically.
    </p>
  </form>
</template>
