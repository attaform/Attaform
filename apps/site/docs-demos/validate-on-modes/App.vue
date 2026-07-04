<script setup lang="ts">
  import { useForm } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

  const schema = z.object({
    handle: z.string().min(3, 'At least 3 characters'),
  })

  const changeForm = useForm({
    schema,
    key: 'docs-demo-validate-on-change',
    validateOn: 'change',
    strict: false,
  })
  const blurForm = useForm({
    schema,
    key: 'docs-demo-validate-on-blur',
    validateOn: 'blur',
    strict: false,
  })
  const submitForm = useForm({
    schema,
    key: 'docs-demo-validate-on-submit',
    validateOn: 'submit',
    strict: false,
  })

  const modes = [
    {
      mode: 'change',
      form: changeForm,
      onSubmit: changeForm.handleSubmit((values) =>
        toast.success('Submitted', { description: values })
      ),
      caption: 'Checks on every keystroke.',
    },
    {
      mode: 'blur',
      form: blurForm,
      onSubmit: blurForm.handleSubmit((values) =>
        toast.success('Submitted', { description: values })
      ),
      caption: 'Checks when the field loses focus.',
    },
    {
      mode: 'submit',
      form: submitForm,
      onSubmit: submitForm.handleSubmit((values) =>
        toast.success('Submitted', { description: values })
      ),
      caption: 'Checks only when you submit.',
    },
  ]
</script>

<template>
  <div class="demo layout">
    <p class="lede">
      The same schema runs in all three. What changes is <em>when</em>. Type one or two characters
      into each, then tab away or submit, and watch when the message lands.
    </p>

    <div class="layout split3">
      <section v-for="item in modes" :key="item.mode" class="card">
        <section>
          <code>validateOn: '{{ item.mode }}'</code>
          <p class="hint">{{ item.caption }}</p>
        </section>

        <form class="stack" @submit.prevent="item.onSubmit">
          <label>
            Handle
            <input
              v-register="item.form.register('handle')"
              placeholder="3+ characters"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
          <button type="submit">Submit</button>
        </form>

        <div class="banner" :class="{ error: item.form.fields.handle.firstError }">
          {{ item.form.fields.handle.firstError?.message ?? 'No error yet' }}
        </div>
      </section>
    </div>

    <p class="hint">
      These panels read the raw validation result so the timing is the only variable. In real UI you
      gate what shows with <code>showErrors</code>, which adds its own reveal-on-submit rhythm.
    </p>
  </div>
</template>
