<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const form = useForm({
    schema: z.object({
      title: z.string(),
      body: z.string(),
    }),
    defaultValues: { title: '', body: '' },
    key: 'docs-demo-multi-tab-sync',
    multiTab: true,
  })
</script>

<template>
  <form @submit.prevent>
    <p class="hint open">
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
