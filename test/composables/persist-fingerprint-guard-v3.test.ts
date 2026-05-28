// @vitest-environment jsdom
import { createApp, defineComponent, h } from 'vue'
import { describe, expect, it } from 'vitest'
import { z } from 'zod-v3'
import { useForm } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { FormStorage } from '../../src/runtime/types/types-api'

/**
 * SF1 call-site guard. A Zod v3 `z.nativeEnum` field makes the v3
 * adapter's fingerprint() spread the enum OBJECT (`[...def.values]`),
 * throwing TypeError. wirePersistence calls fingerprint() to build the
 * storage key at mount, so a v3 form with persist + a native-enum field
 * crashed the whole mount. The call-site guard turns that into a
 * dev-warned fallback (the proper fingerprint fix is Phase 9 / SF1
 * proper). A custom in-memory adapter is used so persistence wires
 * without a secure-context override.
 */

function memoryStorage(): FormStorage {
  const store = new Map<string, unknown>()
  return {
    getItem: (k) => Promise.resolve(store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      store.set(k, v)
      return Promise.resolve()
    },
    removeItem: (k) => {
      store.delete(k)
      return Promise.resolve()
    },
    listKeys: (prefix) => Promise.resolve([...store.keys()].filter((k) => k.startsWith(prefix))),
  }
}

function mountCapturingErrors<R>(setup: () => R): { error: unknown; api: R | undefined } {
  let captured: R | undefined
  let error: unknown
  const App = defineComponent({
    setup() {
      captured = setup()
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.config.errorHandler = (err) => {
    error = err
  }
  const root = document.createElement('div')
  document.body.appendChild(root)
  try {
    app.mount(root)
  } catch (e) {
    error = e
  }
  app.unmount()
  document.body.removeChild(root)
  return { error, api: captured }
}

enum Color {
  Red = 'red',
  Blue = 'blue',
}
const schema = z.object({ name: z.string(), color: z.nativeEnum(Color) })

describe('SF1 — v3 nativeEnum + persist mounts without crashing', () => {
  it('wires persistence without throwing out of mount', () => {
    const { error, api } = mountCapturingErrors(() =>
      useForm({
        schema,
        key: `v3-nativeenum-persist-${Math.random().toString(36).slice(2)}`,
        persist: memoryStorage(),
        defaultValues: { name: '', color: Color.Red },
      })
    )
    expect(error).toBeUndefined()
    expect(api).toBeDefined()
    expect(api?.values.color).toBe('red')
  })
})
