<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

  const schema = z.object({
    profile: z.object({
      firstName: z.string(),
      lastName: z.string(),
      email: z.email().optional(),
    }),
    age: z.number(),
  })

  const form = useForm({
    schema,
    defaultValues: {
      profile: { firstName: '', lastName: '', email: undefined },
      age: 0,
    },
    key: 'docs-demo-values',
  })
</script>

<template>
  <div class="demo layout split">
    <form class="stack" @submit.prevent>
      <label>
        First name
        <input v-register="form.register('profile.firstName')" />
      </label>
      <label>
        Last name
        <input v-register="form.register('profile.lastName')" />
      </label>
      <label>
        Email
        <input v-register="form.register('profile.email')" />
      </label>
      <label>
        Age
        <input v-register="form.register('age')" type="text" inputmode="numeric" />
      </label>
    </form>

    <div class="panels">
      <section>
        <h4>Leaf reads</h4>
        <dl>
          <dt><code>form.values.profile.firstName</code></dt>
          <dd>{{ JSON.stringify(form.values.profile.firstName) }}</dd>
          <dt><code>form.values.profile.email</code></dt>
          <dd>{{ JSON.stringify(form.values.profile.email) }}</dd>
          <dt><code>form.values.age</code></dt>
          <dd>{{ JSON.stringify(form.values.age) }}</dd>
        </dl>
      </section>

      <section>
        <h4>Container read</h4>
        <p class="hint"><code>form.values.profile</code> returns the whole nested object, live.</p>
        <pre>{{ JSON.stringify(form.values.profile, null, 2) }}</pre>
      </section>

      <section>
        <h4>Whole form</h4>
        <p class="hint"><code>form.values</code> mirrors the schema root.</p>
        <pre>{{ JSON.stringify(form.values, null, 2) }}</pre>
      </section>
    </div>
  </div>
</template>
