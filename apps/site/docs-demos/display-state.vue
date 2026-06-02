<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

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
  <form @submit.prevent="onSubmit">
    <div class="field">
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

      <p
        class="message"
        :class="{
          'message--error': form.fields.username.showErrors,
          'message--pending': form.fields.username.showPending,
        }"
      >
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

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    max-width: 30rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  input {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
  }
  input:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  .readout {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .badge {
    min-width: 4.25rem;
    text-align: center;
    padding: 0.15rem 0.55rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 600;
    font-family: ui-monospace, monospace;
  }
  .badge.idle {
    background: #f3f4f6;
    color: #6b7280;
  }
  .badge.pending {
    background: #dbeafe;
    color: #1d4ed8;
  }
  .badge.error {
    background: #fee2e2;
    color: #dc2626;
  }
  .badge.success {
    background: #dcfce7;
    color: #16a34a;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .chip {
    padding: 0.1rem 0.4rem;
    border-radius: 0.25rem;
    border: 1px solid #e5e7eb;
    font-size: 0.6875rem;
    font-family: ui-monospace, monospace;
    color: #9ca3af;
  }
  .chip.on {
    border-color: #2563eb;
    color: #1d4ed8;
    font-weight: 600;
  }
  .message {
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.25rem;
  }
  .message--error {
    color: #dc2626;
  }
  .message--pending {
    color: #2563eb;
  }
  button {
    align-self: flex-start;
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    border: 1px solid #2563eb;
    background: #2563eb;
    color: #fff;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }
  button:hover {
    background: #1d4ed8;
  }
  .hint {
    font-size: 0.8rem;
    color: #6b7280;
    margin: 0;
    line-height: 1.5;
  }
  .hint code {
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    color: #374151;
  }
</style>
