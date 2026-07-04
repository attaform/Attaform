<script setup lang="ts">
  import { useForm } from 'attaform'
  import { z } from 'zod'
  import InputText from 'primevue/inputtext'
  import Password from 'primevue/password'
  import InputNumber from 'primevue/inputnumber'
  import Rating from 'primevue/rating'
  import './styles.css'

  const schema = z.object({
    username: z.string().min(2),
    password: z.string().min(8),
    age: z.number().int().min(0).max(120),
    rating: z.number().min(0).max(5),
  })

  const form = useForm({
    schema,
    defaultValues: { username: '', password: '', age: 18, rating: 3 },
    key: 'docs-third-party-primevue',
  })
</script>

<template>
  <form class="demo" @submit.prevent>
    <div class="field">
      <small>PrimeVue InputText</small>
      <InputText
        v-register="form.register('username')"
        placeholder="jane.doe"
        autocomplete="username"
      />
      <div class="chips">
        <span class="chip" :class="{ on: form.fields('username')?.connected }">connected</span>
        <span class="chip" :class="{ on: form.fields('username')?.focused }">focused</span>
        <span class="chip" :class="{ on: form.fields('username')?.dirty }">dirty</span>
      </div>
    </div>

    <div class="field">
      <small>PrimeVue Password</small>
      <Password
        v-register="form.register('password')"
        :feedback="false"
        toggle-mask
        placeholder="at least 8"
        :input-props="{ autocomplete: 'new-password' }"
      />
      <div class="chips">
        <span class="chip" :class="{ on: form.fields('password')?.connected }">connected</span>
        <span class="chip" :class="{ on: form.fields('password')?.focused }">focused</span>
        <span class="chip" :class="{ on: form.fields('password')?.dirty }">dirty</span>
      </div>
    </div>

    <div class="field">
      <small>PrimeVue InputNumber</small>
      <InputNumber v-register="form.register('age')" :min="0" :max="120" show-buttons />
      <div class="chips">
        <span class="chip" :class="{ on: form.fields('age')?.connected }">connected</span>
        <span class="chip" :class="{ on: form.fields('age')?.focused }">focused</span>
        <span class="chip" :class="{ on: form.fields('age')?.dirty }">dirty</span>
      </div>
    </div>

    <div class="field">
      <small>PrimeVue Rating</small>
      <Rating v-register="form.register('rating')" />
      <div class="chips">
        <span class="chip" :class="{ on: form.fields('rating')?.connected }">connected</span>
        <span class="chip" :class="{ on: form.fields('rating')?.focused }">focused</span>
        <span class="chip" :class="{ on: form.fields('rating')?.dirty }">dirty</span>
      </div>
    </div>

    <pre>{{ JSON.stringify(form.values, null, 2) }}</pre>
  </form>
</template>

<style>
  /* PrimeVue themes its own components (Aura), so the demo only lays out
     the rows; the .demo tokens drive the captions and state chips. */
  .demo .field {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
</style>
