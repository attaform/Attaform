<script setup lang="ts">
  import { useForm } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const takenUsernames = new Set(['ada', 'champ', 'athlete'])

  async function isAvailable(username: string): Promise<boolean> {
    await wait(700)
    return !takenUsernames.has(username.toLowerCase())
  }

  const schema = z.object({
    username: z
      .string()
      .min(3, 'At least 3 characters')
      .refine(async (v) => isAvailable(v), { message: 'That username is taken' }),
  })

  const form = useForm({
    schema,
    key: 'docs-demo-display-state',
  })

  const onSubmit = form.handleSubmit((values) => {
    toast.success(`Welcome, ${values.username}`, { description: values })
  })
</script>

<template>
  <form class="demo" @submit="onSubmit">
    <div class="stack">
      <label>
        <span>Username (taken: ada, champ, athlete)</span>
        <input v-register="form.register('username')" />
      </label>

      <div class="readout">
        <span class="badge" :class="form.fields.username.displayState">
          {{ form.fields.username.displayState }}
        </span>
        <span class="chips">
          <span class="chip" :class="{ on: form.fields.username.showIdle }">showIdle</span>
          <span class="chip" :class="{ on: form.fields.username.showPending }">showPending</span>
          <span class="chip" :class="{ on: form.fields.username.showErrors }">showErrors</span>
          <span class="chip" :class="{ on: form.fields.username.showSuccess }">showSuccess</span>
        </span>
      </div>

      <p class="message" :class="form.fields.username.displayState">
        <template v-if="form.fields.username.showErrors">{{
          form.fields.username.firstError?.message
        }}</template>
        <template v-else-if="form.fields.username.showPending">Checking availability…</template>
        <template v-else>&nbsp;</template>
      </p>
    </div>

    <button type="submit">Submit</button>

    <p class="hint">
      One field, one <code>displayState</code>. Untouched reads <code>idle</code>; blur to open the
      gate, watch the async check rest at <code>pending</code>, then settle on <code>error</code> or
      <code>success</code>. The chips are the <code>show*</code> booleans, exact projections of the
      verdict.
    </p>
  </form>
</template>
