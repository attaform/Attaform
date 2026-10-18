// @vitest-environment jsdom
/**
 * A `zod/mini` schema drives a form exactly as its classic twin does
 * (#703).
 *
 * Mini builds the same Zod 4 core schemas as classic `zod`, with
 * functions where classic has methods: `zm.optional(zm.string())` for
 * `z.string().optional()`. Attaform reads the core's `def` and never a
 * classic method, so a form should not be able to tell the two apart.
 * One scenario, written once per flavor, reads every surface a form
 * takes from its schema: derived defaults, parse errors, the
 * `handleSubmit` payload, a discriminated-union switch, `dirty`, labels
 * and descriptions, `aria-required`, and the adapter's capability bits.
 * Each row holds both flavors to the same expected reading, so the two
 * agreeing on a wrong answer fails as well.
 *
 * Every check carries its own message. Classic `zod` loads its English
 * locale when imported and `zod/mini` loads none, so Zod's default
 * messages would agree here only because this file imports classic.
 *
 * On main (90339f3d) every row agreed but two:
 * - labels and descriptions: `zm.describe(...)` and
 *   `zm.meta({ description })` read `undefined`, because the adapter
 *   read classic's `.description` getter, not Zod's global registry
 *   behind it;
 * - capability bits: `zm.describe(...)` on a container adds a no-op
 *   check to its def, which read as a container refine and cost a mini
 *   form its per-keystroke subtree validation.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { h, withDirectives, type App, type VNode } from 'vue'
import * as z from 'zod'
import * as zm from 'zod/mini'
import { useForm, withMeta } from '../../../src/index'
import { useForm as useFormV4, withMeta as withMetaV4, zodAdapter } from '../../../src/zod-v4'
import { vRegister } from '../../../src/runtime/core/directive'
import { awaitSettle, makeMounter } from '../../utils/form-harness'

/**
 * The scenario. Each field covers one schema surface: a described
 * string, `withMeta` from each entry, a `meta` description read through
 * an optional, optional and nullable leaves, a defaulted array, a
 * record, a coerced number, an async refine, a discriminated union and
 * a root refine.
 */
function scenario() {
  const classic = z
    .object({
      name: z.string().min(2, 'At least 2 characters').describe('Your name'),
      email: withMeta(z.email('Enter a valid email'), {
        label: 'Email address',
        description: 'We only use it for receipts.',
      }),
      nickname: z.string().meta({ description: 'What friends call you' }).optional(),
      age: z.number().optional(),
      middle: withMetaV4(z.string(), { label: 'Middle name' }).nullable(),
      tags: z.array(z.string().min(1, 'No empty tags')).default(['x']),
      scores: z.record(z.string(), z.number().min(0, 'No negative scores')),
      qty: z.coerce.number({ error: 'Enter a number' }),
      handle: z
        .string()
        .refine(async (v) => Promise.resolve(v !== 'taken'), 'That handle is taken'),
      pick: z.discriminatedUnion('k', [
        z.object({ k: z.literal('a'), a: z.string() }),
        z.object({ k: z.literal('b'), b: z.number().default(4) }),
      ]),
    })
    .refine((v) => v.handle !== v.name, {
      message: 'Pick a handle that is not your name',
      path: ['handle'],
    })

  const mini = zm
    .object({
      name: zm.string().check(zm.minLength(2, 'At least 2 characters'), zm.describe('Your name')),
      email: withMeta(zm.email('Enter a valid email'), {
        label: 'Email address',
        description: 'We only use it for receipts.',
      }),
      nickname: zm.optional(zm.string().check(zm.meta({ description: 'What friends call you' }))),
      age: zm.optional(zm.number()),
      middle: zm.nullable(withMetaV4(zm.string(), { label: 'Middle name' })),
      tags: zm._default(zm.array(zm.string().check(zm.minLength(1, 'No empty tags'))), ['x']),
      scores: zm.record(zm.string(), zm.number().check(zm.minimum(0, 'No negative scores'))),
      qty: zm.coerce.number({ error: 'Enter a number' }),
      handle: zm
        .string()
        .check(zm.refine(async (v) => Promise.resolve(v !== 'taken'), 'That handle is taken')),
      pick: zm.discriminatedUnion('k', [
        zm.object({ k: zm.literal('a'), a: zm.string() }),
        zm.object({ k: zm.literal('b'), b: zm._default(zm.number(), 4) }),
      ]),
    })
    .check(
      zm.refine((v) => v.handle !== v.name, {
        message: 'Pick a handle that is not your name',
        path: ['handle'],
      })
    )

  return { classic, mini }
}

/**
 * A twin with nothing to detect, so every capability bit reads false. A
 * description on a container is the case that once flipped
 * `hasContainerOrRootRefine` on mini alone.
 */
function plainTwins() {
  return {
    classic: z.object({
      name: z.string().describe('Your name'),
      address: z.object({ city: z.string() }).describe('Where we ship'),
    }),
    mini: zm.object({
      name: zm.string().check(zm.describe('Your name')),
      address: zm.object({ city: zm.string() }).check(zm.describe('Where we ship')),
    }),
  }
}

type Mounted = ReturnType<ReturnType<typeof makeMounter>>
type MountedForm = Mounted['api']
type UseFormFn = Parameters<typeof makeMounter>[0]

const apps: App[] = []

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  document.body.innerHTML = ''
})

/**
 * Mount the scenario once per flavor through `useFormFn` and return
 * what `read` observes on each.
 */
async function readBoth<T>(
  useFormFn: UseFormFn,
  read: (form: MountedForm, root: HTMLElement) => T | Promise<T>,
  render?: (form: MountedForm) => VNode
): Promise<{ classic: T; mini: T }> {
  const { classic, mini } = scenario()
  const readOne = async (schema: unknown): Promise<T> => {
    const { api, app, root } = makeMounter(useFormFn, schema, {}, render)()
    apps.push(app)
    await awaitSettle()
    return read(api, root)
  }
  return { classic: await readOne(classic), mini: await readOne(mini) }
}

/** Both flavors held to the same expected reading. */
function twinned<T>(expected: T): { classic: T; mini: T } {
  return { classic: expected, mini: expected }
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

function errorRows(
  errors: readonly { path: readonly (string | number)[]; code: string; message: string }[]
) {
  return errors.map((error) => [error.path.join('.'), error.code, error.message])
}

async function parseRows(form: MountedForm) {
  const response = await form.parse()
  return response.success === true ? [] : errorRows(response.errors)
}

async function submit(form: MountedForm) {
  const out: { data?: unknown; errors?: unknown } = {}
  await form.handleSubmit(
    (data: unknown) => {
      out.data = plain(data)
    },
    (errors: Parameters<typeof errorRows>[0]) => {
      out.errors = errorRows(errors)
    }
  )()
  return out
}

const ARIA_PATHS = ['name', 'email', 'nickname', 'age', 'middle', 'qty', 'handle'] as const

const ENTRIES = [
  { entry: 'attaform', useFormFn: useForm },
  { entry: 'attaform/zod-v4', useFormFn: useFormV4 },
] as const

describe.each(ENTRIES)('zod/mini parity through $entry', ({ useFormFn }) => {
  it('derives the same defaults', async () => {
    const read = (form: MountedForm) => plain(form.values)

    expect(await readBoth(useFormFn, read)).toEqual(
      twinned({
        name: '',
        email: '',
        nickname: undefined,
        age: undefined,
        middle: null,
        tags: ['x'],
        scores: {},
        qty: undefined,
        handle: '',
        pick: { k: 'a', a: '' },
      })
    )
  })

  it('reports the same parse errors, by path, code and message', async () => {
    const read = async (form: MountedForm) => {
      const blank = await parseRows(form)
      form.append('tags', '')
      form.setValue('scores.alice', -1)
      form.setValue('qty', '5')
      form.setValue('middle', null)
      form.setValue('handle', 'taken')
      return { blank, written: await parseRows(form) }
    }

    expect(await readBoth(useFormFn, read)).toEqual(
      twinned({
        blank: [
          ['name', 'zod:too_small', 'At least 2 characters'],
          ['email', 'zod:invalid_format', 'Enter a valid email'],
          ['qty', 'zod:invalid_type', 'Enter a number'],
        ],
        written: [
          ['name', 'zod:too_small', 'At least 2 characters'],
          ['email', 'zod:invalid_format', 'Enter a valid email'],
          ['tags.1', 'zod:too_small', 'No empty tags'],
          ['scores.alice', 'zod:too_small', 'No negative scores'],
          ['handle', 'zod:custom', 'That handle is taken'],
        ],
      })
    )
  })

  it('hands handleSubmit the same payload, and the same root-refine error', async () => {
    const read = async (form: MountedForm) => {
      form.setValue('name', 'Ada')
      form.setValue('email', 'ada@example.com')
      form.setValue('scores.alice', 3)
      form.setValue('qty', '5')
      form.setValue('pick.a', 'hi')
      form.setValue('handle', 'Ada')
      const refused = await submit(form)
      form.setValue('handle', 'ada')
      const accepted = await submit(form)
      return { refused, accepted, storedQty: form.values.qty }
    }

    expect(await readBoth(useFormFn, read)).toEqual(
      twinned({
        refused: { errors: [['handle', 'zod:custom', 'Pick a handle that is not your name']] },
        accepted: {
          data: {
            name: 'Ada',
            email: 'ada@example.com',
            middle: null,
            tags: ['x'],
            scores: { alice: 3 },
            qty: 5,
            handle: 'ada',
            pick: { k: 'a', a: 'hi' },
          },
        },
        storedQty: '5',
      })
    )
  })

  it('switches discriminated-union variants the same way', async () => {
    const read = (form: MountedForm) => {
      form.setValue('pick.a', 'hi')
      form.setValue('pick.k', 'b')
      const switched = plain(form.values.pick)
      form.setValue('pick.k', 'a')
      return { switched, restored: plain(form.values.pick) }
    }

    expect(await readBoth(useFormFn, read)).toEqual(
      twinned({ switched: { k: 'b', b: 4 }, restored: { k: 'a', a: 'hi' } })
    )
  })

  it('tracks dirty the same way', async () => {
    const read = (form: MountedForm) => {
      const sample = () => [form.meta.dirty, form.fields('name').dirty, form.fields('tags').dirty]
      const mounted = sample()
      form.setValue('name', 'Ada')
      const edited = sample()
      form.setValue('name', '')
      const reverted = sample()
      form.append('tags', 'y')
      return { mounted, edited, reverted, appended: sample() }
    }

    expect(await readBoth(useFormFn, read)).toEqual(
      twinned({
        mounted: [false, false, false],
        edited: [true, true, false],
        reverted: [false, false, false],
        appended: [true, false, true],
      })
    )
  })

  it('reads the same labels and descriptions', async () => {
    const read = (form: MountedForm) =>
      Object.fromEntries(
        ['name', 'email', 'nickname', 'age', 'middle'].map((path) => {
          const field = form.fields(path)
          return [path, { label: field.label, description: field.description }]
        })
      )

    expect(await readBoth(useFormFn, read)).toEqual(
      twinned({
        name: { label: 'Name', description: 'Your name' },
        email: { label: 'Email address', description: 'We only use it for receipts.' },
        nickname: { label: 'Nickname', description: 'What friends call you' },
        age: { label: 'Age', description: undefined },
        middle: { label: 'Middle name', description: undefined },
      })
    )
  })

  it('marks the same inputs aria-required', async () => {
    const render = (form: MountedForm) =>
      h(
        'div',
        ARIA_PATHS.map((path) =>
          withDirectives(h('input', { class: path }), [[vRegister, form.register(path)]])
        )
      )
    const read = (_form: MountedForm, root: HTMLElement) =>
      Object.fromEntries(
        ARIA_PATHS.map((path) => [
          path,
          root.querySelector(`input.${path}`)?.getAttribute('aria-required') ?? null,
        ])
      )

    expect(await readBoth(useFormFn, read, render)).toEqual(
      twinned({
        name: 'true',
        email: 'true',
        nickname: null,
        age: null,
        middle: null,
        qty: 'true',
        handle: 'true',
      })
    )
  })
})

describe('zod/mini parity: capability bits', () => {
  const bits = (schema: Parameters<typeof zodAdapter>[0]) => {
    const adapter = zodAdapter(schema)('f', { maxRecursionDepth: 64 })
    return {
      needsAsyncValidation: adapter.needsAsyncValidation?.(),
      hasContainerOrRootRefine: adapter.hasContainerOrRootRefine?.(),
      hasDiscriminatedUnions: adapter.hasDiscriminatedUnions?.(),
      hasPreprocessOrCoerce: adapter.hasPreprocessOrCoerce?.(),
    }
  }

  it('the scenario sets every bit on both flavors', () => {
    const { classic, mini } = scenario()

    expect({ classic: bits(classic), mini: bits(mini) }).toEqual(
      twinned({
        needsAsyncValidation: true,
        hasContainerOrRootRefine: true,
        hasDiscriminatedUnions: true,
        hasPreprocessOrCoerce: true,
      })
    )
  })

  it('a plain twin sets none, a described container included', () => {
    const { classic, mini } = plainTwins()

    expect({ classic: bits(classic), mini: bits(mini) }).toEqual(
      twinned({
        needsAsyncValidation: false,
        hasContainerOrRootRefine: false,
        hasDiscriminatedUnions: false,
        hasPreprocessOrCoerce: false,
      })
    )
  })
})
