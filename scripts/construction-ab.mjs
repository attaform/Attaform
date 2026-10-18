#!/usr/bin/env node
/**
 * Production-flavour construction A/B (#691). Measures what building a
 * wizard's forms costs in two built `dist/` directories, both loaded into
 * one process and alternated round by round, and prints each metric's
 * figure for both and the median change across runs.
 *
 * `bench/construction.bench.ts` runs the same shapes under vitest, but on
 * the dev build: `__DEV__` on, Vue's dev build, vitest's module wrapping.
 * That is fine for trends and wrong for a number anyone acts on, since dev
 * guards and dev warnings are part of what it times. This script imports
 * each side's production entry (`<dist>/zod-v4.mjs` or `zod-v3.mjs`) under
 * `NODE_ENV=production`, so Vue runs its production build too.
 *
 * How it measures, and why. A first version ran each side in its own
 * process and compared per-process means, the way `bench-delta.mjs`
 * compares revisions. On Docker for macOS under load that measured
 * nothing: the interquartile range across 13 runs was 100-200% of the
 * median, and `buildMs`, which runs identical code on both sides, moved by
 * 45%. Dumping single rounds showed why: inside one process, the same
 * 10-step hydrate took anywhere from 2.4 to 18 ms. A shared machine only
 * ever ADDS time to a round (preemption, a slower core, another
 * container's burst), so the fastest round is the one closest to the
 * work's own cost, and the mean or median is mostly a measure of the
 * neighbours. So:
 *
 *   - one worker process loads BOTH sides (two dist directories are two
 *     module instances sharing one Vue and one zod) and alternates them
 *     round by round, base then head, then head then base, so both sample
 *     the same stretch of machine weather;
 *   - each side reports its fastest timed round per metric;
 *   - the orchestrator repeats that in fresh processes (`--runs`),
 *     flipping which side loads first, and reports the median across runs
 *     of each side's figure and of the per-run change.
 *
 * Take 9 runs or more before quoting a figure, and read `buildMs` (or,
 * for the array ops, `parseMs`) first.
 *
 * What one run does. A worker process installs a jsdom window, imports
 * Vue, zod and both sides' entries, and builds the shapes from
 * `bench/lib/construction-forms.ts` (read through Node's built-in type
 * stripping, so the bench and this script measure identical schemas). Each
 * side gets its own schemas, so neither inherits the other's zod JIT or
 * Attaform's per-schema caches. It runs 3 warm-up rounds, then 20 timed
 * ones. Each round, per side:
 *
 *   clientMs        `createApp(Root).mount(el)` on a client registry
 *   clientDrainMs   until the microtask queue empties after it: the work
 *                   construction queued (the async validation pass)
 *   serverMs        `renderToString` + `renderAttaformState`
 *   hydrateMs       `createSSRApp(Root).mount(el)` over that render's
 *                   HTML, after `hydrateAttaformState` staged its payload
 *                   (JSON round-tripped)
 *   hydrateDrainMs  the same, after the hydrating mount
 *   buildMs         building one set of page schemas (fresh mode only)
 *
 * Columns: `base` and `head` are the median across runs of each side's
 * fastest round; `change` is the median across runs of head over base, as
 * a percentage; `spread` is the interquartile range of the per-run
 * changes, in percentage points. `buildMs` is zod's own work,
 * identical on both sides, so it is a free control: its change is the
 * noise floor, and a scenario moving by no more than that has not moved.
 *
 * The scenarios cross the two shapes the bench lib defines (`issue`:
 * #691's leaves, nothing observed; `cubic`: superRefine leaves, a rail
 * reading every step's validity), both adapters, and fresh or cached
 * schemas, on a wizard of `--steps` 30-field pages.
 *
 * Array-op modes. `--modes` also takes the typed array helpers, `append`,
 * `remove`, `insert`, `swap`, `move` and `replace`, or `arrays` for all six,
 * on the list shape of `bench/field-arrays.bench.ts`: both read the schema
 * and the calls from `bench/lib/field-array-forms.ts`. They run one scenario
 * per adapter, and the construction flags (`--shape`, `--schemas`,
 * `--steps`) do not apply. Each round, per side and op, a client form is
 * mounted and seeded with `--rows` posts by one `setValue`, which records
 * every row as appending them one by one does, at a twentieth of the cost.
 * Once the validation the seed scheduled has run, one batch of `--batch`
 * calls of the op is timed:
 *
 *   <op>Ms          the whole batch (`swapMs` is `--batch` swaps)
 *   parseMs         fifty zod parses of a seeded list: zod's own work, the
 *                   free control for these rows, as `buildMs` is above
 *
 * The validation the batch scheduled runs before the form unmounts, outside
 * the timing, so no batch inherits another's. A standing check of the
 * helpers, beside the construction one:
 *
 *   node scripts/construction-ab.mjs <baseDist> <headDist> --modes arrays
 *
 * Building a base dist. The container has no git, so extract the revision
 * on the host into a directory inside the tree, then build it in the
 * container against the tree's own node_modules:
 *
 *   # host, from the checkout or worktree root
 *   mkdir .ab-base && git archive <rev> | tar -x -C .ab-base
 *
 *   # container (docker compose -p attaform run --rm --no-deps attaform sh -c '...')
 *   ln -s /app/node_modules /app/.ab-base/node_modules \
 *     && cd /app/.ab-base && /app/node_modules/.bin/unbuild \
 *     && rm /app/.ab-base/node_modules
 *
 *   # container: build the head side, then compare
 *   cd /app && pnpm prepack && node scripts/construction-ab.mjs .ab-base/dist dist
 *
 *   # host, afterwards
 *   rm -rf .ab-base
 *
 * Run `unbuild` (what `prepack` runs), never `pnpm` itself, inside the
 * extraction. pnpm's pre-run dependency check sees a workspace whose
 * node_modules it did not install, runs `pnpm install`, and asks to purge
 * the modules directory, which is the symlinked shared one. Without a TTY
 * it aborts; with one it prompts, and a yes removes the shared install.
 *
 * A side's dist must sit inside the tree, so its `import 'vue'` resolves to
 * the same Vue the worker imports. The extraction can be patched before it
 * is built (`patch -p1 -d .ab-base < change.patch`), which is how a change
 * is measured without committing it.
 *
 * Usage:
 *   node scripts/construction-ab.mjs <baseDist> <headDist> [options]
 *
 *   --runs <n>        worker processes per scenario (default 9)
 *   --rounds <n>      timed rounds per run, after 3 warm-up rounds (default 20)
 *   --steps <n>       wizard steps, 30 fields each (default 10)
 *   --shape <s>       issue | cubic | all (default all)
 *   --adapter <a>     v4 | v3 | all (default all)
 *   --schemas <m>     fresh | cached | all (default all)
 *   --modes <list>    any of client,server,hydrate and of the array ops
 *                     append,remove,insert,swap,move,replace, or arrays for
 *                     all six (default client,server,hydrate)
 *   --rows <n>        posts each array-op form is seeded with (default 500)
 *   --batch <n>       calls per timed array-op batch, below --rows
 *                     (default 20)
 *   --profile         instead of timing, run each side alone under the CPU
 *                     profiler, once per scenario, and print the inclusive
 *                     and self summary of each cpuprofile
 *   --profile-dir <d> where the cpuprofiles go (default: a new temp dir)
 *   --focus <fn>      summarise only samples whose stack holds function <fn>
 *   --top <n>         inclusive rows to print per profile (default 40)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { argv, env, exit } from 'node:process'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = join(import.meta.dirname, '..')
const SELF = join(import.meta.dirname, 'construction-ab.mjs')
const LIB = join(ROOT, 'bench', 'lib', 'construction-forms.ts')
const ARRAY_LIB = join(ROOT, 'bench', 'lib', 'field-array-forms.ts')
const FIELDS_PER_PAGE = 30
const WARM_ROUNDS = 3

const METRICS = ['clientMs', 'clientDrainMs', 'serverMs', 'hydrateMs', 'hydrateDrainMs', 'buildMs']
const MODES = ['client', 'server', 'hydrate']
const { FIELD_ARRAY_OPS } = await import(pathToFileURL(ARRAY_LIB).href)
const ARRAY_OPS = Object.keys(FIELD_ARRAY_OPS)
// The zod parses one array-op round times beside its batches.
const CONTROL_PARSES = 50
const JSDOM_GLOBALS = [
  'window',
  'document',
  'Node',
  'Element',
  'HTMLElement',
  'SVGElement',
  'MutationObserver',
  'HTMLInputElement',
  'Event',
  'Comment',
  'Text',
]

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** The interquartile range, in the values' own unit. */
const iqr = (values) => {
  if (values.length < 4) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]
  return q(0.75) - q(0.25)
}

const now = () => performance.now()
// `setImmediate`, not `setTimeout(0)`: Node clamps the timer to 1 ms, which
// would bury the microtask work this is meant to time.
const drain = () => new Promise((done) => setImmediate(done))

// --- worker ------------------------------------------------------------

/**
 * One run, in its own process: `--worker <config-json>`, where
 * `config.sides` lists one or two `{ name, dist }`. Prints one JSON line:
 * per side, each metric's fastest timed round.
 */
async function worker(config) {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  // Before Vue loads: runtime-dom captures `document` at module scope.
  for (const key of JSDOM_GLOBALS) globalThis[key] = key === 'window' ? dom.window : dom.window[key]
  const { document } = dom.window

  const vue = await import('vue')
  const { renderToString } = await import('vue/server-renderer')
  const { z } = config.adapter === 'v4' ? await import('zod') : await import('zod-v3')
  if (config.ops !== undefined) {
    report(await arrayOpRounds(config, vue, z, document))
    return
  }
  const lib = await import(pathToFileURL(LIB).href)
  const build = () => lib.buildPages(z, config.adapter, config.shape, config.steps, FIELDS_PER_PAGE)

  const sides = []
  for (const { name, dist } of config.sides) {
    const entry = await import(pathToFileURL(join(dist, `zod-${config.adapter}.mjs`)).href)
    const cached = config.schemas === 'cached' ? build() : undefined
    const side = { name, entry, cached, current: cached, rounds: {} }
    for (const metric of METRICS) side.rounds[metric] = []
    side.Root = lib.wizardRoot(
      {
        defineComponent: vue.defineComponent,
        h: vue.h,
        useForm: entry.useForm,
        useWizard: entry.useWizard,
      },
      config.shape,
      () => side.current
    )
    sides.push(side)
  }

  const modes = new Set(config.modes)

  /** One round of every selected mode for one side. */
  async function round(side, timed) {
    const record = (metric, ms) => {
      if (timed) side.rounds[metric].push(ms)
    }
    const nextPages = () => {
      if (side.cached !== undefined) return
      const t0 = now()
      side.current = build()
      record('buildMs', now() - t0)
    }

    if (modes.has('client')) {
      nextPages()
      const el = document.createElement('div')
      const app = vue.createApp(side.Root).use(side.entry.createAttaform())
      let t0 = now()
      app.mount(el)
      record('clientMs', now() - t0)
      t0 = now()
      await drain()
      record('clientDrainMs', now() - t0)
      app.unmount()
    }

    let html = ''
    let payload
    if (modes.has('server') || modes.has('hydrate')) {
      nextPages()
      const app = vue.createSSRApp(side.Root).use(side.entry.createAttaform({ ssr: true }))
      const t0 = now()
      html = await renderToString(app)
      const state = side.entry.renderAttaformState(app)
      if (modes.has('server')) record('serverMs', now() - t0)
      payload = JSON.parse(JSON.stringify(state))
    }

    if (modes.has('hydrate')) {
      nextPages()
      const el = document.createElement('div')
      el.innerHTML = html
      document.body.appendChild(el)
      const app = vue.createSSRApp(side.Root).use(side.entry.createAttaform())
      side.entry.hydrateAttaformState(app, payload)
      let t0 = now()
      app.mount(el)
      record('hydrateMs', now() - t0)
      // A mount that never consumed its snapshots measured a client mount.
      const pending = side.entry.getRegistryFromApp(app).pendingHydration?.size ?? 0
      if (pending !== 0) {
        throw new Error(`${side.name} hydrate: ${pending} staged snapshot(s) never consumed`)
      }
      t0 = now()
      await drain()
      record('hydrateDrainMs', now() - t0)
      app.unmount()
      el.remove()
    }
  }

  for (let r = 0; r < WARM_ROUNDS + config.rounds; r++) {
    // Alternate which side goes first, so neither always inherits the
    // other's warm caches or its garbage.
    const order = r % 2 === 0 ? sides : [...sides].reverse()
    for (const side of order) await round(side, r >= WARM_ROUNDS)
  }
  report(sides)
}

/**
 * The array-op rounds of one run. Each side gets its own schema, as for
 * construction, and every batch a freshly seeded form, so each starts from
 * the same list.
 */
async function arrayOpRounds(config, vue, z, document) {
  const lib = await import(pathToFileURL(ARRAY_LIB).href)
  // A new list each time: the form may keep the one it is handed.
  const posts = () => Array.from({ length: config.rows }, (_, i) => lib.newPost(i))
  const list = { posts: posts() }
  // Long enough for the validation a write scheduled to run: its timer, then
  // the microtasks of the run.
  const settle = () => new Promise((done) => setTimeout(done, 1)).then(drain)

  const sides = []
  for (const { name, dist } of config.sides) {
    const entry = await import(pathToFileURL(join(dist, `zod-${config.adapter}.mjs`)).href)
    const rounds = { parseMs: [] }
    for (const op of config.ops) rounds[`${op}Ms`] = []
    sides.push({ name, entry, schema: lib.fieldArraySchema(z), rounds })
  }

  async function seeded(side) {
    let form
    const Root = vue.defineComponent({
      setup() {
        form = side.entry.useForm({ schema: side.schema, key: 'posts' })
        return () => vue.h('div')
      },
    })
    const app = vue.createApp(Root).use(side.entry.createAttaform())
    app.mount(document.createElement('div'))
    form.setValue('posts', posts())
    await settle()
    return { app, form }
  }

  async function round(side, timed) {
    for (const op of config.ops) {
      const { app, form } = await seeded(side)
      const call = lib.FIELD_ARRAY_OPS[op]
      const t0 = now()
      for (let i = 0; i < config.batch; i++) call(form, config.rows, i)
      const ms = now() - t0
      if (timed) side.rounds[`${op}Ms`].push(ms)
      await settle()
      app.unmount()
    }
    const t0 = now()
    for (let i = 0; i < CONTROL_PARSES; i++) side.schema.safeParse(list)
    if (timed) side.rounds.parseMs.push(now() - t0)
  }

  for (let r = 0; r < WARM_ROUNDS + config.rounds; r++) {
    const order = r % 2 === 0 ? sides : [...sides].reverse()
    for (const side of order) await round(side, r >= WARM_ROUNDS)
  }
  return sides
}

/** Print one JSON line: per side, each metric's fastest timed round. */
function report(sides) {
  const out = {}
  for (const side of sides) {
    out[side.name] = {}
    for (const [metric, rounds] of Object.entries(side.rounds)) {
      if (rounds.length > 0) out[side.name][metric] = Math.min(...rounds)
    }
  }
  process.stdout.write(`${JSON.stringify(out)}\n`)
}

// --- cpuprofile summary ------------------------------------------------

/** Shorten a call frame to `fn file:line`, keeping a package's name. */
function frameLabel(callFrame) {
  const url = callFrame.url
    .replace(/^.*node_modules\/\.pnpm\/([^/]+)\/node_modules\//, '$1:')
    .replace(/^file:\/\//, '')
    .replace(`${ROOT}/`, '')
  const file = url.split('/').slice(-2).join('/')
  return `${callFrame.functionName || '(anon)'} ${file}:${callFrame.lineNumber + 1}`
}

/**
 * Inclusive and self milliseconds per function. A recursive frame counts
 * once per sample, so recursion never inflates its inclusive time.
 */
function summariseProfile(file, focus, top) {
  const profile = JSON.parse(readFileSync(file, 'utf8'))
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map()
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parent.set(child, node.id)
  }
  const inclusive = new Map()
  const self = new Map()
  let total = 0
  for (let i = 0; i < profile.samples.length; i++) {
    const ms = (profile.timeDeltas[i] ?? 0) / 1000
    const stack = []
    for (let id = profile.samples[i]; id !== undefined; id = parent.get(id)) {
      stack.push(byId.get(id))
    }
    if (focus !== undefined && !stack.some((n) => n.callFrame.functionName === focus)) continue
    total += ms
    const leaf = frameLabel(stack[0].callFrame)
    self.set(leaf, (self.get(leaf) ?? 0) + ms)
    const seen = new Set()
    for (const node of stack) {
      const label = frameLabel(node.callFrame)
      if (seen.has(label)) continue
      seen.add(label)
      inclusive.set(label, (inclusive.get(label) ?? 0) + ms)
    }
  }
  const rows = (map, count) =>
    [...map]
      .sort((a, b) => b[1] - a[1])
      .slice(0, count)
      .map(([label, ms]) => {
        const pct = total > 0 ? (100 * ms) / total : 0
        return `${ms.toFixed(1).padStart(8)} ms ${pct.toFixed(1).padStart(5)}%  ${label}`
      })
      .join('\n')
  const scope = focus === undefined ? '' : ` (stacks holding ${focus})`
  return `total ${total.toFixed(1)} ms${scope}\n--- inclusive\n${rows(inclusive, top)}\n--- self\n${rows(self, 25)}`
}

// --- orchestrator ------------------------------------------------------

function runWorker(config, nodeFlags = []) {
  const out = execFileSync(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      ...nodeFlags,
      SELF,
      '--worker',
      JSON.stringify(config),
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'inherit'],
    }
  )
  const line = out.trim().split('\n').pop() ?? '{}'
  return JSON.parse(line)
}

function pick(value, all, name) {
  const chosen = value === 'all' ? all : value.split(',').map((s) => s.trim())
  for (const item of chosen) {
    if (!all.includes(item)) {
      console.error(`[construction-ab] unknown ${name} '${item}'; expected ${all.join(', ')}`)
      exit(2)
    }
  }
  return chosen
}

function positiveInt(value, name) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) {
    console.error(`[construction-ab] --${name} must be a positive integer, got '${value}'`)
    exit(2)
  }
  return n
}

async function main() {
  const { values, positionals } = parseArgs({
    args: argv.slice(2),
    allowPositionals: true,
    options: {
      runs: { type: 'string', default: '9' },
      rounds: { type: 'string', default: '20' },
      steps: { type: 'string', default: '10' },
      shape: { type: 'string', default: 'all' },
      adapter: { type: 'string', default: 'all' },
      schemas: { type: 'string', default: 'all' },
      modes: { type: 'string', default: MODES.join(',') },
      rows: { type: 'string', default: '500' },
      batch: { type: 'string', default: '20' },
      profile: { type: 'boolean', default: false },
      'profile-dir': { type: 'string' },
      focus: { type: 'string' },
      top: { type: 'string', default: '40' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help || positionals.length !== 2) {
    const header = readFileSync(SELF, 'utf8').split('\n * Usage:')[1]?.split('*/')[0] ?? ''
    console.log(`Usage:${header.replace(/^ \*( |$)/gm, '')}`)
    exit(values.help ? 0 : 2)
  }

  const sides = positionals.map((dir, i) => ({
    name: i === 0 ? 'base' : 'head',
    dist: resolve(dir),
  }))
  for (const side of sides) {
    if (!existsSync(join(side.dist, 'zod-v4.mjs'))) {
      console.error(`[construction-ab] ${side.name}: no zod-v4.mjs in ${side.dist}; build it first`)
      exit(2)
    }
  }

  const runs = positiveInt(values.runs, 'runs')
  const rounds = positiveInt(values.rounds, 'rounds')
  const steps = positiveInt(values.steps, 'steps')
  const rows = positiveInt(values.rows, 'rows')
  const batch = positiveInt(values.batch, 'batch')
  const chosen = pick(
    values.modes.replace(/\barrays\b/, ARRAY_OPS.join(',')),
    [...MODES, ...ARRAY_OPS],
    'mode'
  )
  const modes = chosen.filter((mode) => MODES.includes(mode))
  const ops = chosen.filter((mode) => ARRAY_OPS.includes(mode))
  if (ops.length > 0 && batch >= rows) {
    console.error(`[construction-ab] --batch (${batch}) must be below --rows (${rows})`)
    exit(2)
  }
  const adapters = pick(values.adapter, ['v4', 'v3'], 'adapter')
  const configs = []
  if (modes.length > 0) {
    for (const shape of pick(values.shape, ['issue', 'cubic'], 'shape')) {
      for (const adapter of adapters) {
        for (const schemas of pick(values.schemas, ['fresh', 'cached'], 'schemas')) {
          configs.push({ shape, adapter, schemas, steps, rounds, modes })
        }
      }
    }
  }
  if (ops.length > 0) {
    for (const adapter of adapters) configs.push({ adapter, rows, batch, rounds, ops })
  }
  const scenario = (c) =>
    c.ops === undefined
      ? `${c.shape} ${c.adapter} ${c.schemas.padEnd(6)} N=${c.steps}`
      : `arrays ${c.adapter} rows=${c.rows}`
  const metricsOf = (c) =>
    c.ops === undefined ? METRICS : [...c.ops.map((op) => `${op}Ms`), 'parseMs']

  if (values.profile) {
    const dir = resolve(
      values['profile-dir'] ?? mkdtempSync(join(tmpdir(), 'attaform-construction-prof-'))
    )
    const top = positiveInt(values.top, 'top')
    for (const config of configs) {
      for (const side of sides) {
        const out = join(
          dir,
          config.ops === undefined
            ? `${side.name}-${config.shape}-${config.adapter}-${config.schemas}`
            : `${side.name}-arrays-${config.adapter}`
        )
        mkdirSync(out, { recursive: true })
        runWorker({ ...config, sides: [side] }, [
          '--cpu-prof',
          `--cpu-prof-dir=${out}`,
          '--cpu-prof-interval=100',
        ])
        const newest = readdirSync(out)
          .filter((f) => f.endsWith('.cpuprofile'))
          .sort()
          .pop()
        if (newest === undefined) throw new Error(`no cpuprofile written to ${out}`)
        console.log(`\n=== ${side.name}: ${scenario(config)}  ${join(out, newest)}`)
        console.log(summariseProfile(join(out, newest), values.focus, top))
      }
    }
    return
  }

  const samples = new Map()
  for (let run = 1; run <= runs; run++) {
    console.error(`[construction-ab] run ${run}/${runs}`)
    for (const config of configs) {
      // Flip which side the worker loads and runs first on alternate runs.
      const order = run % 2 === 1 ? sides : [...sides].reverse()
      const result = runWorker({ ...config, sides: order })
      for (const metric of metricsOf(config)) {
        const b = result.base?.[metric]
        const h = result.head?.[metric]
        if (b === undefined || h === undefined || !(b > 0)) continue
        const key = `${scenario(config)}\t${metric}`
        const entry = samples.get(key) ?? { base: [], head: [], change: [] }
        entry.base.push(b)
        entry.head.push(h)
        entry.change.push(100 * (h / b - 1))
        samples.set(key, entry)
      }
    }
  }

  const row = (cells) =>
    cells.map((c, i) => (i < 2 ? String(c).padEnd(i === 0 ? 20 : 14) : String(c).padStart(7)))
  const lines = [
    `base ${sides[0].dist}`,
    `head ${sides[1].dist}`,
    `${runs} run(s) of ${rounds} alternating round(s); ms, median of per-run fastest`,
    '',
    row(['scenario', 'metric', 'base', 'head', 'change', 'spread']).join(' '),
  ]
  for (const [key, { base, head, change }] of samples) {
    const [name, metric] = key.split('\t')
    const mid = median(change)
    const spread = iqr(change)
    lines.push(
      row([
        name,
        metric,
        median(base).toFixed(2),
        median(head).toFixed(2),
        `${mid >= 0 ? '+' : ''}${mid.toFixed(1)}%`,
        Number.isFinite(spread) ? `${spread.toFixed(1)}pp` : '-',
      ]).join(' ')
    )
  }
  console.log(lines.join('\n'))
}

if (argv[2] === '--worker') {
  await worker(JSON.parse(argv[3]))
} else {
  await main()
}
