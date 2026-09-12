<script setup lang="ts">
  import { useForm } from 'attaform'
  import { schema } from '#shared/schema'

  const form = useForm({ schema, key: 'repro' })
</script>

<template>
  <form id="repro" @submit="form.handleSubmit(() => {})">
    <label id="lbl" for="firstName">{{ form.fields.firstName.label }}</label>
    <input id="firstName" v-register="form.register('firstName')" name="firstName" type="text" />
  </form>
</template>
