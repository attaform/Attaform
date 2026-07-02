// @vitest-environment jsdom
//
// Prod gate for the runtime redundant-binding warn (#464). `__DEV__` (in
// src/runtime/core/dev.ts) is computed at module-load time from
// process.env.NODE_ENV, so exercising the prod branch needs the mock
// hoisted above the directive import — hence a separate file (the main
// runtime suite has `__DEV__` cached at `true`). Mirrors
// transforms-prod-log.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/runtime/core/dev', () => ({ __DEV__: false }))

import { createApp, defineComponent, h, withDirectives, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { vRegister } from '../../src/runtime/core/directive'
import { createAttaform } from '../../src/runtime/core/plugin'
import { waitUntil } from '../utils/form-harness'

const schema = z.object({ name: z.string() })

describe('v-register runtime redundant-binding warn — production gate', () => {
  let app: App | undefined
  afterEach(() => {
    app?.unmount()
    app = undefined
    document.body.innerHTML = ''
  })

  it('stays silent in production even with a redundant :value', async () => {
    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warns.push(args.map((a) => String(a)).join(' '))
    })

    const Comp = defineComponent({
      setup() {
        const form = useForm({ schema, key: `rb-prod-${Math.random().toString(36).slice(2)}` })
        const rv = form.register('name')
        return () => withDirectives(h('input', { value: 'x' }), [[vRegister, rv]])
      },
    })

    app = createApp(Comp).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    await waitUntil(() => (root.firstElementChild !== null ? true : null))
    spy.mockRestore()

    expect(warns.filter((w) => w.includes('redundant beside v-register'))).toHaveLength(0)
  })
})
