<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

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
  <div class="demo layout split">
    <form class="stack" @submit.prevent>
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
