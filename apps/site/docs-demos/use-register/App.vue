<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import FieldRow from './FieldRow.vue'
  import './styles.css'

  const form = useForm({
    schema: z.object({
      email: z.email('Enter a valid email'),
      handle: z.string().min(2),
    }),
    defaultValues: { handle: '' },
    key: 'docs-demo-use-register',
  })
</script>

<template>
  <section class="demo parent-scope">
    <span class="scope-tag scope-tag--parent">App.vue · parent</span>

    <p class="lede">
      Each <code>FieldRow</code> only takes a <code>label</code> prop. The schema path arrives
      ambiently: the parent below applies <code>v-register</code> to the row, and
      <code>useRegister()</code> inside the row picks it up.
    </p>

    <form class="stack" @submit.prevent>
      <FieldRow v-register="form.register('email')" label="Email" />
      <FieldRow v-register="form.register('handle')" label="Handle" />

      <pre>{{
        JSON.stringify(form.values, (_, v) => (v === undefined ? '(undefined)' : v), 2)
      }}</pre>
    </form>
  </section>
</template>

<style scoped>
  /* Scope-visualization colours are the teaching content here (parent vs
     child), so they stay bespoke rather than collapsing onto the palette.
     Held as demo-local custom properties with explicit dark values, the
     same light/dark pattern the registry tokens use. */
  .parent-scope {
    position: relative;
    max-width: 28rem;
    padding: 2.25rem 1rem 1rem;
    border: 1px dashed var(--scope-line);
    border-radius: 0.5rem;
    background: var(--scope-fill);
    --scope-line: #2563eb;
    --scope-fill: #eff6ff;
    --scope-code: #dbeafe;
    --scope-ink: #1e40af;
  }
  :global(.dark) .parent-scope {
    --scope-line: #3b82f6;
    --scope-fill: #172554;
    --scope-code: #1e3a8a;
    --scope-ink: #bfdbfe;
  }
  .scope-tag {
    position: absolute;
    top: 0;
    left: 0.75rem;
    transform: translateY(-50%);
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
    font-family: ui-monospace, monospace;
    font-size: 0.625rem;
    font-weight: 700;
    letter-spacing: 0.075em;
    text-transform: uppercase;
  }
  .scope-tag--parent {
    background: var(--scope-line);
    color: #fff;
  }
  .lede {
    margin: 0 0 1rem 0;
    font-size: 0.8125rem;
    line-height: 1.5;
    color: var(--scope-ink);
  }
  .lede code {
    padding: 0.05rem 0.35rem;
    border-radius: 0.25rem;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    background: var(--scope-code);
    color: var(--scope-ink);
  }
</style>
