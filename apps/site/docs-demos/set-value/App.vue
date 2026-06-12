<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

  const form = useForm({
    schema: z.object({
      name: z.string(),
      profile: z.object({
        email: z.email(),
        age: z.number(),
      }),
    }),
    defaultValues: { name: '', profile: { email: '', age: 0 } },
    key: 'docs-demo-set-value',
  })
</script>

<template>
  <form class="demo" @submit.prevent>
    <label>
      <span>Name</span>
      <input v-register="form.register('name')" />
    </label>

    <label>
      <span>Email</span>
      <input v-register="form.register('profile.email')" />
    </label>

    <label>
      <span>Age</span>
      <input v-register="form.register('profile.age')" type="number" />
    </label>

    <div class="actions mono">
      <button type="button" @click="form.setValue('name', 'Athlete of the Year')">
        form.setValue('name', '…')
      </button>
      <button type="button" @click="form.setValue(['profile', 'email'], 'champ@attaform.dev')">
        form.setValue(['profile', 'email'], …)
      </button>
      <button type="button" @click="form.setValue('profile.age', (prev) => (prev ?? 0) + 1)">
        form.setValue('profile.age', callback)
      </button>
      <button
        type="button"
        @click="
          form.setValue({
            name: 'Pace of Champions',
            profile: { email: 'reset@attaform.dev', age: 25 },
          })
        "
      >
        form.setValue(wholeForm)
      </button>
    </div>

    <pre>{{ JSON.stringify(form.values, (_, v) => (v === undefined ? '(undefined)' : v), 2) }}</pre>
  </form>
</template>
