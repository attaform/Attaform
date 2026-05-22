// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'

import { useForm } from '../../src/zod'

/**
 * Schema-level `.default('JP').refine(...)` MUST populate `form.values`
 * at construction. The SSR markup is rendered from `form.values`
 * immediately, so any case where the construction-time value diverges
 * from the schema default surfaces as a hydration-time flash:
 *
 *   - Initial paint: dropdown lands on the slim default ('' for a
 *     `z.string()` leaf).
 *   - Vue hydrates, reactivity catches up, and `form.values.country`
 *     becomes the actual schema default.
 *   - The dropdown visibly flips from "" to (e.g.) "Japan".
 *
 * The fix needs the default-values walker to peel `.refine()` before
 * looking for `.default()`. These tests pin the contract: regardless
 * of whether `.default()` sits before or after `.refine()`, the
 * construction-time value MUST match the schema default.
 */

const mountedApps: App[] = []

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount()
})

function mount<T>(setup: () => T): T {
  const handle: { captured?: T } = {}
  const App = defineComponent({
    setup() {
      handle.captured = setup()
      return () => h('div')
    },
  })
  const app = createApp(App)
  app.mount(document.createElement('div'))
  mountedApps.push(app)
  if (handle.captured === undefined) throw new Error('setup did not capture')
  return handle.captured
}

describe("schema .default('JP') survives .refine() on construction", () => {
  it("z.string().default('JP') alone -> form.values.country === 'JP'", () => {
    const form = mount(() =>
      useForm({
        schema: z.object({
          country: z.string().default('JP'),
        }),
        key: 'default-refine-bare',
      })
    )
    expect(form.values.country).toBe('JP')
  })

  it("z.string().default('JP').refine(...) -> form.values.country === 'JP'", () => {
    // The order that mirrors the demo: default first, refine second.
    const form = mount(() =>
      useForm({
        schema: z.object({
          country: z
            .string()
            .default('JP')
            .refine((v) => v.length > 0, 'pick something'),
        }),
        key: 'default-then-refine',
      })
    )
    expect(form.values.country).toBe('JP')
  })

  it("z.string().refine(...).default('JP') -> form.values.country === 'JP'", () => {
    // Reverse order: refine first, default second. Output should be
    // identical; pin it so the adapter handles either chain shape.
    const form = mount(() =>
      useForm({
        schema: z.object({
          country: z
            .string()
            .refine((v) => v.length > 0, 'pick something')
            .default('JP'),
        }),
        key: 'refine-then-default',
      })
    )
    expect(form.values.country).toBe('JP')
  })
})
