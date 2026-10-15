// @vitest-environment jsdom
/**
 * Construction work counters (#691): deterministic counts of the work a form
 * does to construct, on both adapters.
 *
 * - `rootRefine` / `leafRefine`: runs of a counting `superRefine` on the
 *   root and on one leaf. Every parse of the real schema that reaches the
 *   root runs it once, so `rootRefine` counts verdict parses: the
 *   construction verdict, the post-mount async pass, a whole-form submit.
 * - `getDefaultValues` / `getDefaultAtPath` / `getEmptyValueAtPath`: calls
 *   into the root AbstractSchema, which every form on a schema shares.
 * - `rootWalks`: schema walks that visit the root node.
 *
 * Each count is taken at up to three moments: `mounted` (synchronously
 * after `app.mount`, nothing read), `firstRead` (after one synchronous read
 * of `meta.valid`, as a status rail reads it) and `settled` (timers and
 * microtasks drained). Every moment counts from just before the measured
 * construction, so a `warm` form's numbers exclude the form that warmed it.
 *
 * The numbers pin TODAY's work exactly. The #691 phases ratchet them down,
 * each editing a number only to lower it, in the commit that earns the
 * drop. A rise is a construction regression.
 *
 * How each counter attaches, with no production hooks:
 * - Refinement runs, through the fixture's own `superRefine`s. A spy on
 *   the root's `safeParse` would miss v3, whose construction parse runs
 *   against a rebuilt promise-safe copy of the tree; the refinement runs in
 *   either tree.
 * - AbstractSchema calls, through spies on the adapter's shared instance
 *   for the schema, fetched with `zodAdapter(schema)` before the form
 *   exists. Each test asserts the form's store holds that same instance,
 *   so a change to the sharing fails loudly instead of counting zero.
 * - Root walks, through `WeakSet.prototype.add`: every schema walker marks
 *   the node it visits in a fresh `WeakSet`, the root first, so an `add`
 *   receiving the root is one walk. A walk that starts below the root (a
 *   sub-schema's own query) is not counted. The control test proves the hook
 *   still sees a walk, so a walker that stops using a `WeakSet` fails there
 *   rather than reading as zero walks.
 */
import { renderToString } from '@vue/server-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, createSSRApp, defineComponent, h, nextTick, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4, zodAdapter as zodAdapterV4 } from '../../src/zod-v4'
import { useForm as useFormV3, zodAdapter as zodAdapterV3 } from '../../src/zod-v3'
import { containsDiscriminatedUnion as walkV4 } from '../../src/runtime/adapters/zod-v4/introspect'
import { containsDiscriminatedUnion as walkV3 } from '../../src/runtime/adapters/zod-v3/introspect'
import { useWizard } from '../../src/runtime/composables/use-wizard'
import { DEFAULT_MAX_RECURSION_DEPTH } from '../../src/runtime/core/defaults'
import { createAttaform } from '../../src/runtime/core/plugin'
import { getRegistryFromApp } from '../../src/runtime/core/registry'
import { hydrateAttaformState, renderAttaformState } from '../../src/runtime/core/serialize'
import { wait } from '../utils/form-harness'

/* eslint-disable @typescript-eslint/no-explicit-any */
const ADAPTERS = [
  {
    name: 'zod-v4',
    z: zV4 as any,
    useForm: useFormV4 as any,
    zodAdapter: zodAdapterV4 as any,
    walk: (schema: any): boolean => walkV4(schema),
  },
  {
    name: 'zod-v3',
    z: zV3 as any,
    useForm: useFormV3 as any,
    zodAdapter: zodAdapterV3 as any,
    walk: (schema: any): boolean => walkV3(schema),
  },
] as const
type Adapter = (typeof ADAPTERS)[number]
type AdapterName = Adapter['name']

type Fixture = 'plain' | 'refined'

type RefineCounts = { rootRefine: number; leafRefine: number }

/**
 * Issue-style leaves: strings with length checks, a number, a nested object,
 * an array. `refined` adds the counting root and leaf `superRefine`s.
 */
function makeSchema(z: any, fixture: Fixture, counts: RefineCounts): any {
  const name =
    fixture === 'refined'
      ? z
          .string()
          .min(2)
          .superRefine(() => {
            counts.leafRefine += 1
          })
      : z.string().min(2)
  const shape = z.object({
    name,
    email: z.string().min(3),
    age: z.number().min(18),
    address: z.object({ line1: z.string().min(1), city: z.string(), zip: z.string().min(5) }),
    tags: z.array(z.string().min(1)),
    agreed: z.boolean(),
  })
  return fixture === 'refined'
    ? shape.superRefine(() => {
        counts.rootRefine += 1
      })
    : shape
}

/** Fails several leaf checks, none fatal, so the root refinement runs too. */
const DEFAULTS = {
  name: '',
  email: '',
  age: 0,
  address: { line1: '', city: '', zip: '' },
  tags: [''],
  agreed: false,
}

type Moment = {
  rootRefine: number
  leafRefine: number
  getDefaultValues: number
  getDefaultAtPath: number
  getEmptyValueAtPath: number
  rootWalks: number
}

const SPIED_METHODS = ['getDefaultValues', 'getDefaultAtPath', 'getEmptyValueAtPath'] as const

/** Root walks per watched root schema, fed by the `WeakSet#add` spy. */
const rootWalkCounts = new Map<WeakKey, number>()

/** A schema under count: its refinement counters, spies and a reader. */
type Instrumented = {
  schema: any
  abstractSchema: unknown
  read: () => Moment
}

function instrument(adapter: Adapter, fixture: Fixture): Instrumented {
  const counts: RefineCounts = { rootRefine: 0, leafRefine: 0 }
  const schema = makeSchema(adapter.z, fixture, counts)
  rootWalkCounts.set(schema, 0)
  const abstractSchema = adapter.zodAdapter(schema)('construction-work', {
    maxRecursionDepth: DEFAULT_MAX_RECURSION_DEPTH,
  })
  const spies = SPIED_METHODS.map((method) => vi.spyOn(abstractSchema, method))
  return {
    schema,
    abstractSchema,
    read: () => ({
      rootRefine: counts.rootRefine,
      leafRefine: counts.leafRefine,
      getDefaultValues: spies[0]?.mock.calls.length ?? 0,
      getDefaultAtPath: spies[1]?.mock.calls.length ?? 0,
      getEmptyValueAtPath: spies[2]?.mock.calls.length ?? 0,
      rootWalks: rootWalkCounts.get(schema) ?? 0,
    }),
  }
}

/** Counts accrued since `base`. */
function since(base: Moment, now: Moment): Moment {
  return {
    rootRefine: now.rootRefine - base.rootRefine,
    leafRefine: now.leafRefine - base.leafRefine,
    getDefaultValues: now.getDefaultValues - base.getDefaultValues,
    getDefaultAtPath: now.getDefaultAtPath - base.getDefaultAtPath,
    getEmptyValueAtPath: now.getEmptyValueAtPath - base.getEmptyValueAtPath,
    rootWalks: now.rootWalks - base.rootWalks,
  }
}

function sum(moments: readonly Moment[]): Moment {
  const total: Moment = {
    rootRefine: 0,
    leafRefine: 0,
    getDefaultValues: 0,
    getDefaultAtPath: 0,
    getEmptyValueAtPath: 0,
    rootWalks: 0,
  }
  for (const m of moments) {
    total.rootRefine += m.rootRefine
    total.leafRefine += m.leafRefine
    total.getDefaultValues += m.getDefaultValues
    total.getDefaultAtPath += m.getDefaultAtPath
    total.getEmptyValueAtPath += m.getEmptyValueAtPath
    total.rootWalks += m.rootWalks
  }
  return total
}

async function settle(): Promise<void> {
  await wait(20)
  await nextTick()
  await nextTick()
}

const apps: App[] = []

/** Mount one form on a client app; returns its API. */
function mountClient(adapter: Adapter, schema: unknown, key: string): any {
  const handle: { api?: any } = {}
  const App = defineComponent({
    setup() {
      handle.api = adapter.useForm({ schema, key, defaultValues: DEFAULTS })
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.mount(document.createElement('div'))
  apps.push(app)
  expectSharedSchema(app, key, schema, adapter)
  return handle.api
}

/** The form's store must hold the instance the spies sit on. */
function expectSharedSchema(app: App, key: string, schema: unknown, adapter: Adapter): void {
  const store = getRegistryFromApp(app).forms.get(key)
  const shared = adapter.zodAdapter(schema)('construction-work', {
    maxRecursionDepth: DEFAULT_MAX_RECURSION_DEPTH,
  })
  expect(store?.schema).toBe(shared)
}

let keySeq = 0
const freshKey = (label: string): string => `construction-work-${label}-${(keySeq += 1)}`

/** Construct one client form on a schema nothing has touched yet. */
async function fresh(adapter: Adapter, fixture: Fixture): Promise<Record<string, Moment>> {
  const subject = instrument(adapter, fixture)
  const base = subject.read()
  const form = mountClient(adapter, subject.schema, freshKey('fresh'))
  const mounted = since(base, subject.read())
  void form.meta.valid
  const firstRead = since(base, subject.read())
  await settle()
  return { mounted, firstRead, settled: since(base, subject.read()) }
}

/** Construct a second client form on a schema another form already warmed. */
async function warm(adapter: Adapter, fixture: Fixture): Promise<Record<string, Moment>> {
  const subject = instrument(adapter, fixture)
  const first = mountClient(adapter, subject.schema, freshKey('warm-a'))
  void first.meta.valid
  await settle()
  const base = subject.read()
  const form = mountClient(adapter, subject.schema, freshKey('warm-b'))
  const mounted = since(base, subject.read())
  void form.meta.valid
  const firstRead = since(base, subject.read())
  await settle()
  return { mounted, firstRead, settled: since(base, subject.read()) }
}

/** Server construction, render and serialization. */
async function server(adapter: Adapter, fixture: Fixture): Promise<Record<string, Moment>> {
  const subject = instrument(adapter, fixture)
  const base = subject.read()
  const key = freshKey('server')
  const App = defineComponent({
    setup() {
      adapter.useForm({ schema: subject.schema, key, defaultValues: DEFAULTS })
      return () => h('div')
    },
  })
  const app = createSSRApp(App).use(createAttaform({ ssr: true }))
  await renderToString(app)
  renderAttaformState(app)
  expectSharedSchema(app, key, subject.schema, adapter)
  const rendered = since(base, subject.read())
  await settle()
  return { rendered, settled: since(base, subject.read()) }
}

/**
 * A hydrating client. The server builds its form on a separate,
 * structurally identical schema, as a server process would, so the client's
 * schema starts as cold as it does in a browser.
 */
async function hydrated(adapter: Adapter, fixture: Fixture): Promise<Record<string, Moment>> {
  const key = freshKey('hydrated')
  const serverSchema = makeSchema(adapter.z, fixture, { rootRefine: 0, leafRefine: 0 })
  const ServerApp = defineComponent({
    setup() {
      adapter.useForm({ schema: serverSchema, key, defaultValues: DEFAULTS })
      return () => h('div')
    },
  })
  const serverApp = createSSRApp(ServerApp).use(createAttaform({ ssr: true }))
  const html = await renderToString(serverApp)
  const payload = JSON.parse(JSON.stringify(renderAttaformState(serverApp)))

  const subject = instrument(adapter, fixture)
  const base = subject.read()
  const handle: { api?: any } = {}
  const ClientApp = defineComponent({
    setup() {
      handle.api = adapter.useForm({ schema: subject.schema, key, defaultValues: DEFAULTS })
      return () => h('div')
    },
  })
  const app = createSSRApp(ClientApp).use(createAttaform())
  hydrateAttaformState(app, payload)
  const container = document.createElement('div')
  container.innerHTML = html
  app.mount(container)
  apps.push(app)
  expectSharedSchema(app, key, subject.schema, adapter)
  const mounted = since(base, subject.read())
  void handle.api.meta.valid
  const firstRead = since(base, subject.read())
  await settle()
  return { mounted, firstRead, settled: since(base, subject.read()) }
}

const WIZARD_STEPS = 4

/**
 * A `useWizard` over four refined step forms, each on its own fresh schema.
 * Only the first step's `meta.valid` is read, as a page showing the active
 * step reads it; `rootRefineByStep` shows which steps paid for a verdict.
 */
async function wizard(adapter: Adapter): Promise<Record<string, unknown>> {
  const subjects = Array.from({ length: WIZARD_STEPS }, () => instrument(adapter, 'refined'))
  const bases = subjects.map((s) => s.read())
  const keys = subjects.map(() => freshKey('wizard'))
  const handle: { forms?: any[] } = {}
  const App = defineComponent({
    setup() {
      const forms = subjects.map((s, i) =>
        adapter.useForm({ schema: s.schema, key: keys[i], defaultValues: DEFAULTS })
      )
      handle.forms = forms
      useWizard({ steps: forms, restore: false, persist: false })
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.mount(document.createElement('div'))
  apps.push(app)
  subjects.forEach((s, i) => expectSharedSchema(app, keys[i] ?? '', s.schema, adapter))

  const at = (): Record<string, unknown> => {
    const perStep = subjects.map((s, i) => since(bases[i] ?? s.read(), s.read()))
    return { ...sum(perStep), rootRefineByStep: perStep.map((m) => m.rootRefine) }
  }
  const mounted = at()
  void handle.forms?.[0]?.meta.valid
  const activeStepRead = at()
  await settle()
  return { mounted, activeStepRead, settled: at() }
}

/**
 * One construction's calls into the root AbstractSchema: one starting-value
 * derivation (which today also runs the verdict parse), the per-path default
 * lookups of the structural merge and the unset-sentinel walk, and the blank
 * baseline the authored-path diff reads.
 */
const DERIVE = { getDefaultValues: 1, getDefaultAtPath: 4, getEmptyValueAtPath: 1 }
const DERIVE_4 = { getDefaultValues: 4, getDefaultAtPath: 16, getEmptyValueAtPath: 4 }

/**
 * Today's counts, keyed `mode/fixture`, then adapter. Lower a number in the
 * commit that earns it; never raise one.
 *
 * What they show on `main` (cf1d4638):
 * - Every construction runs the verdict parse at mount, read or not: a
 *   hydrating client too, which then replaces the verdict with the
 *   server's.
 * - v3 runs a second, post-mount async pass for any schema with a refine,
 *   since it cannot tell a sync refine from an async one.
 * - A fresh v4 schema is walked 5 times; a warm one still twice, the two
 *   async walks the derivation repeats unmemoized beside the factory's
 *   memoized pair.
 * - A wizard pays every step's verdict at mount, whichever step is shown.
 */
const PINNED: Record<string, Record<AdapterName, unknown>> = {
  'fresh/plain': {
    'zod-v4': {
      mounted: { ...DERIVE, rootRefine: 0, leafRefine: 0, rootWalks: 5 },
      firstRead: { ...DERIVE, rootRefine: 0, leafRefine: 0, rootWalks: 5 },
      settled: { ...DERIVE, rootRefine: 0, leafRefine: 0, rootWalks: 5 },
    },
    'zod-v3': {
      mounted: { ...DERIVE, rootRefine: 0, leafRefine: 0, rootWalks: 5 },
      firstRead: { ...DERIVE, rootRefine: 0, leafRefine: 0, rootWalks: 5 },
      settled: { ...DERIVE, rootRefine: 0, leafRefine: 0, rootWalks: 5 },
    },
  },
  'warm/plain': {
    'zod-v4': {
      mounted: { ...DERIVE, rootRefine: 0, leafRefine: 0, rootWalks: 2 },
      firstRead: { ...DERIVE, rootRefine: 0, leafRefine: 0, rootWalks: 2 },
      settled: { ...DERIVE, rootRefine: 0, leafRefine: 0, rootWalks: 2 },
    },
    'zod-v3': {
      mounted: { ...DERIVE, rootRefine: 0, leafRefine: 0, rootWalks: 1 },
      firstRead: { ...DERIVE, rootRefine: 0, leafRefine: 0, rootWalks: 1 },
      settled: { ...DERIVE, rootRefine: 0, leafRefine: 0, rootWalks: 1 },
    },
  },
  'server/plain': {
    'zod-v4': {
      rendered: { ...DERIVE, rootRefine: 0, leafRefine: 0, rootWalks: 5 },
      settled: { ...DERIVE, rootRefine: 0, leafRefine: 0, rootWalks: 5 },
    },
    'zod-v3': {
      rendered: { ...DERIVE, rootRefine: 0, leafRefine: 0, rootWalks: 5 },
      settled: { ...DERIVE, rootRefine: 0, leafRefine: 0, rootWalks: 5 },
    },
  },
  'hydrated/plain': {
    'zod-v4': {
      mounted: { ...DERIVE, rootRefine: 0, leafRefine: 0, rootWalks: 5 },
      firstRead: { ...DERIVE, rootRefine: 0, leafRefine: 0, rootWalks: 5 },
      settled: { ...DERIVE, rootRefine: 0, leafRefine: 0, rootWalks: 5 },
    },
    'zod-v3': {
      mounted: { ...DERIVE, rootRefine: 0, leafRefine: 0, rootWalks: 5 },
      firstRead: { ...DERIVE, rootRefine: 0, leafRefine: 0, rootWalks: 5 },
      settled: { ...DERIVE, rootRefine: 0, leafRefine: 0, rootWalks: 5 },
    },
  },
  'fresh/refined': {
    'zod-v4': {
      mounted: { ...DERIVE, rootRefine: 1, leafRefine: 1, rootWalks: 5 },
      firstRead: { ...DERIVE, rootRefine: 1, leafRefine: 1, rootWalks: 5 },
      settled: { ...DERIVE, rootRefine: 1, leafRefine: 1, rootWalks: 5 },
    },
    'zod-v3': {
      mounted: { ...DERIVE, rootRefine: 1, leafRefine: 1, rootWalks: 4 },
      firstRead: { ...DERIVE, rootRefine: 1, leafRefine: 1, rootWalks: 4 },
      settled: { ...DERIVE, rootRefine: 2, leafRefine: 2, rootWalks: 5 },
    },
  },
  'warm/refined': {
    'zod-v4': {
      mounted: { ...DERIVE, rootRefine: 1, leafRefine: 1, rootWalks: 2 },
      firstRead: { ...DERIVE, rootRefine: 1, leafRefine: 1, rootWalks: 2 },
      settled: { ...DERIVE, rootRefine: 1, leafRefine: 1, rootWalks: 2 },
    },
    'zod-v3': {
      mounted: { ...DERIVE, rootRefine: 1, leafRefine: 1, rootWalks: 1 },
      firstRead: { ...DERIVE, rootRefine: 1, leafRefine: 1, rootWalks: 1 },
      settled: { ...DERIVE, rootRefine: 2, leafRefine: 2, rootWalks: 1 },
    },
  },
  'server/refined': {
    'zod-v4': {
      rendered: { ...DERIVE, rootRefine: 1, leafRefine: 1, rootWalks: 5 },
      settled: { ...DERIVE, rootRefine: 1, leafRefine: 1, rootWalks: 5 },
    },
    'zod-v3': {
      rendered: { ...DERIVE, rootRefine: 1, leafRefine: 1, rootWalks: 4 },
      settled: { ...DERIVE, rootRefine: 1, leafRefine: 1, rootWalks: 4 },
    },
  },
  'hydrated/refined': {
    'zod-v4': {
      mounted: { ...DERIVE, rootRefine: 1, leafRefine: 1, rootWalks: 5 },
      firstRead: { ...DERIVE, rootRefine: 1, leafRefine: 1, rootWalks: 5 },
      settled: { ...DERIVE, rootRefine: 1, leafRefine: 1, rootWalks: 5 },
    },
    'zod-v3': {
      mounted: { ...DERIVE, rootRefine: 1, leafRefine: 1, rootWalks: 4 },
      firstRead: { ...DERIVE, rootRefine: 1, leafRefine: 1, rootWalks: 4 },
      settled: { ...DERIVE, rootRefine: 2, leafRefine: 2, rootWalks: 5 },
    },
  },
  'wizard/refined': {
    'zod-v4': {
      mounted: {
        ...DERIVE_4,
        rootRefine: 4,
        leafRefine: 4,
        rootWalks: 20,
        rootRefineByStep: [1, 1, 1, 1],
      },
      activeStepRead: {
        ...DERIVE_4,
        rootRefine: 4,
        leafRefine: 4,
        rootWalks: 20,
        rootRefineByStep: [1, 1, 1, 1],
      },
      settled: {
        ...DERIVE_4,
        rootRefine: 4,
        leafRefine: 4,
        rootWalks: 20,
        rootRefineByStep: [1, 1, 1, 1],
      },
    },
    'zod-v3': {
      mounted: {
        ...DERIVE_4,
        rootRefine: 4,
        leafRefine: 4,
        rootWalks: 16,
        rootRefineByStep: [1, 1, 1, 1],
      },
      activeStepRead: {
        ...DERIVE_4,
        rootRefine: 4,
        leafRefine: 4,
        rootWalks: 16,
        rootRefineByStep: [1, 1, 1, 1],
      },
      settled: {
        ...DERIVE_4,
        rootRefine: 8,
        leafRefine: 8,
        rootWalks: 20,
        rootRefineByStep: [2, 2, 2, 2],
      },
    },
  },
}

describe('construction work counters (#691)', () => {
  beforeEach(() => {
    const add = WeakSet.prototype.add
    vi.spyOn(WeakSet.prototype, 'add').mockImplementation(function (
      this: WeakSet<WeakKey>,
      value: WeakKey
    ) {
      const count = rootWalkCounts.get(value)
      if (count !== undefined) rootWalkCounts.set(value, count + 1)
      return add.call(this, value)
    })
  })
  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    vi.restoreAllMocks()
    rootWalkCounts.clear()
  })

  for (const adapter of ADAPTERS) {
    it(`${adapter.name}: control, the walk hook sees a direct root walk`, () => {
      const subject = instrument(adapter, 'plain')
      const before = subject.read().rootWalks
      adapter.walk(subject.schema)
      expect(subject.read().rootWalks - before).toBe(1)
    })

    for (const fixture of ['plain', 'refined'] as const) {
      for (const [mode, run] of [
        ['fresh', fresh],
        ['warm', warm],
        ['server', server],
        ['hydrated', hydrated],
      ] as const) {
        it(`${adapter.name}: ${mode} construction, ${fixture} schema`, async () => {
          const actual = await run(adapter, fixture)
          expect(actual).toEqual(PINNED[`${mode}/${fixture}`]?.[adapter.name])
        })
      }
    }

    it(`${adapter.name}: ${WIZARD_STEPS}-step wizard construction`, async () => {
      const actual = await wizard(adapter)
      expect(actual).toEqual(PINNED['wizard/refined']?.[adapter.name])
    })
  }
})
/* eslint-enable @typescript-eslint/no-explicit-any */
