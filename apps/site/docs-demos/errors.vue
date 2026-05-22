<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const schema = z.object({
    name: z.string().min(1, 'Name is required'),
    email: z.email('Enter a valid email'),
    profile: z
      .object({
        bio: z.string().max(50, 'Keep it under 50 chars'),
        handle: z.string().min(1, 'Pick a handle'),
      })
      .refine(
        (p) => p.handle.length === 0 || p.bio.toLowerCase().includes(p.handle.toLowerCase()),
        { message: 'Bio must mention your handle.' }
      ),
  })

  const form = useForm({
    schema,
    defaultValues: {
      name: '',
      email: 'not-an-email',
      profile: { bio: 'A'.repeat(60), handle: 'ozzyfromspace' },
    },
    key: 'docs-demo-errors',
  })
</script>

<template>
  <div class="layout">
    <form @submit.prevent>
      <label>
        Name
        <input v-register="form.register('name')" />
      </label>
      <label>
        Email
        <input v-register="form.register('email')" />
      </label>
      <label>
        Bio
        <input v-register="form.register('profile.bio')" />
      </label>
      <label>
        Handle
        <input v-register="form.register('profile.handle')" />
      </label>
    </form>

    <div class="panels">
      <section>
        <h4>Leaf reads</h4>
        <dl>
          <dt><code>form.errors.name[0]?.message</code></dt>
          <dd>{{ JSON.stringify(form.errors.name[0]?.message ?? null) }}</dd>
          <dt><code>form.errors.email[0]?.message</code></dt>
          <dd>{{ JSON.stringify(form.errors.email[0]?.message ?? null) }}</dd>
          <dt><code>form.errors.profile.bio[0]?.message</code></dt>
          <dd>{{ JSON.stringify(form.errors.profile.bio[0]?.message ?? null) }}</dd>
          <dt><code>form.errors.profile[''][0]?.message</code></dt>
          <dd>{{ JSON.stringify(form.errors.profile[''][0]?.message ?? null) }}</dd>
        </dl>
      </section>

      <section>
        <h4>Container read</h4>
        <p class="hint"
          ><code>form.errors.profile</code> materialises the live sub-tree. Container-self errors
          (the refine on <code>profile</code>) sit at the <code>''</code> sentinel slot alongside
          descendant leaves.</p
        >
        <pre>{{ JSON.stringify(form.errors.profile, null, 2) }}</pre>
      </section>

      <section>
        <h4>Whole form</h4>
        <p class="hint"
          ><code>form.errors</code> materialises the full sparse tree of errors across the
          schema.</p
        >
        <pre>{{ JSON.stringify(form.errors, null, 2) }}</pre>
      </section>
    </div>
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
  input {
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
  .panels {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.875rem;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  h4 {
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .hint {
    margin: 0;
    font-size: 0.75rem;
    color: #6b7280;
  }
  dl {
    margin: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0.25rem;
  }
  dt {
    font-size: 0.75rem;
    color: #6b7280;
  }
  dd {
    margin: 0;
    padding: 0.375rem 0.5rem;
    background: #0f172a;
    color: #fda4af;
    border-radius: 0.375rem;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    overflow: auto;
  }
  code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
  }
  pre {
    margin: 0;
    padding: 0.5rem 0.625rem;
    background: #0f172a;
    color: #fda4af;
    border-radius: 0.375rem;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    overflow: auto;
  }
</style>
