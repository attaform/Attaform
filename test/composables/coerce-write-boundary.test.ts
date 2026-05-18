// @vitest-environment jsdom
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import type { UseFormReturn } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'

/**
 * Pins the storage-side semantics of `z.coerce.X()` under the
 * no-write-mutation contract.
 *
 * `z.coerce.X()` desugars to `z.pipe(z.transform(coerceFn), z.X())` —
 * the same input-transform shape as `z.preprocess`. Coercion runs at
 * parse / submit (inside `safeParse`), NOT at the write boundary.
 * Storage retains the raw consumer write; reads surface as `unknown`
 * to mirror Zod's input contract.
 *
 * Consumers wanting type-correct storage at the write boundary opt in
 * via directive modifiers (`v-register.number`, `.trim`) or register
 * transforms — that side of the contract is the directive layer's, not
 * the schema's.
 */

function makeFormProxy<T>(): T {
  const handler: ProxyHandler<() => unknown> = {
    get: () => proxy,
    apply: () => proxy,
  }
  const proxy: unknown = new Proxy(() => undefined, handler)
  return proxy as T
}

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

const numberSchema = z.object({ count: z.coerce.number() })
const booleanSchema = z.object({ agree: z.coerce.boolean() })
const stringSchema = z.object({ label: z.coerce.string() })

describe('z.coerce.X() does not mutate storage at the write boundary', () => {
  const unmounts: Array<() => void> = []
  afterEach(() => {
    while (unmounts.length > 0) unmounts.pop()?.()
  })

  it('z.coerce.number(): string write stays a string in storage', () => {
    const { api, unmount } = mountForm(() =>
      useForm({ schema: numberSchema, key: uniqueKey('cc-num') })
    )
    unmounts.push(unmount)

    api.setValue('count', '42' as never)
    expect(api.values.count).toBe('42')
  })

  it('z.coerce.number(): callback prev surfaces as unknown (type)', () => {
    const formT = makeFormProxy<UseFormReturn<typeof numberSchema>>()
    expectTypeOf(formT.values.count).toEqualTypeOf<unknown>()
  })

  it('z.coerce.boolean(): string write stays a string in storage', () => {
    const { api, unmount } = mountForm(() =>
      useForm({ schema: booleanSchema, key: uniqueKey('cc-bool') })
    )
    unmounts.push(unmount)

    api.setValue('agree', 'true' as never)
    expect(api.values.agree).toBe('true')
  })

  it('z.coerce.boolean(): callback prev surfaces as unknown (type)', () => {
    const formT = makeFormProxy<UseFormReturn<typeof booleanSchema>>()
    expectTypeOf(formT.values.agree).toEqualTypeOf<unknown>()
  })

  it('z.coerce.string(): number write stays a number in storage', () => {
    const { api, unmount } = mountForm(() =>
      useForm({ schema: stringSchema, key: uniqueKey('cc-str') })
    )
    unmounts.push(unmount)

    api.setValue('label', 42 as never)
    expect(api.values.label).toBe(42)
  })

  it('z.coerce.string(): callback prev surfaces as unknown (type)', () => {
    const formT = makeFormProxy<UseFormReturn<typeof stringSchema>>()
    expectTypeOf(formT.values.label).toEqualTypeOf<unknown>()
  })
})
