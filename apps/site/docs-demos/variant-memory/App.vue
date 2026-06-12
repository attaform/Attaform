<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

  const schema = z.object({
    payment: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('card'),
        last4: z.string().length(4, 'Four digits'),
        zip: z.string().min(3, 'Postal/ZIP code'),
      }),
      z.object({
        kind: z.literal('bank'),
        routing: z.string().length(9, 'Nine digits'),
        account: z.string().min(6, 'At least 6 digits'),
      }),
    ]),
  })

  const memoryOn = useForm({
    schema,
    defaultValues: { payment: { kind: 'card', last4: '', zip: '' } },
    key: 'docs-demo-variant-memory-on',
  })

  const memoryOff = useForm({
    schema,
    defaultValues: { payment: { kind: 'card', last4: '', zip: '' } },
    key: 'docs-demo-variant-memory-off',
    rememberVariants: false,
  })
</script>

<template>
  <div class="demo grid">
    <div class="stack">
      <h4>
        <code>rememberVariants: true</code>
        <small>(default)</small>
      </h4>

      <form class="stack" @submit.prevent>
        <fieldset>
          <legend>Payment method</legend>
          <label class="row">
            <input v-register="memoryOn.register('payment.kind')" type="radio" value="card" />
            Card
          </label>
          <label class="row">
            <input v-register="memoryOn.register('payment.kind')" type="radio" value="bank" />
            Bank
          </label>
        </fieldset>

        <template v-if="memoryOn.values.payment.kind === 'card'">
          <label>
            Last 4 digits
            <input v-register="memoryOn.register('payment.last4')" maxlength="4" />
          </label>
          <label>
            ZIP / Postal
            <input v-register="memoryOn.register('payment.zip')" />
          </label>
        </template>

        <template v-else>
          <label>
            Routing
            <input v-register="memoryOn.register('payment.routing')" maxlength="9" />
          </label>
          <label>
            Account
            <input v-register="memoryOn.register('payment.account')" />
          </label>
        </template>
      </form>

      <p class="hint ok">
        Switch back and the previous variant's typing comes home. Memory snapshots ride alongside
        the active state.
      </p>
    </div>

    <div class="stack">
      <h4>
        <code>rememberVariants: false</code>
        <small>(every switch starts fresh)</small>
      </h4>

      <form class="stack" @submit.prevent>
        <fieldset>
          <legend>Payment method</legend>
          <label class="row">
            <input v-register="memoryOff.register('payment.kind')" type="radio" value="card" />
            Card
          </label>
          <label class="row">
            <input v-register="memoryOff.register('payment.kind')" type="radio" value="bank" />
            Bank
          </label>
        </fieldset>

        <template v-if="memoryOff.values.payment.kind === 'card'">
          <label>
            Last 4 digits
            <input v-register="memoryOff.register('payment.last4')" maxlength="4" />
          </label>
          <label>
            ZIP / Postal
            <input v-register="memoryOff.register('payment.zip')" />
          </label>
        </template>

        <template v-else>
          <label>
            Routing
            <input v-register="memoryOff.register('payment.routing')" maxlength="9" />
          </label>
          <label>
            Account
            <input v-register="memoryOff.register('payment.account')" />
          </label>
        </template>
      </form>

      <p class="hint warn">
        No memory: every variant switch initialises from the schema's slim default. Type into card,
        switch to bank, switch back: card's typing is gone.
      </p>
    </div>
  </div>
</template>

<style scoped>
  @media (min-width: 760px) {
    .demo.grid {
      grid-template-columns: 1fr 1fr;
    }
  }
  fieldset {
    flex-direction: row;
    align-items: center;
    gap: 1rem;
  }
  h4 {
    margin: 0;
    display: flex;
    align-items: baseline;
    gap: 0.375rem;
    font-size: 0.8125rem;
    font-weight: 500;
  }
  h4 small {
    color: var(--color-fg-muted);
    font-weight: 400;
  }
  .hint.ok {
    padding: 0.5rem 0.625rem;
    border-radius: 0.375rem;
    background: var(--color-success-soft);
    color: var(--color-success);
  }
  .hint.warn {
    padding: 0.5rem 0.625rem;
    border-radius: 0.375rem;
    background: var(--color-warning-soft);
    color: var(--color-warning);
  }
</style>
