<script setup lang="ts">
  import { useForm, useWizard } from 'attaform/zod'
  import { z } from 'zod'

  const account = useForm({
    schema: z.object({
      email: z.email('Enter a valid email'),
      password: z.string().min(8, 'At least 8 characters'),
    }),
    key: 'docs-demo-wizard-account',
  })

  const profile = useForm({
    schema: z.object({
      name: z.string().min(1, 'Name is required'),
      city: z.string(),
    }),
    key: 'docs-demo-wizard-profile',
  })

  const review = useForm({
    schema: z.object({
      newsletter: z.boolean(),
      tos: z.literal(true, 'Accept the terms to continue'),
    }),
    defaultValues: { newsletter: false, tos: false },
    key: 'docs-demo-wizard-review',
  })

  const wizard = useWizard({ steps: [account, profile, review] })

  const onSubmit = wizard.handleSubmit(
    async (ctx) => {
      if (!ctx.isFinal) return
      await new Promise((resolve) => setTimeout(resolve, 400))
      toast.success(`Welcome ${ctx.get(profile).name || 'aboard'}`, { description: ctx.values })
    },
    (errors) => {
      toast.error('Submit blocked, check the errors above.', { description: errors })
    }
  )
</script>

<template>
  <div class="wizard">
    <ol class="rail">
      <li
        v-for="(step, i) in wizard.steps"
        :key="step.key"
        :class="{
          done: wizard.statuses[step.key]?.valid === true && wizard.currentStep !== step.key,
          current: wizard.currentStep === step.key,
        }"
      >
        <button type="button" class="step-button" @click="wizard.goTo(step.key)">
          <span class="step-num">{{ i + 1 }}</span>
          <span class="step-label">{{ step.key.replace('docs-demo-wizard-', '') }}</span>
        </button>
      </li>
    </ol>

    <div class="progress">
      <div class="progress-fill" :style="{ width: `${wizard.progress * 100}%` }"></div>
    </div>

    <form v-if="wizard.currentStep === 'docs-demo-wizard-account'" @submit.prevent>
      <label>
        <span>Email <span class="required" aria-hidden="true">*</span></span>
        <input v-register="account.register('email')" autocomplete="email" />
        <em v-if="account.fields.email.showErrors">{{
          account.fields.email.firstError?.message
        }}</em>
      </label>
      <label>
        <span>Password <span class="required" aria-hidden="true">*</span></span>
        <input v-register="account.register('password')" type="password" autocomplete="off" />
        <em v-if="account.fields.password.showErrors">{{
          account.fields.password.firstError?.message
        }}</em>
      </label>
    </form>

    <form v-else-if="wizard.currentStep === 'docs-demo-wizard-profile'" @submit.prevent>
      <label>
        <span>Name <span class="required" aria-hidden="true">*</span></span>
        <input v-register="profile.register('name')" />
        <em v-if="profile.fields.name.showErrors">{{ profile.fields.name.firstError?.message }}</em>
      </label>
      <label>
        City
        <input v-register="profile.register('city')" />
      </label>
    </form>

    <form v-else-if="wizard.currentStep === 'docs-demo-wizard-review'" @submit.prevent>
      <label class="checkbox">
        <input v-register="review.register('newsletter')" type="checkbox" />
        Subscribe to the newsletter
      </label>
      <label class="checkbox">
        <input v-register="review.register('tos')" type="checkbox" />
        Accept the terms of service <span class="required" aria-hidden="true">*</span>
        <em v-if="review.fields.tos.showErrors">{{ review.fields.tos.firstError?.message }}</em>
      </label>
    </form>

    <div class="actions">
      <button type="button" class="ghost" :disabled="!wizard.canGoBack" @click="wizard.back()">
        ← Back
      </button>
      <span class="step-of">Step {{ wizard.activeIndex + 1 }} of {{ wizard.count }}</span>
      <button
        v-if="!wizard.isFinalStep"
        type="button"
        class="primary"
        :disabled="wizard.submitting"
        @click="wizard.next()"
      >
        Next →
      </button>
      <button v-else type="button" class="primary" :disabled="wizard.submitting" @click="onSubmit">
        {{ wizard.submitting ? 'Submitting…' : 'Finish' }}
      </button>
    </div>

    <div v-if="wizard.done" class="success-card" role="status">
      ✓ Submission sent. Edit any field to revise.
    </div>

    <p class="hint">
      Each step is its own <code>useForm</code> with its own schema.
      <code>useWizard</code> orchestrates navigation, aggregates statuses, and exposes
      <code>progress</code> as the fraction of valid steps.
    </p>
  </div>
</template>
