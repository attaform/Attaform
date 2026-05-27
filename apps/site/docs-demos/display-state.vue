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
    email: z.email('Enter a valid email'),
  })

  const form = useForm({
    schema,
    validateOn: 'blur',
    key: 'docs-demo-display-state',
  })

  const fields = [
    { path: 'username', label: 'Username (taken: ada, champ, athlete)' },
    { path: 'email', label: 'Email' },
  ] as const

  const onSubmit = form.handleSubmit(() => {})
</script>

<template>
  <form @submit.prevent="onSubmit">
    <div v-for="f in fields" :key="f.path" class="field">
      <label>
        <span>{{ f.label }}</span>
        <input v-register="form.register(f.path)" />
      </label>

      <div class="readout">
        <span class="badge" :class="form.fields(f.path).displayState">
          {{ form.fields(f.path).displayState }}
        </span>
        <span class="chips">
          <span class="chip" :class="{ on: form.fields(f.path).showIdle }">showIdle</span>
          <span class="chip" :class="{ on: form.fields(f.path).showPending }">showPending</span>
          <span class="chip" :class="{ on: form.fields(f.path).showErrors }">showErrors</span>
          <span class="chip" :class="{ on: form.fields(f.path).showSuccess }">showSuccess</span>
        </span>
      </div>

      <em v-if="form.fields(f.path).showErrors">{{ form.fields(f.path).firstError?.message }}</em>
      <small v-else-if="form.fields(f.path).showPending">Checking availability…</small>
    </div>

    <button type="submit">Submit</button>

    <p class="hint">
      Every field resolves to one <code>displayState</code>. An untouched field reads
      <code>idle</code>; blur one to open the gate, watch the async check rest at
      <code>pending</code>, then settle on <code>error</code> or <code>success</code>. Submit to
      open the gate on every field at once.
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
  em {
    color: #dc2626;
    font-size: 0.8125rem;
    font-style: normal;
  }
  small {
    color: #2563eb;
    font-size: 0.75rem;
    font-weight: 500;
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
