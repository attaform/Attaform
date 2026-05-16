<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const schema = z.object({
    notify: z.discriminatedUnion('channel', [
      z.object({
        channel: z.literal('email'),
        address: z.email('Enter a valid email'),
      }),
      z.object({
        channel: z.literal('sms'),
        phone: z.string().min(7, 'At least 7 digits'),
      }),
      z.object({
        channel: z.literal('push'),
        deviceId: z.string().min(8, 'Device IDs are 8+ characters'),
      }),
    ]),
  })

  const form = useForm({
    schema,
    defaultValues: { notify: { channel: 'email', address: '' } },
    key: 'docs-demo-discriminated-unions',
  })

  const onSubmit = form.handleSubmit(async (values) => {
    alert(
      `Submitting: ${JSON.stringify(values, (_, v) => (v === undefined ? '(undefined)' : v), 2)}`
    )
  })
</script>

<template>
  <form @submit.prevent="onSubmit">
    <fieldset>
      <legend>Notify me by</legend>
      <label class="radio">
        <input v-register="form.register('notify.channel')" type="radio" value="email" />
        Email
      </label>
      <label class="radio">
        <input v-register="form.register('notify.channel')" type="radio" value="sms" />
        SMS
      </label>
      <label class="radio">
        <input v-register="form.register('notify.channel')" type="radio" value="push" />
        Push
      </label>
    </fieldset>

    <label v-if="form.values.notify.channel === 'email'">
      Email address
      <input
        v-register="form.register('notify.address')"
        autocomplete="email"
        placeholder="you@example.com"
      />
      <em v-if="form.fields.notify.address.showErrors">{{
        form.fields.notify.address.firstError?.message
      }}</em>
    </label>

    <label v-else-if="form.values.notify.channel === 'sms'">
      Phone number
      <input v-register="form.register('notify.phone')" type="tel" placeholder="+1 555 0000" />
      <em v-if="form.fields.notify.phone.showErrors">{{
        form.fields.notify.phone.firstError?.message
      }}</em>
    </label>

    <label v-else-if="form.values.notify.channel === 'push'">
      Device ID
      <input v-register="form.register('notify.deviceId')" placeholder="abc12345" />
      <em v-if="form.fields.notify.deviceId.showErrors">{{
        form.fields.notify.deviceId.firstError?.message
      }}</em>
    </label>

    <button type="submit">Submit</button>

    <p class="hint">
      Switching the channel reshapes storage to the new variant's slim default — the inactive
      variant's keys are purged, the new variant's keys are seeded. Pop back to email after filling
      in another variant; values come back (that's
      <a href="/docs/writing-and-mutating/variant-memory">variant memory</a>).
    </p>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 30rem;
  }
  fieldset {
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    padding: 0.5rem 0.875rem;
    margin: 0;
    display: flex;
    flex-direction: row;
    gap: 1rem;
    align-items: center;
    flex-wrap: wrap;
  }
  legend {
    padding: 0 0.375rem;
    font-size: 0.8125rem;
    color: #6b7280;
  }
  .radio {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  input[type='text'],
  input[type='email'],
  input[type='tel'] {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
    font-family: inherit;
  }
  input:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  em {
    color: #dc2626;
    font-size: 0.8125rem;
    font-style: normal;
    font-weight: 400;
  }
  button {
    align-self: flex-start;
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    border: 1px solid #2563eb;
    background: #2563eb;
    color: white;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
  }
  button:hover {
    background: #1d4ed8;
  }
  a {
    color: #2563eb;
    text-decoration: underline;
  }
  .hint {
    margin: 0;
    color: #6b7280;
    font-size: 0.75rem;
  }
</style>
