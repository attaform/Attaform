<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

  const form = useForm({
    schema: z.object({
      plan: z.enum(['starter', 'pro', 'team']),
    }),
    defaultValues: { plan: 'starter' },
    key: 'docs-demo-radio',
  })
</script>

<template>
  <form class="demo" @submit.prevent>
    <fieldset>
      <legend>Plan</legend>
      <label class="row">
        <input v-register="form.register('plan')" type="radio" value="starter" />
        Starter
      </label>
      <label class="row">
        <input v-register="form.register('plan')" type="radio" value="pro" />
        Pro
      </label>
      <label class="row">
        <input v-register="form.register('plan')" type="radio" value="team" />
        Team
      </label>
    </fieldset>

    <pre>{{
      JSON.stringify({ plan: form.values.plan }, (_, v) => (v === undefined ? '(undefined)' : v), 2)
    }}</pre>
  </form>
</template>
