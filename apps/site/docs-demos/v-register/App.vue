<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

  const form = useForm({
    schema: z.object({
      email: z.email('Enter a valid email'),
    }),
    key: 'v-register',
  })
</script>

<template>
  <form class="demo" @submit.prevent>
    <label>
      Email
      <input v-register="form.register('email')" autocomplete="email" />
      <em v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</em>
    </label>
    <table class="state">
      <tbody>
        <tr>
          <th>form.values.email</th>
          <td>{{ JSON.stringify(form.values.email) }}</td>
        </tr>
        <tr>
          <th>form.fields.email.touched</th>
          <td>{{ form.fields.email.touched }}</td>
        </tr>
        <tr>
          <th>form.fields.email.focused</th>
          <td>{{ form.fields.email.focused }}</td>
        </tr>
        <tr>
          <th>form.fields.email.blurred</th>
          <td>{{ form.fields.email.blurred }}</td>
        </tr>
        <tr>
          <th>form.fields.email.blank</th>
          <td>{{ form.fields.email.blank }}</td>
        </tr>
      </tbody>
    </table>
  </form>
</template>
