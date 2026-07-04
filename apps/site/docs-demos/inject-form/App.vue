<script setup lang="ts">
  import { useForm } from 'attaform'
  import { schema } from './schema'
  import ProfileFieldset from './ProfileFieldset.vue'
  import StatusPill from './StatusPill.vue'
  import './styles.css'

  const form = useForm({
    schema,
    key: 'docs-demo-inject-form',
  })

  const onSubmit = form.handleSubmit(async (values) => {
    toast.success(`Welcome ${values.profile.name}`, { description: values })
  })
</script>

<template>
  <form class="demo" @submit.prevent="onSubmit">
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
      props. They call <code>injectForm</code> and the registry hands back the same reactive form
      the parent owns.
    </p>

    <pre>{{ JSON.stringify(form.values, (_, v) => (v === undefined ? '(undefined)' : v), 2) }}</pre>
  </form>
</template>

<style scoped>
  .footer {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .footer button {
    margin-top: 0;
    align-self: auto;
  }
</style>
