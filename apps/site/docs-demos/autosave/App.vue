<script setup lang="ts">
  import { computed, ref } from 'vue'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import { useAutosave, type SaveStatus } from './useAutosave'
  import './styles.css'

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
    pending: 'Pending',
    saving: 'Saving…',
    saved: 'Saved',
    error: 'Failed',
  }
  const statusOf = (path: string): SaveStatus => status[path] ?? 'idle'
  const bannerState = computed(() => {
    if (isSaving.value) return 'busy'
    if (failed.value.length > 0) return 'failed'
    if (Object.values(status).some((s) => s === 'pending')) return 'pending'
    if (Object.values(status).some((s) => s === 'saved')) return 'saved'
    return 'idle'
  })
</script>

<template>
  <form class="demo" @submit.prevent>
    <div class="banner" :class="bannerState">
      <span v-if="bannerState === 'busy'">Saving…</span>
      <span v-else-if="bannerState === 'failed'">{{ failed.length }} change(s) failed to save</span>
      <span v-else-if="bannerState === 'pending'">Saving soon…</span>
      <span v-else-if="bannerState === 'saved'">All changes saved</span>
      <span v-else>No changes yet</span>
    </div>

    <p class="lede">
      Email saves as a draft: even an invalid address persists as you type, while Attaform still
      flags it below. Display name and bio gate on validity, holding back until they pass.
    </p>

    <label v-for="field in fields" :key="field.path">
      <span class="spread">
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

    <label class="row compact">
      <input v-model="failSaves" type="checkbox" />
      Make saves fail
    </label>
  </form>
</template>
