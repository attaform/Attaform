<script setup lang="ts">
  import { useForm, useWizard } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

  const consent = useForm({
    schema: z.object({
      accepted: z.boolean().refine((value) => value, 'Accept the terms to continue'),
    }),
    defaultValues: { accepted: false },
    key: 'gate-consent',
  })

  const shipping = useForm({
    schema: z.object({
      address: z.string().min(1, 'Address is required'),
      city: z.string().min(1, 'City is required'),
    }),
    key: 'gate-shipping',
  })

  const payment = useForm({
    schema: z.object({
      cardNumber: z.string().min(12, 'Enter a card number'),
    }),
    key: 'gate-payment',
  })

  const wizard = useWizard({
    steps: [consent, shipping, payment],
    locked: (ctx) => (consent.values.accepted ? [] : ctx.after('gate-consent')),
  })

  const onFinish = wizard.handleSubmit(async (ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 400))
    toast.success('Order confirmed, thanks!', { description: ctx.values })
  })
</script>

<template>
  <div class="demo">
    <ol class="rail">
      <li
        v-for="(step, i) in wizard.steps"
        :key="step.key"
        :class="{
          done: wizard.statuses[step.key]?.valid === true && wizard.currentStep !== step.key,
          current: wizard.currentStep === step.key,
          locked: wizard.statuses[step.key]?.locked === true,
        }"
      >
        <button
          type="button"
          class="step-button"
          :disabled="wizard.statuses[step.key]?.locked === true"
          @click="wizard.goTo(step.key)"
        >
          <span class="step-num">
            <template v-if="wizard.statuses[step.key]?.locked === true">🔒</template>
            <template v-else>{{ i + 1 }}</template>
          </span>
          <span class="step-label">{{ step.key.replace('gate-', '') }}</span>
        </button>
      </li>
    </ol>

    <div class="progress">
      <div class="progress-fill" :style="{ width: `${wizard.progress * 100}%` }"></div>
    </div>

    <form v-if="wizard.currentStep === 'gate-consent'" class="stack" @submit.prevent>
      <p class="terms">
        By continuing you agree to the terms of service and privacy policy. Every step after this
        one stays locked until you accept.
      </p>
      <label class="row">
        <input v-register="consent.register('accepted')" type="checkbox" />
        I accept the terms of service <span class="required" aria-hidden="true">*</span>
      </label>
      <em v-if="consent.fields.accepted.showErrors">{{
        consent.fields.accepted.firstError?.message
      }}</em>
    </form>

    <form v-else-if="wizard.currentStep === 'gate-shipping'" class="stack" @submit.prevent>
      <label>
        <span>Address <span class="required" aria-hidden="true">*</span></span>
        <input v-register="shipping.register('address')" autocomplete="street-address" />
        <em v-if="shipping.fields.address.showErrors">{{
          shipping.fields.address.firstError?.message
        }}</em>
      </label>
      <label>
        <span>City <span class="required" aria-hidden="true">*</span></span>
        <input v-register="shipping.register('city')" autocomplete="address-level2" />
        <em v-if="shipping.fields.city.showErrors">{{
          shipping.fields.city.firstError?.message
        }}</em>
      </label>
    </form>

    <form v-else-if="wizard.currentStep === 'gate-payment'" class="stack" @submit.prevent>
      <label>
        <span>Card number <span class="required" aria-hidden="true">*</span></span>
        <input
          v-register="payment.register('cardNumber')"
          inputmode="numeric"
          autocomplete="cc-number"
        />
        <em v-if="payment.fields.cardNumber.showErrors">{{
          payment.fields.cardNumber.firstError?.message
        }}</em>
      </label>
    </form>

    <div class="wizard-nav">
      <button type="button" class="ghost" :disabled="!wizard.canGoBack" @click="wizard.back()">
        ← Back
      </button>
      <span class="step-of">Step {{ wizard.activeIndex + 1 }} of {{ wizard.count }}</span>
      <button
        v-if="!wizard.isFinalStep"
        type="button"
        class="primary"
        :disabled="wizard.submitting"
        @click="wizard.tryNext()"
      >
        Next →
      </button>
      <button v-else type="button" class="primary" :disabled="wizard.submitting" @click="onFinish">
        {{ wizard.submitting ? 'Submitting…' : 'Place order' }}
      </button>
    </div>

    <div v-if="wizard.done" class="banner success" role="status">
      ✓ Order placed. Thanks for confirming.
    </div>

    <p class="hint">
      One <code>locked</code> policy gates the whole flow:
      <code>consent.values.accepted ? [] : ctx.after('gate-consent')</code>. Until the box is
      checked every later step is frozen and unreachable, even by a direct link.
    </p>
  </div>
</template>

<style scoped>
  .demo .step-button {
    text-transform: capitalize;
  }
  .demo form {
    min-height: 11rem;
  }
  .demo .rail li.locked .step-button {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .demo .terms {
    margin: 0;
    color: var(--color-fg-muted);
    line-height: 1.5;
  }
</style>
