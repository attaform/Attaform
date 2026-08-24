import { computed, nextTick, reactive, watch } from 'vue'
import type { FlatPath, GenericForm, UseFormReturnType } from 'attaform'

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

export function useAutosave<Form extends GenericForm>(
  form: UseFormReturnType<Form>,
  paths: readonly FlatPath<Form>[],
  save: (path: FlatPath<Form>, value: unknown, signal: AbortSignal) => Promise<void>,
  options: {
    debounceMs?: number
    gateOnValidity?: boolean | ((path: FlatPath<Form>) => boolean)
  } = {}
) {
  const { debounceMs = 600, gateOnValidity = true } = options
  const status = reactive<Record<string, SaveStatus>>({})
  for (const path of paths) status[path] = 'idle'

  let paused = false

  async function run(path: FlatPath<Form>, value: unknown, signal: AbortSignal) {
    try {
      const gate = typeof gateOnValidity === 'function' ? gateOnValidity(path) : gateOnValidity
      if (gate && !(await form.parse(path, { commit: true })).success) {
        status[path] = 'idle'
        return
      }
      if (signal.aborted) return
      status[path] = 'saving'
      await save(path, value, signal)
      if (!signal.aborted) status[path] = 'saved'
    } catch {
      if (!signal.aborted) status[path] = 'error'
    }
  }

  for (const path of paths) {
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    watch(form.toRef(path), (value) => {
      if (paused) return
      status[path] = 'pending'
      controller?.abort()
      controller = new AbortController()
      const { signal } = controller
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void run(path, value, signal), debounceMs)
    })
  }

  function runWithoutAutosave(write: () => void) {
    paused = true
    try {
      write()
    } finally {
      void nextTick(() => {
        paused = false
      })
    }
  }

  return {
    status,
    isSaving: computed(() => Object.values(status).some((s) => s === 'saving')),
    failed: computed(() => paths.filter((path) => status[path] === 'error')),
    runWithoutAutosave,
  }
}
