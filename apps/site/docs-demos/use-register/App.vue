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
