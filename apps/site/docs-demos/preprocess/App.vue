<script setup lang="ts">
  import { computed, ref } from 'vue'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

  const normalize = (v: unknown): unknown => (typeof v === 'string' ? v.trim().toLowerCase() : v)

  const schema = z.object({
    email: z.preprocess(normalize, z.email('Use the format you@domain.com')),
  })

  const form = useForm({
    schema,
    key: 'docs-demo-preprocess',
  })

  const parsePreview = computed(() => normalize(form.values.email))

  const submittedShape = ref<unknown>(null)
  const onSubmit = form.handleSubmit((data) => {
    submittedShape.value = data
  })
</script>

<template>
  <div class="demo layout">
    <form class="stack" @submit.prevent="onSubmit">
      <label>
        Email
        <input
          v-register="form.register('email')"
          placeholder="  Ada@Example.COM "
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      <p v-if="form.fields.email.showErrors" class="error" role="alert">
        {{ form.fields.email.firstError?.message }}
      </p>
      <p v-else class="hint">
        Try stray whitespace or mixed case. Preprocess normalises before the email check runs;
        storage keeps what you typed.
      </p>

      <button type="submit">Submit</button>
    </form>

    <section>
      <h4>READ: <code>form.values.email</code></h4>
      <p>Storage holds your raw input verbatim. Preprocess has not run yet.</p>
      <pre>{{
        form.values.email === '' || form.values.email === undefined
          ? '(empty)'
          : JSON.stringify(form.values.email)
      }}</pre>
    </section>

    <section>
      <h4>PREVIEW: what preprocess returns</h4>
      <p>
        Recomputed live for the demo. The real call happens inside validation and submit; this is
        the value they see.
      </p>
      <pre>{{ JSON.stringify(parsePreview) }}</pre>
    </section>

    <section v-if="submittedShape">
      <h4>SUBMIT: <code>handleSubmit</code> argument</h4>
      <p>Post-parse output. The trimmed, lowercased email is what your handler receives.</p>
      <pre>{{ JSON.stringify(submittedShape, null, 2) }}</pre>
    </section>
  </div>
</template>

<style scoped>
  @media (min-width: 760px) {
    .demo.layout {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }
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
  section p {
    margin: 0;
    font-size: 0.75rem;
    color: var(--color-fg-muted);
  }
</style>
