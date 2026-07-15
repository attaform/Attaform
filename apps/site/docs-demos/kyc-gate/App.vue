<script setup lang="ts">
  import { computed } from 'vue'
  import { useForm, useWizard, gate } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

  const transfer = useForm({
    schema: z.object({
      amount: z.number().min(1, 'Enter an amount'),
    }),
    defaultValues: { amount: 500 },
    key: 'kyc-transfer',
  })

  const kyc = useForm({
    schema: z.object({
      idNumber: z.string().min(6, 'Enter your government ID number'),
    }),
    defaultValues: { idNumber: '' },
    key: 'kyc-verify',
  })

  const KYC_THRESHOLD = 10_000

  const wizard = useWizard({
    steps: [
      transfer,
      () => (transfer.values.amount > KYC_THRESHOLD ? gate(kyc) : undefined),
      'review',
    ],
  })

  const needsKyc = computed(() => transfer.values.amount > KYC_THRESHOLD)

  const onFinish = wizard.handleSubmit(async (ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 400))
    toast.success('Transfer sent, thanks!', { description: ctx.values })
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
          <span class="step-label">{{ step.key.replace('kyc-', '') }}</span>
        </button>
      </li>
    </ol>

    <form v-if="wizard.currentStep === 'kyc-transfer'" class="stack" @submit.prevent>
      <label>
        <span>Transfer amount (USD) <span class="required" aria-hidden="true">*</span></span>
        <input v-register="transfer.register('amount')" type="number" inputmode="numeric" />
        <em v-if="transfer.fields.amount.showErrors">{{
          transfer.fields.amount.firstError?.message
        }}</em>
      </label>
      <span class="badge" :class="needsKyc ? 'busy' : 'valid'">
        {{ needsKyc ? 'KYC verification required' : 'No KYC needed under $10,000' }}
      </span>
    </form>

    <form v-else-if="wizard.currentStep === 'kyc-verify'" class="stack" @submit.prevent>
      <p class="terms">
        Transfers above ${{ KYC_THRESHOLD.toLocaleString() }} need identity verification before they
        can be confirmed.
      </p>
      <label>
        <span>Government ID number <span class="required" aria-hidden="true">*</span></span>
        <input v-register="kyc.register('idNumber')" autocomplete="off" />
        <em v-if="kyc.fields.idNumber.showErrors">{{ kyc.fields.idNumber.firstError?.message }}</em>
      </label>
    </form>

    <div v-else class="stack">
      <p class="terms">
        Sending <strong>${{ transfer.values.amount.toLocaleString() }}</strong
        >{{ needsKyc ? ', identity verified.' : '.' }}
      </p>
    </div>

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
        {{ wizard.submitting ? 'Sending…' : 'Send transfer' }}
      </button>
    </div>

    <div v-if="wizard.done" class="banner success" role="status">✓ Transfer sent.</div>

    <p class="hint">
      A conditional gate from one function slot:
      <code>() =&gt; amount &gt; 10_000 ? gate(kyc) : undefined</code>. Small transfers skip
      verification entirely; large ones seal the review step until the KYC form is submitted.
    </p>
  </div>
</template>

<style scoped>
  .demo .step-button {
    text-transform: capitalize;
  }
  .demo form,
  .demo .stack {
    min-height: 9rem;
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
