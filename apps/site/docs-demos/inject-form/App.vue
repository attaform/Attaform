<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { schema } from './schema'
  import ProfileFieldset from './ProfileFieldset.vue'
  import StatusPill from './StatusPill.vue'

  const form = useForm({
    schema,
    key: 'docs-demo-inject-form',
  })

  const onSubmit = form.handleSubmit(async (values) => {
    toast.success(`Welcome ${values.profile.name}`, { description: values })
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
      props. They call <code>injectForm</code> and the registry hands back the same reactive form
      the parent owns.
    </p>
  </form>
</template>
