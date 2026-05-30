// @vitest-environment jsdom
/**
 * Regression gate for issue #314 — the SSR payload `renderAttaformState`
 * produces must not carry null-prototype objects.
 *
 * A dogfooder reported that any Nuxt SSR page mounting an attaform form
 * 500s with `obj.hasOwnProperty is not a function` when `@pinia/nuxt` is
 * also installed. The crash chain:
 *
 *   1. Attaform's Nuxt plugin writes `renderAttaformState(app)` into
 *      `nuxtApp.payload.attaform` on the `app:rendered` hook.
 *   2. `@pinia/nuxt` registers a global devalue payload reducer that
 *      runs `shouldHydrate(node)` on every node of the payload — and
 *      `shouldHydrate` calls `node.hasOwnProperty(skipHydrateSymbol)`.
 *   3. The form's `values` object was allocated via `Object.create(null)`
 *      as part of the prototype-pollution defense (PRs #308-310). A
 *      null-prototype object has no inherited `hasOwnProperty` method,
 *      so the reducer's call throws and the SSR pipeline aborts.
 *
 * The fix is to keep `Object.prototype` on every container that reaches
 * a consumer-observable surface, while keeping the prototype-pollution
 * defense by switching to `safeAssign` (defineProperty for `__proto__`)
 * paired with spread (which uses `CreateDataProperty`, bypassing the
 * `__proto__` accessor on a regular target).
 *
 * These tests are the standing diagnostic: walk every plain-object node
 * of the SSR snapshot and call `hasOwnProperty` on it. Pre-fix at least
 * one node throws. Post-fix every node responds cleanly. The devalue
 * test exercises the same call path Nuxt's payload serializer uses, so
 * a future regression that reintroduces null-proto on the snapshot
 * surface gets caught at the same boundary the dogfooder hit.
 */
import { stringify as devalueStringify } from 'devalue'
import { describe, expect, it } from 'vitest'
import { renderToString } from '@vue/server-renderer'
import { createSSRApp, defineComponent, h } from 'vue'
import { z } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm } from '../../src/zod'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import { renderAttaformState } from '../../src/runtime/core/serialize'

/**
 * Walk every plain-object node of `value` and call `hasOwnProperty` on
 * it. Mirrors what a third-party payload walker (`@pinia/nuxt`'s
 * `shouldHydrate`, a logger, a serializer extension) does when it sees
 * a payload node. Throws if any node doesn't respond.
 */
function probeHasOwnPropertyEverywhere(value: unknown, path: string[] = []): void {
  if (value === null || value === undefined) return
  if (Array.isArray(value)) {
    value.forEach((item, i) => probeHasOwnPropertyEverywhere(item, [...path, String(i)]))
    return
  }
  if (typeof value !== 'object') return
  const obj = value as Record<string, unknown>
  // The call site that broke at the dogfooder's app — third-party code
  // assumes Object.prototype.hasOwnProperty is reachable through the
  // prototype chain. Switching to `Object.prototype.hasOwnProperty.call`
  // would erase the regression we're guarding against.
  // eslint-disable-next-line no-prototype-builtins
  obj.hasOwnProperty('__probe-symbol-stand-in')
  for (const key of Object.keys(obj)) {
    probeHasOwnPropertyEverywhere(obj[key], [...path, key])
  }
}

const SCHEMAS = {
  zod: {
    useForm,
    schema: z.object({
      email: z.string(),
      profile: z.object({ name: z.string(), bio: z.string() }),
      tags: z.array(z.string()),
      contact: z.discriminatedUnion('channel', [
        z.object({ channel: z.literal('email'), address: z.string() }),
        z.object({ channel: z.literal('sms'), number: z.string() }),
      ]),
    }),
    defaults: {
      email: 'ada@example.com',
      profile: { name: 'Ada', bio: 'Engineer' },
      tags: ['one', 'two'],
      contact: { channel: 'email' as const, address: 'ada@example.com' },
    },
  },
  'zod-v3': {
    useForm: useFormV3,
    schema: zV3.object({
      email: zV3.string(),
      profile: zV3.object({ name: zV3.string(), bio: zV3.string() }),
      tags: zV3.array(zV3.string()),
      contact: zV3.discriminatedUnion('channel', [
        zV3.object({ channel: zV3.literal('email'), address: zV3.string() }),
        zV3.object({ channel: zV3.literal('sms'), number: zV3.string() }),
      ]),
    }),
    defaults: {
      email: 'ada@example.com',
      profile: { name: 'Ada', bio: 'Engineer' },
      tags: ['one', 'two'],
      contact: { channel: 'email' as const, address: 'ada@example.com' },
    },
  },
} as const

describe('renderAttaformState — no null-prototype leak into the SSR payload', () => {
  for (const [adapterName, fixture] of Object.entries(SCHEMAS)) {
    describe(adapterName, () => {
      async function buildSnapshot(): Promise<unknown> {
        const App = defineComponent({
          setup() {
            ;(fixture.useForm as typeof useForm)({
              schema: fixture.schema as never,
              key: 'serialize-null-proto-probe',
              defaultValues: fixture.defaults as never,
            })
            return () => h('div')
          },
        })
        const app = createSSRApp(App).use(createAttaform({ ssr: true }))
        await renderToString(app)
        return renderAttaformState(app)
      }

      it('walking the snapshot with hasOwnProperty never throws', async () => {
        const snapshot = await buildSnapshot()
        // Hand-rolled walker for the simple case. Same call shape as
        // pinia's `shouldHydrate`, fast, no extra dependencies.
        expect(() => probeHasOwnPropertyEverywhere(snapshot)).not.toThrow()
      })

      it('round-trips through devalue with a pinia-style `shouldHydrate` reducer', async () => {
        const snapshot = await buildSnapshot()
        // Reproduces `@pinia/nuxt`'s payload-plugin shape exactly:
        // `definePayloadReducer('skipHydrate', (data) => !shouldHydrate(data) && 1)`,
        // where pinia's `shouldHydrate` does
        // `!isPlainObject(obj) || !obj.hasOwnProperty(skipHydrateSymbol)`.
        // devalue invokes this reducer on every node it visits during
        // `stringify`, so the throw — when it happens — propagates out
        // of `devalue.stringify` exactly as it propagates out of Nuxt's
        // payload serialization in production.
        const skipHydrateSymbol = Symbol.for('pinia:skipHydrate')
        const isPlainObject = (obj: unknown): obj is Record<string, unknown> =>
          obj !== null &&
          typeof obj === 'object' &&
          Object.prototype.toString.call(obj) === '[object Object]'
        const shouldHydrate = (obj: unknown): boolean => {
          if (!isPlainObject(obj)) return true
          // eslint-disable-next-line no-prototype-builtins
          return !(obj as Record<string | symbol, unknown>).hasOwnProperty(
            skipHydrateSymbol as unknown as string
          )
        }
        const skipHydrateReducer = (data: unknown): unknown =>
          !shouldHydrate(data) ? 1 : undefined

        expect(() => devalueStringify(snapshot, { skipHydrate: skipHydrateReducer })).not.toThrow()
      })

      it('a deeply-nested null-prototype leaf in `defaultValues` is reparented before reaching the payload', async () => {
        // Probe: `{ some: { nested: { path: { to: { this: Object.create(null) } } } } }`
        // — the null-proto sits four levels deep, not at the root.
        // Schema declares a matching nested shape so the merge has a
        // chance to walk into the null-proto. We assert the snapshot
        // is fully safe regardless of where the null-proto appears.
        const innerNullProto: Record<string, unknown> = Object.create(null)
        innerNullProto['leaf'] = 'value-at-null-proto-leaf'
        const innerNullProtoNested: Record<string, unknown> = Object.create(null)
        innerNullProtoNested['deeper'] = 'value-deeper-at-null-proto'
        innerNullProto['nested'] = innerNullProtoNested

        const NestedSchema = (
          fixture.useForm === useForm
            ? z.object({
                email: z.string(),
                some: z.object({
                  nested: z.object({
                    path: z.object({
                      to: z.object({
                        this: z.object({
                          leaf: z.string(),
                          nested: z.object({ deeper: z.string() }),
                        }),
                      }),
                    }),
                  }),
                }),
              })
            : zV3.object({
                email: zV3.string(),
                some: zV3.object({
                  nested: zV3.object({
                    path: zV3.object({
                      to: zV3.object({
                        this: zV3.object({
                          leaf: zV3.string(),
                          nested: zV3.object({ deeper: zV3.string() }),
                        }),
                      }),
                    }),
                  }),
                }),
              })
        ) as never

        const defaults = {
          email: 'ada@example.com',
          some: { nested: { path: { to: { this: innerNullProto } } } },
        }

        const App = defineComponent({
          setup() {
            ;(fixture.useForm as typeof useForm)({
              schema: NestedSchema,
              key: 'serialize-null-proto-nested-leaf',
              defaultValues: defaults as never,
            })
            return () => h('div')
          },
        })
        const app = createSSRApp(App).use(createAttaform({ ssr: true }))
        await renderToString(app)
        const snapshot = renderAttaformState(app)

        // The walker stands in for any third-party payload walker
        // (pinia-style or otherwise) — every node must respond.
        expect(() => probeHasOwnPropertyEverywhere(snapshot)).not.toThrow()

        // Also walk the snapshot and assert every plain-object node
        // carries `Object.prototype`. This catches the case where a
        // null-proto leaf is preserved by reference (no copy step) and
        // would otherwise crash a third-party reducer.
        const walk = (value: unknown): void => {
          if (value === null || value === undefined) return
          if (Array.isArray(value)) {
            value.forEach(walk)
            return
          }
          if (typeof value !== 'object') return
          if (Object.prototype.toString.call(value) !== '[object Object]') return
          expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
          for (const key of Object.keys(value as Record<string, unknown>)) {
            walk((value as Record<string, unknown>)[key])
          }
        }
        walk(snapshot)
      })

      it('a null-prototype value at a stowaway (`z.unknown()`) schema path is reparented before reaching the payload', async () => {
        // Worst-case probe: the consumer's null-prototype value sits
        // at a schema path declared as `z.unknown()`, meaning the
        // merge pipeline has no shape to walk into. The
        // `mergeStructuralImpl` early-return at this branch (when
        // `defaultValue` is non-record) would naively pass the
        // consumer's reference through unchanged — but the downstream
        // `structuralSnapshot` in `createFormStore` rebuilds every
        // descendable container as a fresh `Object.prototype`-backed
        // record, so the null-proto can't survive to the snapshot.
        const stowaway: Record<string, unknown> = Object.create(null)
        stowaway['hidden'] = 'value'
        const nestedStowaway: Record<string, unknown> = Object.create(null)
        nestedStowaway['x'] = 1
        stowaway['nested'] = nestedStowaway

        const StowawaySchema = (
          fixture.useForm === useForm
            ? z.object({
                email: z.string(),
                opaque: z.unknown(),
              })
            : zV3.object({
                email: zV3.string(),
                opaque: zV3.unknown(),
              })
        ) as never

        const stowawayDefaults = { email: 'ada@example.com', opaque: stowaway }
        const App = defineComponent({
          setup() {
            ;(fixture.useForm as typeof useForm)({
              schema: StowawaySchema,
              key: 'serialize-null-proto-stowaway',
              defaultValues: stowawayDefaults as never,
            })
            return () => h('div')
          },
        })
        const app = createSSRApp(App).use(createAttaform({ ssr: true }))
        await renderToString(app)
        const snapshot = renderAttaformState(app)

        expect(() => probeHasOwnPropertyEverywhere(snapshot)).not.toThrow()

        const walk = (value: unknown): void => {
          if (value === null || value === undefined) return
          if (Array.isArray(value)) {
            value.forEach(walk)
            return
          }
          if (typeof value !== 'object') return
          if (Object.prototype.toString.call(value) !== '[object Object]') return
          expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
          for (const key of Object.keys(value as Record<string, unknown>)) {
            walk((value as Record<string, unknown>)[key])
          }
        }
        walk(snapshot)
      })

      it('a consumer-supplied null-prototype `defaultValues` is reparented before reaching the payload', async () => {
        // Edge case: a consumer who hands attaform a literal
        // `Object.create(null)` shape (rare, but legal) shouldn't be
        // able to smuggle a null-prototype object into the SSR
        // payload through the back door. The merge pipeline
        // (`mergeStructural` / `mergeDeep` / `structuralSnapshot` /
        // `applyDuStubs`) all build fresh `Object.prototype`-backed
        // containers, so this case round-trips safe.
        const nullProtoDefaults: Record<string, unknown> = Object.create(null)
        nullProtoDefaults['email'] = 'ada@example.com'
        const nullProtoProfile: Record<string, unknown> = Object.create(null)
        nullProtoProfile['name'] = 'Ada'
        nullProtoProfile['bio'] = 'Engineer'
        nullProtoDefaults['profile'] = nullProtoProfile

        const App = defineComponent({
          setup() {
            ;(fixture.useForm as typeof useForm)({
              schema: fixture.schema as never,
              key: 'serialize-null-proto-consumer-edge',
              defaultValues: nullProtoDefaults as never,
            })
            return () => h('div')
          },
        })
        const app = createSSRApp(App).use(createAttaform({ ssr: true }))
        await renderToString(app)
        const snapshot = renderAttaformState(app)
        // The walker assertion stands in for every consumer surface —
        // the snapshot must be safe even when the consumer's input was
        // null-prototype.
        expect(() => probeHasOwnPropertyEverywhere(snapshot)).not.toThrow()
      })

      it('every plain-object node in the snapshot has Object.prototype', async () => {
        const snapshot = await buildSnapshot()
        const walk = (value: unknown): void => {
          if (value === null || value === undefined) return
          if (Array.isArray(value)) {
            value.forEach(walk)
            return
          }
          if (typeof value !== 'object') return
          // Tag-check pins "plain object" — we don't want to flag class
          // instances (Date, RegExp, etc.) that intentionally carry
          // their own prototype.
          if (Object.prototype.toString.call(value) !== '[object Object]') return
          expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
          for (const key of Object.keys(value as Record<string, unknown>)) {
            walk((value as Record<string, unknown>)[key])
          }
        }
        walk(snapshot)
      })
    })
  }
})
