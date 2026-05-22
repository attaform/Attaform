<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const { register, values } = useForm({
    schema: z.object({
      plan: z.enum(['starter', 'pro', 'team']),
    }),
    defaultValues: { plan: 'starter' },
    key: 'docs-demo-radio',
  })
</script>

<template>
  <form @submit.prevent>
    <fieldset>
      <legend>Plan</legend>
      <label class="row">
        <input v-register="register('plan')" type="radio" value="starter" />
        Starter
      </label>
      <label class="row">
        <input v-register="register('plan')" type="radio" value="pro" />
        Pro
      </label>
      <label class="row">
        <input v-register="register('plan')" type="radio" value="team" />
        Team
      </label>
    </fieldset>

    <pre>{{ JSON.stringify({ plan: values.plan }, null, 2) }}</pre>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 26rem;
  }
  fieldset {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    border: 1px solid #e5e7eb;
    border-radius: 0.375rem;
    padding: 0.6rem 0.75rem;
  }
  legend {
    padding: 0 0.4rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    font-weight: 400;
  }
  input {
    margin: 0;
  }
  pre {
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 0.375rem;
    padding: 0.5rem 0.75rem;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    color: #111827;
    margin: 0;
  }
</style>
