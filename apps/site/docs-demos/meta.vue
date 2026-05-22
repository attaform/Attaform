<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const schema = z.object({
    email: z.email('Enter a valid email'),
    simulateFailure: z.boolean(),
  })

  const { register, fields, meta, handleSubmit } = useForm({
    schema,
    defaultValues: { simulateFailure: false },
    key: 'docs-demo-meta',
  })

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

  const onSubmit = handleSubmit(async (values) => {
    await wait(600)
    if (values.simulateFailure) {
      throw new Error('Simulated API failure')
    }
  })

  const formatError = (err: unknown) =>
    err === null ? 'null' : err instanceof Error ? err.message : String(err)
</script>

<template>
  <form @submit.prevent="onSubmit">
    <label>
      <span>Email</span>
      <input v-register="register('email')" type="email" autocomplete="email" />
      <em v-if="fields.email.showErrors">{{ fields.email.firstError?.message }}</em>
    </label>

    <label class="check">
      <input v-register="register('simulateFailure')" type="checkbox" />
      Simulate API failure on submit
    </label>

    <button type="submit" :disabled="meta.submitting">
      {{ meta.submitting ? 'Submitting…' : 'Submit' }}
    </button>

    <div class="panel">
      <p class="panel-title">form.meta</p>

      <p class="group-title">Submission state (form-only)</p>
      <table>
        <tbody>
          <tr>
            <th>submitting</th>
            <td>{{ meta.submitting }}</td>
            <th>isSubmitted</th>
            <td>{{ meta.isSubmitted }}</td>
          </tr>
          <tr>
            <th>submitCount</th>
            <td>{{ meta.submitCount }}</td>
            <th>errorCount</th>
            <td>{{ meta.errorCount }}</td>
          </tr>
          <tr>
            <th>submitError</th>
            <td colspan="3">{{ formatError(meta.submitError) }}</td>
          </tr>
          <tr>
            <th>instanceId</th>
            <td colspan="3">{{ meta.instanceId }}</td>
          </tr>
        </tbody>
      </table>

      <p class="group-title">Form-level aggregates (inherited from FieldState)</p>
      <table>
        <tbody>
          <tr>
            <th>dirty</th>
            <td>{{ meta.dirty }}</td>
            <th>pristine</th>
            <td>{{ meta.pristine }}</td>
          </tr>
          <tr>
            <th>touched</th>
            <td>{{ meta.touched }}</td>
            <th>valid</th>
            <td>{{ meta.valid }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 26rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  label.check {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
    font-weight: 400;
  }
  label.check input {
    width: auto;
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
  em {
    color: #dc2626;
    font-size: 0.8125rem;
    font-style: normal;
    font-weight: 400;
  }
  button {
    align-self: flex-start;
    padding: 0.4rem 0.85rem;
    border-radius: 0.375rem;
    border: 1px solid #2563eb;
    background: #2563eb;
    color: #fff;
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: #1d4ed8;
  }
  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .panel {
    margin-top: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .panel-title {
    font-size: 0.75rem;
    font-weight: 600;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0;
  }
  .group-title {
    font-size: 0.6875rem;
    font-weight: 500;
    color: #9ca3af;
    margin: 0.25rem 0 0 0;
  }
  table {
    border-collapse: collapse;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    width: 100%;
  }
  table th,
  table td {
    padding: 0.2rem 0.5rem;
    text-align: left;
    border-bottom: 1px solid #e5e7eb;
    vertical-align: top;
  }
  table th {
    color: #6b7280;
    font-weight: 500;
    white-space: nowrap;
    width: 1%;
  }
  table td {
    color: #111827;
    word-break: break-word;
  }
</style>
