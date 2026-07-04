<script setup lang="ts">
  import { useForm } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

  const schema = z.discriminatedUnion('method', [
    z.object({
      method: z.literal('card'),
      cardNumber: z.string().min(12, 'Enter a valid card number'),
      cvc: z.string().min(3, '3 or 4 digits'),
    }),
    z.object({
      method: z.literal('bank'),
      iban: z.string().min(15, 'Enter a valid IBAN'),
    }),
    z.object({
      method: z.literal('invoice'),
      poNumber: z.string().min(1, 'Purchase order required'),
      netDays: z.number().min(1, 'At least 1 day').max(90, 'At most 90 days'),
    }),
  ])

  const form = useForm({
    schema,
    defaultValues: { method: 'card', cardNumber: '', cvc: '' },
    key: 'docs-demo-variant-forms',
  })

  const onSubmit = form.handleSubmit(async (payment) => {
    toast.success(`Paying by ${payment.method}`, { description: payment })
  })
</script>

<template>
  <form class="demo" @submit.prevent="onSubmit">
    <label>
      Payment method
      <select v-register="form.register('method')">
        <option value="card">Card</option>
        <option value="bank">Bank transfer</option>
        <option value="invoice">Invoice</option>
      </select>
    </label>

    <template v-if="form.values.method === 'card'">
      <label>
        Card number
        <input
          v-register="form.register('cardNumber')"
          inputmode="numeric"
          placeholder="4242 4242 4242 4242"
        />
        <em v-if="form.fields.cardNumber?.showErrors">{{
          form.fields.cardNumber?.firstError?.message
        }}</em>
      </label>
      <label>
        CVC
        <input v-register="form.register('cvc')" inputmode="numeric" placeholder="123" />
        <em v-if="form.fields.cvc?.showErrors">{{ form.fields.cvc?.firstError?.message }}</em>
      </label>
    </template>

    <template v-else-if="form.values.method === 'bank'">
      <label>
        IBAN
        <input v-register="form.register('iban')" placeholder="GB29 NWBK 6016 1331 9268 19" />
        <em v-if="form.fields.iban?.showErrors">{{ form.fields.iban?.firstError?.message }}</em>
      </label>
    </template>

    <template v-else-if="form.values.method === 'invoice'">
      <label>
        Purchase order
        <input v-register="form.register('poNumber')" placeholder="PO-12345" />
        <em v-if="form.fields.poNumber?.showErrors">{{
          form.fields.poNumber?.firstError?.message
        }}</em>
      </label>
      <label>
        Net payment days
        <input v-register="form.register('netDays')" type="number" min="1" max="90" />
        <em v-if="form.fields.netDays?.showErrors">{{
          form.fields.netDays?.firstError?.message
        }}</em>
      </label>
    </template>

    <button type="submit">Pay</button>

    <pre>{{ JSON.stringify(form.values(), null, 2) }}</pre>

    <p class="hint">
      The whole form is one <code>z.discriminatedUnion</code>. Switching the method reshapes storage
      to the chosen variant: the previous variant's keys are purged and the new variant's keys are
      seeded. Refill a variant you visited before and the values come back, that is
      <a href="/docs/writing-and-mutating/variant-memory">variant memory</a>.
    </p>
  </form>
</template>

<style scoped>
  a {
    color: var(--color-accent);
    text-decoration: underline;
  }
</style>
