<script setup lang="ts">
  import { computed, ref } from 'vue'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import { useAutosave, type SaveStatus } from './useAutosave'

  const schema = z.object({
    email: z.string().email('Enter a valid email'),
    displayName: z.string().min(2, 'At least 2 characters'),
    bio: z.string().max(160, '160 characters max'),
  })

  const form = useForm({ schema, key: 'docs-demo-autosave' })

  const failSaves = ref(false)

  async function save(path: string, value: unknown, signal: AbortSignal) {
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
    if (signal.aborted) return
    if (failSaves.value) {
      toast.error(`Could not save ${path}`)
      throw new Error('server unavailable')
    }
    toast.success(`Saved ${path}`, { description: String(value) })
  }

  const { status, isSaving, failed } = useAutosave(form, ['email', 'displayName', 'bio'], save, {
    debounceMs: 600,
    gateOnValidity: (path) => path !== 'email',
  })

  const fields = [
    { path: 'email', label: 'Email', placeholder: 'ada@example.com' },
    { path: 'displayName', label: 'Display name', placeholder: 'Ada' },
    { path: 'bio', label: 'Bio', placeholder: 'A short bio' },
  ] as const

  const labels: Record<SaveStatus, string> = {
    idle: 'Idle',
    saving: 'Saving…',
    saved: 'Saved',
    error: 'Failed',
  }
  const statusOf = (path: string): SaveStatus => status[path] ?? 'idle'
  const bannerState = computed(() => {
    if (isSaving.value) return 'busy'
    if (failed.value.length > 0) return 'failed'
    if (Object.values(status).some((s) => s === 'saved')) return 'saved'
    return 'idle'
  })
</script>

<template>
  <form class="demo" @submit.prevent>
    <div class="banner" :class="bannerState">
      <span v-if="bannerState === 'busy'">Saving…</span>
      <span v-else-if="bannerState === 'failed'">{{ failed.length }} change(s) failed to save</span>
      <span v-else-if="bannerState === 'saved'">All changes saved</span>
      <span v-else>No changes yet</span>
    </div>

    <p class="lede">
      Email saves as a draft: even an invalid address persists as you type, while Attaform still
      flags it below. Display name and bio gate on validity, holding back until they pass.
    </p>

    <label v-for="field in fields" :key="field.path">
      <span class="row">
        {{ field.label }}
        <span class="status" :class="statusOf(field.path)">{{ labels[statusOf(field.path)] }}</span>
      </span>
      <input
        v-register="form.register(field.path)"
        :placeholder="field.placeholder"
        autocomplete="off"
        spellcheck="false"
      />
      <small v-if="form.fields[field.path]?.showErrors" class="error">
        {{ form.fields[field.path]?.firstError?.message }}
      </small>
    </label>

    <label class="toggle">
      <input type="checkbox" v-model="failSaves" />
      Make saves fail
    </label>
  </form>
</template>

<style scoped>
  .demo {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    color: var(--color-fg);
  }
  .banner {
    padding: 0.45rem 0.7rem;
    border-radius: 0.375rem;
    font-size: 0.75rem;
    font-weight: 500;
  }
  .banner.saved {
    background: var(--color-success-soft);
    color: var(--color-success);
  }
  .banner.busy {
    background: var(--color-warning-soft);
    color: var(--color-warning);
  }
  .banner.failed {
    background: var(--color-danger-soft);
    color: var(--color-danger);
  }
  .banner.idle {
    background: var(--color-surface-2);
    color: var(--color-fg-muted);
  }
  .lede {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--color-fg-muted);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8125rem;
    color: var(--color-fg);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  input {
    padding: 0.5rem 0.625rem;
    border-radius: 0.375rem;
    border: 1px solid var(--color-border);
    background: var(--color-bg);
    color: var(--color-fg);
    font-size: 0.875rem;
    font-family: inherit;
  }
  input:focus {
    outline: 2px solid var(--color-accent);
    outline-offset: -1px;
  }
  .toggle {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.75rem;
    color: var(--color-fg-subtle);
  }
  .toggle input {
    width: auto;
  }
  .error {
    color: var(--color-danger);
    font-size: 0.75rem;
  }
  .status {
    font-weight: 500;
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
    font-size: 0.7rem;
  }
  .status.idle {
    background: var(--color-surface-2);
    color: var(--color-fg-muted);
  }
  .status.saving {
    background: var(--color-warning-soft);
    color: var(--color-warning);
  }
  .status.saved {
    background: var(--color-success-soft);
    color: var(--color-success);
  }
  .status.error {
    background: var(--color-danger-soft);
    color: var(--color-danger);
  }
</style>
