// @vitest-environment jsdom
/**
 * Class-of-bug coverage for issue #314 — beyond the SSR snapshot, the
 * other consumer-facing surfaces (`form.values`, `form.record(path)`,
 * `form.errors`) also need to carry `Object.prototype` so any
 * third-party code that calls `.hasOwnProperty()` against them works.
 *
 * Vue's reactivity instruments `hasOwnProperty` on its proxies via
 * `toRaw(this).hasOwnProperty(key)`. With a null-prototype raw target
 * that call throws the same way `@pinia/nuxt` throws on the SSR
 * payload. The fix is the same: stop emitting null-prototype objects on
 * any consumer-observable surface.
 *
 * Each adapter (zod v3 + v4) gets the same coverage per
 * `feedback_zod_v3_v4_parity` — both are first-class peers.
 */
import { describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm } from '../../src/zod'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { UseFormReturnType } from '../../src/runtime/types/types-api'

type AnyForm = UseFormReturnType<Record<string, unknown>>

const fixtures = {
  zod: () => {
    const schema = z.object({
      email: z.string(),
      profile: z.object({ name: z.string() }),
      contacts: z.record(z.string(), z.object({ name: z.string() })),
    })
    return {
      schema,
      defaults: {
        email: 'ada@example.com',
        profile: { name: 'Ada' },
        contacts: { alice: { name: 'Alice' } },
      },
      useForm,
    }
  },
  'zod-v3': () => {
    const schema = zV3.object({
      email: zV3.string(),
      profile: zV3.object({ name: zV3.string() }),
      contacts: zV3.record(zV3.string(), zV3.object({ name: zV3.string() })),
    })
    return {
      schema,
      defaults: {
        email: 'ada@example.com',
        profile: { name: 'Ada' },
        contacts: { alice: { name: 'Alice' } },
      },
      useForm: useFormV3,
    }
  },
} as const

function mount<T extends ReturnType<(typeof fixtures)[keyof typeof fixtures]>>(
  fixture: T
): { app: App; form: AnyForm } {
  const handle: { form?: AnyForm } = {}
  const Root = defineComponent({
    setup() {
      handle.form = (fixture.useForm as typeof useForm)({
        schema: fixture.schema as never,
        key: 'public-api-null-proto-probe',
        defaultValues: fixture.defaults as never,
      }) as unknown as AnyForm
      return () => h('div')
    },
  })
  const app = createApp(Root).use(createAttaform())
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  return { app, form: handle.form as AnyForm }
}

describe('public form surfaces — no null-prototype leak into consumer reads', () => {
  for (const [adapter, build] of Object.entries(fixtures)) {
    describe(adapter, () => {
      it('form.values.hasOwnProperty works at the root', () => {
        const { app, form } = mount(build())
        try {
          // Direct `.hasOwnProperty(...)` is the consumer pattern this
          // test is guarding against; routing through
          // `Object.prototype.hasOwnProperty.call` would erase the
          // regression. Same exemption every site below.
          // eslint-disable-next-line no-prototype-builtins
          expect(() => form.values.hasOwnProperty('email')).not.toThrow()
          // eslint-disable-next-line no-prototype-builtins
          expect(form.values.hasOwnProperty('email')).toBe(true)
          // eslint-disable-next-line no-prototype-builtins
          expect(form.values.hasOwnProperty('nope')).toBe(false)
        } finally {
          app.unmount()
        }
      })

      it('form.values.hasOwnProperty works on a nested record', () => {
        const { app, form } = mount(build())
        try {
          const profile = (form.values as Record<string, unknown>)['profile'] as Record<
            string,
            unknown
          >
          // eslint-disable-next-line no-prototype-builtins
          expect(() => profile.hasOwnProperty('name')).not.toThrow()
          // eslint-disable-next-line no-prototype-builtins
          expect(profile.hasOwnProperty('name')).toBe(true)
        } finally {
          app.unmount()
        }
      })

      it('form.record(path).hasOwnProperty works on the keyed view', () => {
        const { app, form } = mount(build())
        try {
          const view = (
            form as unknown as { record(path: string): Readonly<Record<string, unknown>> }
          ).record('contacts')
          // eslint-disable-next-line no-prototype-builtins
          expect(() => view.hasOwnProperty('alice')).not.toThrow()
          // eslint-disable-next-line no-prototype-builtins
          expect(view.hasOwnProperty('alice')).toBe(true)
        } finally {
          app.unmount()
        }
      })

      it('form.errors.hasOwnProperty works (regardless of whether a path has errors)', () => {
        const { app, form } = mount(build())
        try {
          expect(() =>
            // eslint-disable-next-line no-prototype-builtins
            (form.errors as unknown as Record<string, unknown>).hasOwnProperty('email')
          ).not.toThrow()
        } finally {
          app.unmount()
        }
      })

      it('Object.getPrototypeOf(form.record(path)) is Object.prototype', () => {
        const { app, form } = mount(build())
        try {
          const view = (
            form as unknown as { record(path: string): Readonly<Record<string, unknown>> }
          ).record('contacts')
          expect(Object.getPrototypeOf(view)).toBe(Object.prototype)
        } finally {
          app.unmount()
        }
      })
    })
  }
})
