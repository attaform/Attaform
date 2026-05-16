<script setup lang="ts">
  import { ref } from 'vue'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const schema = z.object({
    flag: z.boolean().default(true),
    trimmed: z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string()),
    ratio: z.string().transform((v) => Number(v) / 100),
  })

  const form = useForm({
    schema,
    defaultValues: { trimmed: '  hello  ', ratio: '50' },
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
        trimmed (string, preprocess trims at write)
        <input v-register="form.register('trimmed')" type="text" />
      </label>
      <label>
        ratio (string in storage, number on submit)
        <input v-register="form.register('ratio')" type="text" />
      </label>
      <button type="submit">Submit → see post-transform shape</button>
    </form>

    <section>
      <h4>READ — <code>form.values</code></h4>
      <p>Concrete types after defaults / preprocess; transforms NOT yet run.</p>
      <pre>{{ JSON.stringify(form.values, null, 2) }}</pre>
    </section>

    <section>
      <h4>SUBMIT — <code>handleSubmit</code> argument</h4>
      <p>Post-transform output. <code>ratio</code> is a number here.</p>
      <pre v-if="submittedShape">{{ JSON.stringify(submittedShape, null, 2) }}</pre>
      <pre v-else class="placeholder">Submit to populate</pre>
    </section>
  </div>
</template>

<style scoped>
  .layout {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1.25rem;
  }
  @media (min-width: 760px) {
    .layout {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }
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
    font-size: 0.8125rem;
    color: #374151;
  }
  input[type='text'] {
    padding: 0.5rem 0.625rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
    font-family: inherit;
  }
  input:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  button {
    align-self: flex-start;
    padding: 0.5rem 0.875rem;
    border-radius: 0.375rem;
    border: 1px solid #2563eb;
    background: #2563eb;
    color: white;
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
  }
  button:hover {
    background: #1d4ed8;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  h4 {
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 600;
  }
  p {
    margin: 0;
    font-size: 0.75rem;
    color: #6b7280;
  }
  pre {
    margin: 0;
    padding: 0.5rem 0.625rem;
    background: #0f172a;
    color: #a5f3fc;
    border-radius: 0.375rem;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    overflow: auto;
  }
  pre.placeholder {
    background: #f3f4f6;
    color: #9ca3af;
    border: 1px dashed #d1d5db;
    font-style: italic;
  }
  code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
  }
</style>
