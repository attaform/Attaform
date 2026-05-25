<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

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
  <div class="grid">
    <div class="col">
      <h4>
        <code>rememberVariants: true</code>
        <small>(default)</small>
      </h4>

      <form @submit.prevent>
        <fieldset>
          <legend>Payment method</legend>
          <label class="radio">
            <input v-register="memoryOn.register('payment.kind')" type="radio" value="card" />
            Card
          </label>
          <label class="radio">
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
        Switch back and the previous variant's typing comes home — memory snapshots ride alongside
        the active state.
      </p>
    </div>

    <div class="col">
      <h4>
        <code>rememberVariants: false</code>
        <small>(every switch starts fresh)</small>
      </h4>

      <form @submit.prevent>
        <fieldset>
          <legend>Payment method</legend>
          <label class="radio">
            <input v-register="memoryOff.register('payment.kind')" type="radio" value="card" />
            Card
          </label>
          <label class="radio">
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
        No memory — every variant switch initialises from the schema's slim default. Type into card,
        switch to bank, switch back: card's typing is gone.
      </p>
    </div>
  </div>
</template>

<style scoped>
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
  }
  @media (max-width: 760px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }
  h4 {
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 500;
    display: flex;
    align-items: baseline;
    gap: 0.375rem;
  }
  h4 small {
    color: #6b7280;
    font-weight: 400;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }
  fieldset {
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    padding: 0.5rem 0.875rem;
    margin: 0;
    display: flex;
    flex-direction: row;
    gap: 1rem;
    align-items: center;
  }
  legend {
    padding: 0 0.375rem;
    font-size: 0.8125rem;
    color: #6b7280;
  }
  .radio {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.875rem;
    font-weight: 500;
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
    font-family: inherit;
  }
  input:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
  }
  .hint {
    margin: 0;
    padding: 0.5rem 0.625rem;
    border-radius: 0.375rem;
    font-size: 0.75rem;
  }
  .hint.ok {
    background: #ecfdf5;
    color: #047857;
    border: 1px solid #6ee7b7;
  }
  .hint.warn {
    background: #fef3c7;
    color: #92400e;
    border: 1px solid #fcd34d;
  }
</style>
