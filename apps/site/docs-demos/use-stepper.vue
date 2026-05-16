<script setup lang="ts">
  import { useForm, useStepper } from 'attaform/zod'
  import { z } from 'zod'

  const account = useForm({
    schema: z.object({
      email: z.email('Enter a valid email'),
      password: z.string().min(8, 'At least 8 characters'),
    }),
    key: 'docs-demo-stepper-account',
  })

  const profile = useForm({
    schema: z.object({
      name: z.string().min(1, 'Name is required'),
      city: z.string(),
    }),
    key: 'docs-demo-stepper-profile',
  })

  const review = useForm({
    schema: z.object({
      newsletter: z.boolean(),
      tos: z.literal(true, 'Accept the terms to continue'),
    }),
    defaultValues: { newsletter: false, tos: false },
    key: 'docs-demo-stepper-review',
  })

  const stepper = useStepper([account, profile, review] as const)

  async function onFinish() {
    alert(`Welcome ${profile.values.name || profile.values.city || 'aboard'} — submit fired!`)
  }
</script>

<template>
  <div class="wizard">
    <ol class="rail">
      <li
        v-for="(form, i) in stepper.forms"
        :key="form.key"
        :class="{
          done: stepper.statuses[form.key].isValid && stepper.current.value !== form.key,
          current: stepper.current.value === form.key,
        }"
      >
        <span class="step-num">{{ i + 1 }}</span>
        <span class="step-label">{{ form.key.replace('docs-demo-stepper-', '') }}</span>
      </li>
    </ol>

    <div class="progress">
      <div class="progress-fill" :style="{ width: `${stepper.progress.value * 100}%` }"></div>
    </div>

    <form v-if="stepper.current.value === 'docs-demo-stepper-account'" @submit.prevent>
      <label>
        Email
        <input v-register="account.register('email')" type="email" autocomplete="email" />
        <em v-if="account.fields.email.showErrors">{{
          account.fields.email.firstError?.message
        }}</em>
      </label>
      <label>
        Password
        <input
          v-register="account.register('password')"
          type="password"
          autocomplete="new-password"
        />
        <em v-if="account.fields.password.showErrors">{{
          account.fields.password.firstError?.message
        }}</em>
      </label>
    </form>

    <form v-else-if="stepper.current.value === 'docs-demo-stepper-profile'" @submit.prevent>
      <label>
        Name
        <input v-register="profile.register('name')" type="text" />
        <em v-if="profile.fields.name.showErrors">{{ profile.fields.name.firstError?.message }}</em>
      </label>
      <label>
        City
        <input v-register="profile.register('city')" type="text" />
      </label>
    </form>

    <form v-else-if="stepper.current.value === 'docs-demo-stepper-review'" @submit.prevent>
      <label class="checkbox">
        <input v-register="review.register('newsletter')" type="checkbox" />
        Subscribe to the newsletter
      </label>
      <label class="checkbox">
        <input v-register="review.register('tos')" type="checkbox" />
        Accept the terms of service
        <em v-if="review.fields.tos.showErrors">{{ review.fields.tos.firstError?.message }}</em>
      </label>
    </form>

    <div class="actions">
      <button
        type="button"
        class="ghost"
        :disabled="stepper.current.value === stepper.forms[0].key"
        @click="stepper.back()"
      >
        ← Back
      </button>
      <span class="step-of">
        Step {{ stepper.forms.findIndex((f) => f.key === stepper.current.value) + 1 }} of
        {{ stepper.count }}
      </span>
      <button
        v-if="stepper.current.value !== stepper.forms[stepper.forms.length - 1]!.key"
        type="button"
        class="primary"
        @click="stepper.next()"
      >
        Next →
      </button>
      <button v-else type="button" class="primary" @click="onFinish">Finish</button>
    </div>

    <p class="hint">
      Each step is its own <code>useForm</code> with its own schema.
      <code>useStepper</code> orchestrates navigation, aggregates statuses, and exposes
      <code>progress</code> as the fraction of valid steps.
    </p>
  </div>
</template>

<style scoped>
  .wizard {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 32rem;
  }
  .rail {
    display: flex;
    gap: 0.5rem;
    padding: 0;
    margin: 0;
    list-style: none;
  }
  .rail li {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.5rem;
    background: #f3f4f6;
    border-radius: 0.375rem;
    font-size: 0.75rem;
    color: #6b7280;
    text-transform: capitalize;
  }
  .rail li.current {
    background: #dbeafe;
    color: #1e40af;
    font-weight: 500;
  }
  .rail li.done {
    background: #ecfdf5;
    color: #047857;
  }
  .step-num {
    width: 1.25rem;
    height: 1.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    background: white;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
  }
  .progress {
    height: 0.375rem;
    border-radius: 999px;
    background: #f3f4f6;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: #2563eb;
    transition: width 200ms ease;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  label.checkbox {
    flex-direction: row;
    align-items: center;
    font-weight: 400;
  }
  input[type='text'],
  input[type='email'],
  input[type='password'] {
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
  .actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .step-of {
    flex: 1;
    text-align: center;
    font-size: 0.75rem;
    color: #6b7280;
    font-family: ui-monospace, monospace;
  }
  button {
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
  }
  button.primary {
    background: #2563eb;
    color: white;
    border: 1px solid #2563eb;
  }
  button.primary:hover {
    background: #1d4ed8;
  }
  button.ghost {
    background: white;
    color: #374151;
    border: 1px solid #d1d5db;
  }
  button.ghost:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
  }
  .hint {
    margin: 0;
    color: #6b7280;
    font-size: 0.75rem;
  }
</style>
