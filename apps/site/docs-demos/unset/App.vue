<script setup lang="ts">
  import { useForm, unset } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

  const schema = z.object({
    email: z.string(),
    profile: z.object({
      name: z.string(),
      age: z.number(),
    }),
  })

  const form = useForm({
    schema,
    key: 'docs-demo-unset',
  })

  const profileFields = form.fields as unknown as (p: string) => { blank: boolean }
</script>

<template>
  <form class="demo" @submit.prevent>
    <label>
      <span>Email (primitive leaf)</span>
      <input v-register="form.register('email')" />
    </label>

    <fieldset>
      <legend>Profile (container)</legend>
      <label>
        <span>Name</span>
        <input v-register="form.register('profile.name')" />
      </label>
      <label>
        <span>Age</span>
        <input v-register="form.register('profile.age')" type="number" />
      </label>
    </fieldset>

    <div class="actions mono">
      <button type="button" @click="form.setValue('email', unset)">
        setValue('email', unset)
      </button>
      <button type="button" @click="form.setValue('profile', unset)">
        setValue('profile', unset)
      </button>
      <button type="button" @click="form.reset()">reset()</button>
    </div>

    <div class="kv">
      <p>
        <code>form.values</code> =
        <em>{{ JSON.stringify(form.values, null, 2) }}</em>
      </p>
      <p>
        <code>form.blankPaths</code> =
        <em>{{ JSON.stringify([...form.blankPaths.value]) }}</em>
      </p>
      <p>
        <code>form.fields('profile').blank</code> =
        <em>{{ profileFields('profile').blank }}</em>
      </p>
    </div>
  </form>
</template>

<style scoped>
  .kv {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 0.375rem;
    padding: 0.5rem 0.75rem;
    font-size: 0.8125rem;
    font-family: ui-monospace, monospace;
  }
  .kv p {
    margin: 0.2rem 0;
    white-space: pre-wrap;
  }
  .kv code {
    color: var(--color-fg-muted);
  }
  .kv em {
    color: var(--color-accent);
    font-style: normal;
    font-weight: 500;
  }
</style>
