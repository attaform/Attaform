import { computed, reactive } from 'vue'
import type { FlatPath, GenericForm, UseFormReturnType } from 'attaform'

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (...args: A) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

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

  async function run(path: FlatPath<Form>, value: unknown, signal: AbortSignal) {
    try {
      const gate = typeof gateOnValidity === 'function' ? gateOnValidity(path) : gateOnValidity
      if (gate && !(await form.validateAsync(path)).success) {
        status[path] = 'idle'
        return
      }
      if (signal.aborted) return
      status[path] = 'saving'
      await save(path, value, signal)
      if (signal.aborted) return
      status[path] = 'saved'
    } catch {
      if (!signal.aborted) status[path] = 'error'
    }
  }

  for (const path of paths) {
    const schedule = debounce(
      (value: unknown, signal: AbortSignal) => run(path, value, signal),
      debounceMs
    )
    form.onChange(path, (value, ctx) => schedule(value, ctx.signal))
  }

  return {
    status,
    isSaving: computed(() => Object.values(status).some((s) => s === 'saving')),
    failed: computed(() => paths.filter((path) => status[path] === 'error')),
  }
}
