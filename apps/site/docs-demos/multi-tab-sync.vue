<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import { ref, onMounted } from 'vue'

  const form = useForm({
    schema: z.object({
      title: z.string(),
      body: z.string(),
    }),
    defaultValues: { title: '', body: '' },
    key: 'docs-demo-multi-tab-sync',
    multiTab: true,
  })

  // The standalone playground renders this demo inside a sandboxed
  // <iframe>, where cross-tab sync can't establish. Detect the embed so
  // the instructions point readers at the docs page (top-level, where
  // sync works) rather than asking them to duplicate a tab that won't
  // converge.
  const embedded = ref(false)
  onMounted(() => {
    embedded.value = window.self !== window.top
  })
</script>

<template>
  <form @submit.prevent>
    <p v-if="embedded" class="hint open">
      This standalone playground runs in a sandboxed frame, so cross-tab sync stays local to it.
      Open the <code>multi-tab-sync</code> demo on the docs page in two browser tabs to watch them
      converge. The form still opts in here with <code>multiTab: true</code> on a keyed
      <code>useForm</code>.
    </p>
    <p v-else class="hint open">
      Open this page in a <strong>second tab</strong> (right-click the title and pick
      &quot;Duplicate&quot;), then type in either one. The other tab converges within a microtask.
      The demo opts in with <code>multiTab: true</code> on a keyed <code>useForm</code>; the rest is
      handled for you.
    </p>

    <label>
      Title
      <input v-register="form.register('title')" />
    </label>
    <label>
      Body
      <textarea v-register="form.register('body')" rows="3"></textarea>
    </label>

    <p class="hint">
      Sync activates when <code>multiTab: true</code> is set on a keyed form AND the page is in a
      secure context (HTTPS or localhost). Errors and submit lifecycle stay tab-local; only values
      and blank-paths cross the wire.
    </p>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 32rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  input,
  textarea {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
    font-family: inherit;
  }
  input:focus,
  textarea:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
  }
  .hint {
    margin: 0;
    color: #6b7280;
    font-size: 0.75rem;
  }
  .hint.open {
    padding: 0.5rem 0.75rem;
    background: #ecfeff;
    color: #155e75;
    border-radius: 0.375rem;
    border: 1px solid #a5f3fc;
    font-size: 0.8125rem;
  }
</style>
