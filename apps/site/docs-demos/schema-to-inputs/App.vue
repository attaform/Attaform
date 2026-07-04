<script setup lang="ts">
  import { useForm } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

  const COUNTRIES = {
    US: 'United States of America',
    CA: 'Canada',
    MX: 'Mexico',
    GB: 'United Kingdom',
    DE: 'Germany',
    FR: 'France',
    JP: 'Japan',
  } as const

  const form = useForm({
    schema: z.object({
      fullName: z.string().min(2, 'Tell us your name'),
      age: z.number().int().min(13, '13 or older to sign up'),
      country: z
        .string()
        .default('')
        .refine((v) => v in COUNTRIES, {
          message: 'Please select a country from the dropdown',
        }),
      newsletter: z.boolean(),
      bio: z.string().optional(),
    }),
    key: 'schema-to-inputs',
  })
</script>

<template>
  <form class="demo" @submit.prevent>
    <label>
      Full name
      <input v-register="form.register('fullName')" autocomplete="name" />
      <em v-if="form.fields.fullName.showErrors">{{ form.fields.fullName.firstError?.message }}</em>
    </label>
    <label>
      Age
      <input v-register="form.register('age')" type="number" />
      <em v-if="form.fields.age.showErrors">{{ form.fields.age.firstError?.message }}</em>
    </label>
    <label>
      Country
      <select v-register="form.register('country')">
        <option value="">- Select a country -</option>
        <option v-for="(name, code) in COUNTRIES" :key="code" :value="code">{{ name }}</option>
      </select>
      <em v-if="form.fields.country.showErrors">{{ form.fields.country.firstError?.message }}</em>
    </label>
    <label class="row">
      <input v-register="form.register('newsletter')" type="checkbox" />
      Send me the monthly newsletter
    </label>
    <label>
      Bio <span class="hint">(optional)</span>
      <textarea v-register="form.register('bio')" rows="3"></textarea>
    </label>
    <pre>{{ JSON.stringify(form.values, (_, v) => (v === undefined ? '(undefined)' : v), 2) }}</pre>
  </form>
</template>
