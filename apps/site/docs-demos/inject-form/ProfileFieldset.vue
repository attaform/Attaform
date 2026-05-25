<script setup lang="ts">
  import { injectForm } from 'attaform'
  import type { FormShape } from './schema'

  const ctx = injectForm<FormShape>('docs-demo-inject-form')
</script>

<template>
  <fieldset>
    <legend>Profile (via injectForm)</legend>
    <label>
      <span>Name</span>
      <input v-register="ctx?.register('profile.name')" type="text" />
      <em v-if="ctx?.fields.profile.name.showErrors">
        {{ ctx?.fields.profile.name.firstError?.message }}
      </em>
    </label>
    <label>
      <span>City</span>
      <input v-register="ctx?.register('profile.city')" type="text" />
    </label>
  </fieldset>
</template>
