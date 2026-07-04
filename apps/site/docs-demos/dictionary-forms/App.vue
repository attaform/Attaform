<script setup lang="ts">
  import { ref } from 'vue'
  import { useForm } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

  const ROLES = ['admin', 'editor', 'viewer'] as const

  const form = useForm({
    schema: z.record(
      z.string(),
      z.object({ role: z.enum(ROLES), tier: z.number().min(1, 'min 1').max(5, 'max 5') })
    ),
    defaultValues: {
      ada: { role: 'admin', tier: 3 },
      grace: { role: 'editor', tier: 2 },
      linus: { role: 'viewer', tier: 1 },
    },
    key: 'docs-demo-dictionary-forms',
  })

  const newMember = ref('')

  function addMember(): void {
    const id = newMember.value.trim()
    if (id.length === 0) return
    form.setValue(id, { role: 'viewer', tier: 1 })
    newMember.value = ''
  }

  function removeMember(id: string): void {
    const next = { ...form.values() }
    delete next[id]
    form.setValue(next)
  }
</script>

<template>
  <form class="demo" @submit.prevent>
    <ul class="rows">
      <li v-for="(member, id) in form.record()" :key="id" class="entry">
        <div class="row">
          <code class="token">{{ id }}</code>
          <select v-register="form.register(`${id}.role`)" :aria-label="`Role for ${id}`">
            <option v-for="role in ROLES" :key="role" :value="role">{{ role }}</option>
          </select>
          <input
            v-register="form.register(`${id}.tier`)"
            type="number"
            :aria-label="`Tier for ${id}`"
          />
          <button type="button" title="Remove" @click="removeMember(id)">×</button>
        </div>
        <small v-if="member.showErrors" class="err">{{ member.firstError?.message }}</small>
      </li>
    </ul>

    <div class="actions mono">
      <input v-model="newMember" placeholder="Add a member id" @keydown.enter.prevent="addMember" />
      <button type="button" @click="addMember">form.setValue(id, …)</button>
    </div>

    <p class="hint">
      The schema root is a <code>z.record(…)</code>, so the whole form is the dictionary.
      <code>form.record()</code> with no argument iterates the entries, the keys come from the form
      itself, and <code>form.values</code> is the map you see below.
    </p>

    <pre>{{ JSON.stringify(form.values(), null, 2) }}</pre>
  </form>
</template>

<style scoped>
  .entry {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .token {
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    color: var(--color-fg);
    background: var(--color-surface-2);
    border-radius: 0.25rem;
    padding: 0.15rem 0.5rem;
    min-width: 3.5rem;
    text-align: center;
  }
  .row select {
    flex: 1;
  }
  input[type='number'] {
    width: 4rem;
  }
  .actions input {
    flex: 1;
  }
  .row button {
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 0.25rem;
    border: 1px solid var(--color-border-strong);
    background: var(--color-bg);
    color: var(--color-fg);
    font-size: 0.875rem;
    cursor: pointer;
  }
  .row button:hover {
    background: var(--color-surface-2);
  }
  .err {
    color: var(--color-danger);
    font-size: 0.75rem;
    padding-left: 4rem;
  }
</style>
