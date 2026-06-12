<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

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
    toast.success(`Notify via ${values.notify.channel}`, { description: values })
  })
</script>

<template>
  <form class="demo" @submit.prevent="onSubmit">
    <fieldset>
      <legend>Notify me by</legend>
      <label class="row">
        <input v-register="form.register('notify.channel')" type="radio" value="email" />
        Email
      </label>
      <label class="row">
        <input v-register="form.register('notify.channel')" type="radio" value="sms" />
        SMS
      </label>
      <label class="row">
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
      <em v-if="form.fields.notify.address?.showErrors">{{
        form.fields.notify.address?.firstError?.message
      }}</em>
    </label>

    <label v-else-if="form.values.notify.channel === 'sms'">
      Phone number
      <input v-register="form.register('notify.phone')" type="tel" placeholder="+1 555 0000" />
      <em v-if="form.fields.notify.phone?.showErrors">{{
        form.fields.notify.phone?.firstError?.message
      }}</em>
    </label>

    <label v-else-if="form.values.notify.channel === 'push'">
      Device ID
      <input v-register="form.register('notify.deviceId')" placeholder="abc12345" />
      <em v-if="form.fields.notify.deviceId?.showErrors">{{
        form.fields.notify.deviceId?.firstError?.message
      }}</em>
    </label>

    <button type="submit">Submit</button>

    <p class="hint">
      Switching the channel reshapes storage to the new variant's slim default: the inactive
      variant's keys are purged, the new variant's keys are seeded. Pop back to email after filling
      in another variant; values come back (that's
      <a href="/docs/writing-and-mutating/variant-memory">variant memory</a>).
    </p>
  </form>
</template>

<style scoped>
  fieldset {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 1rem;
  }
  a {
    color: var(--color-accent);
    text-decoration: underline;
  }
</style>
