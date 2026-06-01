<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

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
      onSubmit: changeForm.handleSubmit(() => {}),
      caption: 'Checks on every keystroke.',
    },
    {
      mode: 'blur',
      form: blurForm,
      onSubmit: blurForm.handleSubmit(() => {}),
      caption: 'Checks when the field loses focus.',
    },
    {
      mode: 'submit',
      form: submitForm,
      onSubmit: submitForm.handleSubmit(() => {}),
      caption: 'Checks only when you submit.',
    },
  ]
</script>

<template>
  <div class="layout">
    <p class="lede">
      The same schema runs in all three. What changes is <em>when</em>. Type one or two characters
      into each, then tab away or submit, and watch when the message lands.
    </p>

    <div class="modes">
      <section v-for="item in modes" :key="item.mode" class="mode">
        <header>
          <code>validateOn: '{{ item.mode }}'</code>
          <p>{{ item.caption }}</p>
        </header>

        <form @submit.prevent="item.onSubmit">
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

        <div class="readout" :class="{ invalid: item.form.fields.handle.firstError }">
          {{ item.form.fields.handle.firstError?.message ?? 'No error yet' }}
        </div>
      </section>
    </div>

    <p class="note">
      These panels read the raw validation result so the timing is the only variable. In real UI you
      gate what shows with <code>showErrors</code>, which adds its own reveal-on-submit rhythm.
    </p>
  </div>
</template>

<style scoped>
  .layout {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .lede {
    margin: 0;
    font-size: 0.8125rem;
    color: #374151;
  }
  .modes {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.875rem;
  }
  @media (min-width: 720px) {
    .modes {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }
  .mode {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding: 0.875rem;
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    background: #fafafa;
  }
  header {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  header p {
    margin: 0;
    font-size: 0.75rem;
    color: #6b7280;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8125rem;
    color: #374151;
  }
  input {
    padding: 0.5rem 0.625rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
    font-family: inherit;
  }
  input:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  button {
    align-self: flex-start;
    padding: 0.4375rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #2563eb;
    background: #2563eb;
    color: white;
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
  }
  button:hover {
    background: #1d4ed8;
  }
  .readout {
    padding: 0.5rem 0.625rem;
    border-radius: 0.375rem;
    background: #f3f4f6;
    color: #6b7280;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    min-height: 1.25rem;
  }
  .readout.invalid {
    background: #fef2f2;
    color: #b91c1c;
    font-weight: 500;
  }
  .note {
    margin: 0;
    font-size: 0.75rem;
    color: #6b7280;
  }
  code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
  }
</style>
