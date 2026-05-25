<script setup lang="ts">
  import { ref } from 'vue'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const formatPhone = (v: unknown): unknown => {
    if (typeof v !== 'string') return v
    const digits = v.replace(/\D/g, '')
    return digits.length === 10
      ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
      : v
  }

  const schema = z.object({
    flag: z.boolean().default(true),
    phone: z.preprocess(formatPhone, z.string()),
    ratio: z.string().transform((v) => Number(v) / 100),
  })

  const form = useForm({
    schema,
    defaultValues: { phone: '5551234567', ratio: '50' },
    key: 'docs-demo-storage-shape',
  })

  const submittedShape = ref<unknown>(null)
  const onSubmit = form.handleSubmit(async (values) => {
    submittedShape.value = values
  })
</script>

<template>
  <div class="layout">
    <form @submit.prevent="onSubmit">
      <label>
        flag (boolean)
        <input v-register="form.register('flag')" type="checkbox" />
      </label>
      <label>
        phone (raw in storage, formatted at submit)
        <input v-register="form.register('phone')" />
      </label>
      <label>
        ratio (string in storage, number at submit)
        <input v-register="form.register('ratio')" />
      </label>
      <button type="submit">Submit to see the parsed shape</button>
    </form>

    <section>
      <h4>READ: <code>form.values</code></h4>
      <p
        >Concrete types after defaults resolve. Preprocess + transforms have NOT run; storage holds
        raw input.</p
      >
      <pre>{{
        JSON.stringify(form.values, (_, v) => (v === undefined ? '(undefined)' : v), 2)
      }}</pre>
    </section>

    <section>
      <h4>SUBMIT: <code>handleSubmit</code> argument</h4>
      <p>Post-parse output. <code>phone</code> is formatted, <code>ratio</code> is a number.</p>
      <pre v-if="submittedShape">{{
        JSON.stringify(submittedShape, (_, v) => (v === undefined ? '(undefined)' : v), 2)
      }}</pre>
      <pre v-else class="placeholder">Submit to populate</pre>
    </section>
  </div>
</template>
