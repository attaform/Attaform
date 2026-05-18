// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Pins the storage-side semantics of `z.preprocess(fn, inner)` under
 * the no-write-mutation contract.
 *
 * Schema-side normalizers (z.preprocess, z.coerce, .transform) run at
 * parse / submit time (inside `safeParse`), NOT at the write boundary.
 * Storage holds whatever the consumer typed; the directive layer
 * (v-register modifiers + register transforms) owns write-boundary
 * mutation.
 *
 * Mount path and setValue path agree: neither runs preprocess on the
 * value before it lands in storage.
 */

function mountForm<R>(setup: () => R): { api: R; unmount: () => void } {
  let captured: R | undefined
  const App = defineComponent({
    setup() {
      captured = setup()
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.mount(document.createElement('div'))
  return {
    api: captured as R,
    unmount: () => app.unmount(),
  }
}

function uniqueKey(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`
}

describe('z.preprocess does not mutate storage at the write boundary', () => {
  const unmounts: Array<() => void> = []
  afterEach(() => {
    while (unmounts.length > 0) unmounts.pop()?.()
  })

  it('phone-format preprocess: storage holds the raw digits', () => {
    const formatPhone = (v: unknown): unknown => {
      if (typeof v !== 'string') return v
      const digits = v.replace(/\D/g, '')
      if (digits.length !== 10) return v
      return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    }
    const schema = z.object({ phone: z.preprocess(formatPhone, z.string()) })
    const { api, unmount } = mountForm(() => useForm({ schema, key: uniqueKey('pp-phone') }))
    unmounts.push(unmount)

    api.setValue('phone', '1231231234')
    expect(api.values.phone).toBe('1231231234')
  })

  it('trim preprocess: storage holds the padded string', () => {
    const trim = (v: unknown): unknown => (typeof v === 'string' ? v.trim() : v)
    const schema = z.object({ name: z.preprocess(trim, z.string()) })
    const { api, unmount } = mountForm(() => useForm({ schema, key: uniqueKey('pp-trim') }))
    unmounts.push(unmount)

    api.setValue('name', '  Alex  ')
    expect(api.values.name).toBe('  Alex  ')
  })

  it('null-coalesce preprocess: storage holds the raw null', () => {
    const fallback = (v: unknown): unknown => v ?? 'Anonymous'
    const schema = z.object({ nickname: z.preprocess(fallback, z.string()) })
    const { api, unmount } = mountForm(() => useForm({ schema, key: uniqueKey('pp-null') }))
    unmounts.push(unmount)

    api.setValue('nickname', null as never)
    expect(api.values.nickname).toBeNull()
  })

  it('defaultValues + setValue at a preprocess leaf are symmetric', () => {
    const trim = (v: unknown): unknown => (typeof v === 'string' ? v.trim() : v)
    const schema = z.object({ name: z.preprocess(trim, z.string()) })
    const { api, unmount } = mountForm(() =>
      useForm({ schema, defaultValues: { name: '  Bob  ' }, key: uniqueKey('pp-sym') })
    )
    unmounts.push(unmount)

    // Mount path: storage holds the raw default.
    expect(api.values.name).toBe('  Bob  ')

    // setValue path agrees: storage holds the raw write.
    api.setValue('name', '  Carol  ')
    expect(api.values.name).toBe('  Carol  ')
  })

  it('preprocess wrapping a discriminated union: raw null stays in storage', () => {
    const inner = z.discriminatedUnion('channel', [
      z.object({ channel: z.literal('email'), emailTopic: z.string() }),
      z.object({ channel: z.literal('sms'), smsBody: z.string() }),
    ])
    const schema = z.object({
      notify: z.preprocess(
        (v) => (v == null ? { channel: 'email', emailTopic: 'general' } : v),
        inner
      ),
    })
    const { api, unmount } = mountForm(() => useForm({ schema, key: uniqueKey('pp-du') }))
    unmounts.push(unmount)

    api.setValue('notify', null as never)
    // The preprocess fn would coalesce null to a valid variant, but
    // it only runs at parse time. Storage retains the raw null write.
    expect(api.values.notify).toBeNull()
  })
})
