// @vitest-environment jsdom
/**
 * Construction bench (#691): what a page of wizard forms costs before the
 * user sees the first step, in each of the three places a form is built.
 *
 *   client   `createApp(...).mount(el)`: a client-rendered page.
 *   server   `renderToString` + `renderAttaformState`: the server half of
 *            an SSR page, through the payload it ships.
 *   hydrate  `createSSRApp(...).mount(el)` over the server's HTML, after
 *            `hydrateAttaformState` staged a real `renderAttaformState`
 *            payload that went through a JSON round trip.
 *
 * Each mode runs both profiles from `bench/lib/construction-forms.ts`
 * (issue-style leaves with nothing observed, cubic-style leaves with every
 * step's validity read by a rail), N = 4 and 10 steps of 30-field pages,
 * schemas built fresh per mount or once and cached, on zod v4 and v3.
 * Only the mount is timed: building schemas, creating the app, staging
 * hydration and unmounting run in the `beforeEach` / `afterEach` hooks.
 * `afterEach` also drains one macrotask before unmounting, so validation a
 * construction queued never lands inside a later sample.
 *
 * Why jsdom, when every other bench file runs in node with no DOM. vitest
 * bench honours the `@vitest-environment` pragma, and that is the only way
 * to measure the real client paths. The alternative, a setup-only
 * `renderToString` against a non-SSR registry, runs `setup()` with Vue's
 * SSR flag up, under which a non-immediate `watch` is never created and
 * mount hooks never register; `useWizard` and the form store both create
 * such watchers at construction, so that route would under-count the
 * client. And hydration needs real server markup to hydrate against.
 *
 * This runs the dev build (`__DEV__` on, Vue's dev build), so read it for
 * trends and relative moves only. Numbers worth reporting come from
 * `scripts/construction-ab.mjs`, which measures production builds of two
 * revisions interleaved. `scripts/bench-delta.mjs` runs this file on every
 * PR against the merge base.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, type BenchRegistration } from 'vitest'
import { createApp, createSSRApp, defineComponent, h, type App } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../src/zod-v4'
import { useForm as useFormV3 } from '../src/zod-v3'
import { useWizard } from '../src/runtime/composables/use-wizard'
import { createAttaform } from '../src/runtime/core/plugin'
import { getRegistryFromApp } from '../src/runtime/core/registry'
import {
  hydrateAttaformState,
  renderAttaformState,
  type SerializedAttaformState,
} from '../src/runtime/core/serialize'
import {
  buildPages,
  FIELDS_PER_PAGE,
  wizardRoot,
  type ConstructionPage,
  type ConstructionProfile,
  type ZodMajor,
} from './lib/construction-forms'

type Adapter = { tag: ZodMajor; z: any; useForm: any }
const ADAPTERS: Adapter[] = [
  { tag: 'v4', z: zV4, useForm: useFormV4 },
  { tag: 'v3', z: zV3, useForm: useFormV3 },
]

const PROFILES: ConstructionProfile[] = ['issue', 'cubic']
const STEP_COUNTS = [4, 10]
const SCHEMA_MODES = ['fresh', 'cached'] as const
type SchemaMode = (typeof SCHEMA_MODES)[number]

/**
 * Per-arm sampling. A 10-step mount runs tens of milliseconds on the dev
 * build, and `bench-delta` runs this file several times per PR, so each arm
 * gets a short window and a floor of samples rather than tinybench's
 * one-second default.
 */
const RUN_OPTIONS = { time: 400, iterations: 10, warmupTime: 100, warmupIterations: 3 }

const drain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** One arm's schemas: rebuilt in `beforeEach` when fresh, built once when cached. */
function pageSource(
  adapter: Adapter,
  profile: ConstructionProfile,
  steps: number,
  schemas: SchemaMode
): { current: () => ConstructionPage[]; refresh: () => void } {
  const build = (): ConstructionPage[] =>
    buildPages(adapter.z, adapter.tag, profile, steps, FIELDS_PER_PAGE)
  let pages = build()
  return {
    current: () => pages,
    refresh: () => {
      if (schemas === 'fresh') pages = build()
    },
  }
}

function rootFor(
  adapter: Adapter,
  profile: ConstructionProfile,
  current: () => ConstructionPage[]
): any {
  return wizardRoot({ defineComponent, h, useForm: adapter.useForm, useWizard }, profile, current)
}

const label = (
  mode: string,
  profile: ConstructionProfile,
  steps: number,
  schemas: SchemaMode,
  adapter: Adapter
): string => `${mode} ${profile} N=${steps} ${schemas} [${adapter.tag}]`

test('construction: client mount of an N-step wizard', async ({ bench }) => {
  const arms: BenchRegistration<string>[] = []
  for (const adapter of ADAPTERS) {
    for (const profile of PROFILES) {
      for (const steps of STEP_COUNTS) {
        for (const schemas of SCHEMA_MODES) {
          const source = pageSource(adapter, profile, steps, schemas)
          const Root = rootFor(adapter, profile, source.current)
          let app: App | undefined
          let el: HTMLElement | undefined
          arms.push(
            bench(
              label('client', profile, steps, schemas, adapter),
              {
                beforeEach: () => {
                  source.refresh()
                  el = document.createElement('div')
                  app = createApp(Root).use(createAttaform({ devtools: false }))
                },
                afterEach: async () => {
                  await drain()
                  app?.unmount()
                },
              },
              () => {
                app?.mount(el ?? document.createElement('div'))
              }
            )
          )
        }
      }
    }
  }
  await bench.compare(...arms, RUN_OPTIONS)
})

test('construction: server render and payload of an N-step wizard', async ({ bench }) => {
  const arms: BenchRegistration<string>[] = []
  for (const adapter of ADAPTERS) {
    for (const profile of PROFILES) {
      for (const steps of STEP_COUNTS) {
        for (const schemas of SCHEMA_MODES) {
          const source = pageSource(adapter, profile, steps, schemas)
          const Root = rootFor(adapter, profile, source.current)
          let app: App | undefined
          arms.push(
            bench(
              label('server', profile, steps, schemas, adapter),
              {
                beforeEach: () => {
                  source.refresh()
                  app = createSSRApp(Root).use(createAttaform({ ssr: true }))
                },
              },
              async () => {
                if (app === undefined) return
                await renderToString(app)
                renderAttaformState(app)
              }
            )
          )
        }
      }
    }
  }
  await bench.compare(...arms, RUN_OPTIONS)
})

/**
 * The server markup and JSON-round-tripped payload a hydrating client
 * starts from, rendered once per arm from that arm's own schema shape.
 */
async function serverRender(
  Root: any
): Promise<{ html: string; payload: SerializedAttaformState }> {
  const app = createSSRApp(Root).use(createAttaform({ ssr: true }))
  const html = await renderToString(app)
  const payload: SerializedAttaformState = JSON.parse(JSON.stringify(renderAttaformState(app)))
  return { html, payload }
}

/**
 * Premise guard: a hydrate arm must consume every staged snapshot and
 * hydrate without a mismatch, or it silently measures a client mount.
 */
function assertHydrates(
  Root: any,
  html: string,
  payload: SerializedAttaformState,
  name: string
): void {
  const warnings: string[] = []
  const el = document.createElement('div')
  el.innerHTML = html
  document.body.appendChild(el)
  const app = createSSRApp(Root).use(createAttaform({ devtools: false }))
  app.config.warnHandler = (message) => {
    warnings.push(message)
  }
  hydrateAttaformState(app, payload)
  app.mount(el)
  const pending = getRegistryFromApp(app).pendingHydration.size
  app.unmount()
  el.remove()
  if (pending !== 0) throw new Error(`${name}: ${pending} hydration snapshot(s) never consumed`)
  const mismatch = warnings.find((w) => w.includes('Hydration'))
  if (mismatch !== undefined) throw new Error(`${name}: hydration mismatch: ${mismatch}`)
}

test('construction: client hydration of an N-step wizard', async ({ bench }) => {
  const arms: BenchRegistration<string>[] = []
  for (const adapter of ADAPTERS) {
    for (const profile of PROFILES) {
      for (const steps of STEP_COUNTS) {
        for (const schemas of SCHEMA_MODES) {
          const name = label('hydrate', profile, steps, schemas, adapter)
          const source = pageSource(adapter, profile, steps, schemas)
          const Root = rootFor(adapter, profile, source.current)
          const { html, payload } = await serverRender(Root)
          assertHydrates(Root, html, payload, name)
          let app: App | undefined
          let el: HTMLElement | undefined
          arms.push(
            bench(
              name,
              {
                beforeEach: () => {
                  source.refresh()
                  el = document.createElement('div')
                  el.innerHTML = html
                  document.body.appendChild(el)
                  app = createSSRApp(Root).use(createAttaform({ devtools: false }))
                  hydrateAttaformState(app, payload)
                },
                afterEach: async () => {
                  await drain()
                  app?.unmount()
                  el?.remove()
                },
              },
              () => {
                app?.mount(el ?? document.createElement('div'))
              }
            )
          )
        }
      }
    }
  }
  await bench.compare(...arms, RUN_OPTIONS)
})
