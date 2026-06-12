<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

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
  <form class="demo" @submit.prevent="onSubmit">
    <div class="readout banner" :class="form.meta.displayState">
      <span class="badge" :class="form.meta.displayState">{{ form.meta.displayState }}</span>
      <span>{{ bannerText[form.meta.displayState] }}</span>
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
        <small v-if="form.fields.account.email.showErrors" class="message error">{{
          form.fields.account.email.firstError?.message
        }}</small>
        <small v-else-if="form.fields.account.email.showPending" class="message pending"
          >Checking availability…</small
        >
      </label>

      <label>
        <span>Password</span>
        <input v-register="form.register('account.password')" type="password" />
        <small v-if="form.fields.account.password.showErrors" class="message error">{{
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
        <small v-if="form.fields.profile.name.showErrors" class="message error">{{
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
