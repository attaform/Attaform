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
      <span><code>.lazy</code>: writes on change/blur, not on every keystroke</span>
      <input v-register.lazy="form.register('lazyName')" placeholder="Type, then blur" />
      <small>form.values.lazyName = {{ JSON.stringify(form.values.lazyName) }}</small>
    </label>

    <label>
      <span><code>.trim</code>: strips leading/trailing whitespace before the write</span>
      <input
        v-register.trim="form.register('trimmedSlug')"
        placeholder="Pad with spaces around a word"
      />
      <small>form.values.trimmedSlug = {{ JSON.stringify(form.values.trimmedSlug) }}</small>
    </label>

    <label>
      <span
        ><code>.number</code>: coerces the DOM string to a number before storage, even when the
        input is <code>type="text"</code></span
      >
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
