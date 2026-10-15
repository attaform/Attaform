// @vitest-environment jsdom
/**
 * A pipeline's output side is part of the verdict on both adapters.
 *
 * `z.string().pipe(z.string().email())` parses its input as a string,
 * then hands the result to the output side, whose `.email()` is a check
 * like any other. Zod v3's synchronous parses run through a promise-safe
 * rebuild of the schema (`syncSafe`), and that rebuild once kept only a
 * pipeline's input side. Every v3 sync verdict (the construction seed,
 * `reset()`, a discriminated union's sync reshape pass) skipped the
 * output side's checks, while v4 and v3's own async pass ran them, so a
 * v3 form mounted with `''` read valid until its first edit.
 *
 * Paths are compared, not codes: the majors spell the same failure
 * differently (`invalid_string` on v3, `invalid_format` on v4).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z as z3 } from 'zod-v3'
import { z as z4 } from 'zod'
import { zodAdapter as v3Adapter, useForm as useFormV3 } from '../../src/zod-v3'
import { zodAdapter as v4Adapter, useForm as useFormV4 } from '../../src/zod-v4'
import { createAttaform } from '../../src/runtime/core/plugin'
import type { Path } from '../../src/runtime/core/paths'
import type { AbstractSchema } from '../../src/runtime/types/types-api'

type Probe = Pick<AbstractSchema<unknown, unknown>, 'validateSync' | 'validateAtPath'>

const OPTIONS = { maxRecursionDepth: 64 }

/** Each case: a schema per major, a failing value with its paths, and a passing value. */
const CASES: {
  title: string
  v3: Probe
  v4: Probe
  failing: unknown
  failingPaths: Path[]
  passing: unknown
}[] = [
  {
    title: 'a check on the output side',
    v3: v3Adapter(z3.object({ email: z3.string().pipe(z3.string().email()) }))('p', OPTIONS),
    v4: v4Adapter(z4.object({ email: z4.string().pipe(z4.string().email()) }))('p', OPTIONS),
    failing: { email: '' },
    failingPaths: [['email']],
    passing: { email: 'ada@example.com' },
  },
  {
    title: 'a transform feeding a checked output',
    v3: v3Adapter(
      z3.object({
        count: z3
          .string()
          .transform((v) => v.length)
          .pipe(z3.number().min(3)),
      })
    )('p', OPTIONS),
    v4: v4Adapter(
      z4.object({
        count: z4
          .string()
          .transform((v) => v.length)
          .pipe(z4.number().min(3)),
      })
    )('p', OPTIONS),
    failing: { count: 'ab' },
    failingPaths: [['count']],
    passing: { count: 'abcd' },
  },
  {
    title: 'a pipeline inside an array element',
    v3: v3Adapter(
      z3.object({ items: z3.array(z3.object({ code: z3.string().pipe(z3.string().length(3)) })) })
    )('p', OPTIONS),
    v4: v4Adapter(
      z4.object({ items: z4.array(z4.object({ code: z4.string().pipe(z4.string().length(3)) })) })
    )('p', OPTIONS),
    failing: { items: [{ code: 'abc' }, { code: 'x' }] },
    failingPaths: [['items', 1, 'code']],
    passing: { items: [{ code: 'abc' }] },
  },
  {
    title: 'a refinement on the output side',
    v3: v3Adapter(
      z3.object({ pin: z3.string().pipe(z3.string().refine((v) => v !== '0000', 'weak')) })
    )('p', OPTIONS),
    v4: v4Adapter(
      z4.object({ pin: z4.string().pipe(z4.string().refine((v) => v !== '0000', 'weak')) })
    )('p', OPTIONS),
    failing: { pin: '0000' },
    failingPaths: [['pin']],
    passing: { pin: '4821' },
  },
]

function syncPaths(probe: Probe, data: unknown): Path[] | 'async' {
  const result = probe.validateAtPath(data, undefined, { sync: true })
  if (result instanceof Promise) return 'async'
  return result.success ? [] : result.errors.map((e) => e.path)
}

describe('a pipeline output side reaches the verdict on both adapters', () => {
  for (const c of CASES) {
    for (const major of ['v3', 'v4'] as const) {
      it(`${major}: validateSync, ${c.title}`, () => {
        const probe = c[major]
        expect(probe.validateSync(c.failing).map((e) => e.path)).toEqual(c.failingPaths)
        expect(probe.validateSync(c.passing)).toEqual([])
      })

      it(`${major}: a sync validateAtPath, ${c.title}`, () => {
        const probe = c[major]
        expect(syncPaths(probe, c.failing)).toEqual(c.failingPaths)
        expect(syncPaths(probe, c.passing)).toEqual([])
      })
    }
  }
})

describe('a form seeds the output side verdict at mount', () => {
  const apps: App[] = []
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
  })

  function mount<T>(setup: () => T): T {
    const handle: { value?: T } = {}
    const Root = defineComponent({
      setup() {
        handle.value = setup()
        return () => h('div')
      },
    })
    const app = createApp(Root).use(createAttaform())
    app.mount(document.createElement('div'))
    apps.push(app)
    if (handle.value === undefined) throw new Error('unreachable')
    return handle.value
  }

  const schemaV3 = z3.object({ email: z3.string().pipe(z3.string().email()) })
  const schemaV4 = z4.object({ email: z4.string().pipe(z4.string().email()) })

  it('reads invalid on the first synchronous read, on both adapters', () => {
    const v3 = mount(() => useFormV3({ schema: schemaV3, key: 'pipeline-mount-v3' }))
    const v4 = mount(() => useFormV4({ schema: schemaV4, key: 'pipeline-mount-v4' }))
    expect(v3.meta.valid).toBe(false)
    expect(v4.meta.valid).toBe(false)
    expect(v3.errors.email.map((e) => e.path)).toEqual([['email']])
    expect(v4.errors.email.map((e) => e.path)).toEqual([['email']])
  })
})
