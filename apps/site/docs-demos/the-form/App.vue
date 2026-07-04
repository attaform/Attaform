<script setup lang="ts">
  import { useForm } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

  const schema = z.object({
    email: z.email('Enter a valid email'),
    name: z.string().min(2, 'At least 2 characters'),
  })

  const form = useForm({
    schema,
    defaultValues: { email: '', name: '' },
    key: 'docs-demo-the-form',
  })

  const onSubmit = form.handleSubmit(async (values) => {
    await new Promise((r) => setTimeout(r, 500))
    toast.success('Saved', { description: values })
  })
</script>

<template>
  <div class="demo layout split">
    <form class="stack" @submit.prevent="onSubmit">
      <label>
        Email
        <input v-register="form.register('email')" autocomplete="email" />
        <em v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</em>
      </label>
      <label>
        Name
        <input v-register="form.register('name')" autocomplete="name" />
        <em v-if="form.fields.name.showErrors">{{ form.fields.name.firstError?.message }}</em>
      </label>
      <div class="actions">
        <button type="submit" class="primary" :disabled="form.meta.submitting">
          {{ form.meta.submitting ? 'Saving…' : 'Submit' }}
        </button>
        <button type="button" @click="form.reset()">Reset</button>
        <button type="button" @click="form.clear()">Clear</button>
      </div>
    </form>

    <div class="panels">
      <section>
        <h4><code>form.values</code></h4>
        <pre>{{ JSON.stringify(form.values, null, 2) }}</pre>
      </section>

      <section>
        <h4><code>form.errors</code></h4>
        <pre>{{
          JSON.stringify({ email: form.errors.email, name: form.errors.name }, null, 2)
        }}</pre>
      </section>

      <section>
        <h4><code>form.meta</code></h4>
        <pre>{{
          JSON.stringify(
            {
              dirty: form.meta.dirty,
              valid: form.meta.valid,
              errorCount: form.meta.errorCount,
              submitting: form.meta.submitting,
              submissionAttempts: form.meta.submissionAttempts,
              submitted: form.meta.submitted,
            },
            null,
            2
          )
        }}</pre>
      </section>
    </div>
  </div>
</template>
