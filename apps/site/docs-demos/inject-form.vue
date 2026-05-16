<script setup lang="ts">
  import { defineComponent, h, withDirectives } from 'vue'
  import { injectForm, vRegister } from 'attaform'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const schema = z.object({
    email: z.email('Enter a valid email'),
    profile: z.object({
      name: z.string().min(1, 'Name is required'),
      city: z.string(),
    }),
  })

  const form = useForm({
    schema,
    key: 'docs-demo-inject-form',
  })

  const onSubmit = form.handleSubmit(async (values) => {
    alert(
      `Submitted: ${JSON.stringify(values, (_, v) => (v === undefined ? '(undefined)' : v), 2)}`
    )
  })

  type FormShape = z.infer<typeof schema>

  // Distant descendant — pulls the same form from the context registry
  // without needing a single prop passed in.
  const ProfileFieldset = defineComponent({
    name: 'ProfileFieldset',
    setup() {
      const ctx = injectForm<FormShape>('docs-demo-inject-form')!
      return () =>
        h('fieldset', null, [
          h('legend', null, 'Profile (via injectForm)'),
          h('label', null, [
            h('span', null, 'Name'),
            withDirectives(h('input', { type: 'text' }), [
              [vRegister, ctx.register('profile.name')],
            ]),
            ctx.fields.profile.name.showErrors
              ? h('em', null, ctx.fields.profile.name.firstError?.message)
              : null,
          ]),
          h('label', null, [
            h('span', null, 'City'),
            withDirectives(h('input', { type: 'text' }), [
              [vRegister, ctx.register('profile.city')],
            ]),
          ]),
        ])
    },
  })

  // Floating status pill — reads meta from a form it doesn't own.
  const StatusPill = defineComponent({
    name: 'StatusPill',
    setup() {
      const ctx = injectForm<FormShape>('docs-demo-inject-form')!
      return () =>
        h(
          'span',
          { class: ['pill', ctx.meta.valid ? 'ok' : 'pending'] },
          ctx.meta.valid
            ? 'ready'
            : `${ctx.meta.errorCount} error${ctx.meta.errorCount === 1 ? '' : 's'}`
        )
    },
  })
</script>

<template>
  <form @submit.prevent="onSubmit">
    <label>
      Email (in the parent component)
      <input v-register="form.register('email')" autocomplete="email" />
      <em v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</em>
    </label>

    <ProfileFieldset />

    <div class="footer">
      <button type="submit">Submit</button>
      <StatusPill />
    </div>

    <p class="hint">
      The <code>ProfileFieldset</code> and <code>StatusPill</code> components don't receive any
      props — they call <code>injectForm</code> and the registry hands back the same reactive form
      the parent owns.
    </p>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 32rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  :deep(fieldset) {
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    padding: 0.5rem 0.875rem;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  :deep(legend) {
    padding: 0 0.375rem;
    font-size: 0.8125rem;
    color: #6b7280;
  }
  :deep(fieldset label) {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  input,
  :deep(input) {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
    font-family: inherit;
  }
  input:focus,
  :deep(input:focus) {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  em,
  :deep(em) {
    color: #dc2626;
    font-size: 0.8125rem;
    font-style: normal;
    font-weight: 400;
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  button {
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    border: 1px solid #2563eb;
    background: #2563eb;
    color: white;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
  }
  button:hover {
    background: #1d4ed8;
  }
  :deep(.pill) {
    font-size: 0.75rem;
    padding: 0.25rem 0.625rem;
    border-radius: 999px;
    font-family: ui-monospace, monospace;
  }
  :deep(.pill.ok) {
    background: #ecfdf5;
    color: #047857;
    border: 1px solid #6ee7b7;
  }
  :deep(.pill.pending) {
    background: #fef3c7;
    color: #92400e;
    border: 1px solid #fcd34d;
  }
  code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
  }
  .hint {
    margin: 0;
    color: #6b7280;
    font-size: 0.75rem;
  }
</style>
