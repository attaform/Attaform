<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const schema = z.object({
    email: z.email('Enter a valid email'),
    simulateFailure: z.boolean(),
  })

  const form = useForm({
    schema,
    defaultValues: { simulateFailure: false },
    key: 'docs-demo-form.meta',
  })

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

  const onSubmit = form.handleSubmit(async (values) => {
    await wait(600)
    if (values.simulateFailure) {
      throw new Error('Simulated API failure')
    }
    toast.success(`Submitted as ${values.email}`, { description: values })
  })

  const formatError = (err: unknown) =>
    err === null ? 'null' : err instanceof Error ? err.message : String(err)
</script>

<template>
  <form @submit.prevent="onSubmit">
    <label>
      <span>Email</span>
      <input v-register="form.register('email')" autocomplete="email" />
      <em v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</em>
    </label>

    <label class="check">
      <input v-register="form.register('simulateFailure')" type="checkbox" />
      Simulate API failure on submit
    </label>

    <button type="submit" :disabled="form.meta.submitting">
      {{ form.meta.submitting ? 'Submitting…' : 'Submit' }}
    </button>

    <div class="panel">
      <p class="panel-title">form.form.meta</p>

      <p class="group-title">Submission state (form-only)</p>
      <table>
        <tbody>
          <tr>
            <th>submitting</th>
            <td>{{ form.meta.submitting }}</td>
            <th>submitted</th>
            <td>{{ form.meta.submitted }}</td>
          </tr>
          <tr>
            <th>submissionAttempts</th>
            <td>{{ form.meta.submissionAttempts }}</td>
            <th>errorCount</th>
            <td>{{ form.meta.errorCount }}</td>
          </tr>
          <tr>
            <th>submitError</th>
            <td colspan="3">{{ formatError(form.meta.submitError) }}</td>
          </tr>
          <tr>
            <th>instanceId</th>
            <td colspan="3">{{ form.meta.instanceId }}</td>
          </tr>
        </tbody>
      </table>

      <p class="group-title">Form-level aggregates (inherited from FieldState)</p>
      <table>
        <tbody>
          <tr>
            <th>dirty</th>
            <td>{{ form.meta.dirty }}</td>
            <th>pristine</th>
            <td>{{ form.meta.pristine }}</td>
          </tr>
          <tr>
            <th>touched</th>
            <td>{{ form.meta.touched }}</td>
            <th>valid</th>
            <td>{{ form.meta.valid }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </form>
</template>
