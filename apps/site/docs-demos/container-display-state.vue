<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const takenEmails = new Set(['ada@team.dev', 'champ@team.dev'])

  async function isAvailable(email: string): Promise<boolean> {
    await wait(700)
    return !takenEmails.has(email.toLowerCase())
  }

  const schema = z.object({
    account: z.object({
      email: z
        .string()
        .email('Enter a valid email')
        .refine(async (v) => isAvailable(v), { message: 'That email is taken' }),
      password: z.string().min(8, 'At least 8 characters'),
    }),
    profile: z.object({
      name: z.string().min(1, 'Tell us your name'),
      nickname: z.string().optional(),
    }),
  })

  const form = useForm({
    schema,
    key: 'docs-demo-container-display-state',
  })

  const bannerText = {
    idle: 'Fill in your details',
    pending: 'Checking…',
    error: 'A few fields need attention',
    success: 'Looking good, ready to submit',
  }

  const onSubmit = form.handleSubmit((values) => {
    toast.success('Account created', { description: values })
  })
</script>

<template>
  <form @submit.prevent="onSubmit">
    <div class="banner" :class="form.meta.displayState">
      <span class="badge" :class="form.meta.displayState">{{ form.meta.displayState }}</span>
      <span class="banner-text">{{ bannerText[form.meta.displayState] }}</span>
      <span class="chips">
        <span class="chip" :class="{ on: form.meta.showIdle }">showIdle</span>
        <span class="chip" :class="{ on: form.meta.showPending }">showPending</span>
        <span class="chip" :class="{ on: form.meta.showErrors }">showErrors</span>
        <span class="chip" :class="{ on: form.meta.showSuccess }">showSuccess</span>
      </span>
    </div>

    <fieldset>
      <legend>
        Account
        <span class="badge" :class="form.fields('account').displayState">{{
          form.fields('account').displayState
        }}</span>
      </legend>

      <label>
        <span>Email (taken: ada@team.dev, champ@team.dev)</span>
        <input v-register="form.register('account.email')" />
        <small v-if="form.fields.account.email.showErrors" class="msg msg--error">{{
          form.fields.account.email.firstError?.message
        }}</small>
        <small v-else-if="form.fields.account.email.showPending" class="msg msg--pending"
          >Checking availability…</small
        >
      </label>

      <label>
        <span>Password</span>
        <input v-register="form.register('account.password')" type="password" />
        <small v-if="form.fields.account.password.showErrors" class="msg msg--error">{{
          form.fields.account.password.firstError?.message
        }}</small>
      </label>
    </fieldset>

    <fieldset>
      <legend>
        Profile
        <span class="badge" :class="form.fields('profile').displayState">{{
          form.fields('profile').displayState
        }}</span>
      </legend>

      <label>
        <span>Name</span>
        <input v-register="form.register('profile.name')" />
        <small v-if="form.fields.profile.name.showErrors" class="msg msg--error">{{
          form.fields.profile.name.firstError?.message
        }}</small>
      </label>

      <label>
        <span>Nickname (optional)</span>
        <input v-register="form.register('profile.nickname')" />
      </label>
    </fieldset>

    <button type="submit" :disabled="form.meta.submitting">
      {{ form.meta.submitting ? 'Creating account…' : 'Create account' }}
    </button>

    <p class="hint">
      Every group carries the same <code>displayState</code> as a leaf, rolled up from its fields. A
      group rests at <code>idle</code> until one of its fields earns a verdict, shows
      <code>pending</code> while any child is checking, flips to <code>error</code> the moment a
      child's error becomes visible, and greens only once every child is earned. An untouched
      optional like Nickname never holds the group back, and a field you have not engaged with yet
      never drags the group into <code>error</code>. <code>form.meta</code> is the same rollup at
      the root, so the banner reflects the whole form. The Create account button binds
      <code>form.meta.submitting</code>, true only during a submit, while the badges read
      <code>displayState</code>.
    </p>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    max-width: 32rem;
  }
  .banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    padding: 0.65rem 0.85rem;
    border-radius: 0.5rem;
    border: 1px solid #e5e7eb;
    background: #f9fafb;
  }
  .banner.error {
    border-color: #fecaca;
    background: #fef2f2;
  }
  .banner.pending {
    border-color: #bfdbfe;
    background: #eff6ff;
  }
  .banner.success {
    border-color: #bbf7d0;
    background: #f0fdf4;
  }
  .banner-text {
    font-size: 0.875rem;
    font-weight: 500;
  }
  fieldset {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    padding: 1rem 1rem 1.15rem;
  }
  legend {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.4rem;
    font-size: 0.875rem;
    font-weight: 600;
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
    margin-left: auto;
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
  .msg {
    font-size: 0.8125rem;
    line-height: 1.2rem;
  }
  .msg--error {
    color: #dc2626;
  }
  .msg--pending {
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
  button:hover:not(:disabled) {
    background: #1d4ed8;
  }
  button:disabled {
    opacity: 0.6;
    cursor: progress;
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
