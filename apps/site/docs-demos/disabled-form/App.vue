<script setup lang="ts">
  import { ref } from 'vue'
  import { useForm } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

  const frozen = ref(false)

  const form = useForm({
    schema: z.object({
      fullName: z.string().min(1, 'Your name is required'),
      email: z.email('Enter a valid email'),
      role: z.enum(['engineer', 'designer', 'manager']),
    }),
    defaultValues: { fullName: 'Ada Lovelace', email: 'ada@example.com', role: 'engineer' },
    disabled: frozen,
    key: 'disabled-demo',
  })
</script>

<template>
  <div class="demo">
    <label class="row toggle">
      <input v-model="frozen" type="checkbox" />
      Freeze the form
      <span class="badge" :class="{ on: form.meta.disabled }">
        {{ form.meta.disabled ? 'read-only' : 'editable' }}
      </span>
    </label>

    <form class="stack" @submit.prevent>
      <label>
        <span>Full name</span>
        <input v-register="form.register('fullName')" autocomplete="name" />
      </label>
      <label>
        <span>Email</span>
        <input v-register="form.register('email')" type="email" autocomplete="email" />
      </label>
      <label>
        <span>Role</span>
        <select v-register="form.register('role')">
          <option value="engineer">Engineer</option>
          <option value="designer">Designer</option>
          <option value="manager">Manager</option>
        </select>
      </label>
    </form>

    <pre>{{ form.values }}</pre>

    <p class="hint">
      Flip <code>disabled</code> and every input freezes at once. Attaform sets the native
      <code>disabled</code> attribute on each control, so the greyed, not-allowed look is plain
      <code>input:disabled</code> CSS with nothing wired per field. The freeze reaches the data
      layer too: typing while frozen leaves <code>form.values</code> untouched.
    </p>
  </div>
</template>

<style scoped>
  .demo .toggle {
    align-items: center;
    font-weight: 500;
  }
  .demo .badge.on {
    color: var(--color-accent-soft-fg);
    background: var(--color-accent-soft);
  }
</style>
