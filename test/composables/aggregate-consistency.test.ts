// @vitest-environment jsdom
/**
 * After a write that removes structure, every aggregate a container derives
 * from its descendants agrees with what the descendants that exist now say
 * it should be (#705).
 *
 * A container reads its aggregates from a walk over the leaves present now,
 * so a removal used to take its leaves' state away with them. The #705 plan
 * decided, aggregate by aggregate, what a removal does to the reading:
 *
 * | Aggregate                                          | After a removal                              | Plan   | Pinned   |
 * | -------------------------------------------------- | -------------------------------------------- | ------ | -------- |
 * | `touched`, `interacted`, `blurredAfterInteraction` | Survive: folded into every ancestor's record | D6     | yes      |
 * | the same, after `reset()` / `resetField(p)`        | Cleared everywhere / under `p`               | D6     | yes      |
 * | `displayState` of an error the removal caused      | Reveals, through the surviving history       | D6     | yes      |
 * | `dirty`, `pristine`                                | Live; removed baselines dirty until restored | D6, D7 | yes      |
 * | `errors`, `valid`                                  | Live; a survivor keeps its own, re-indexed   | D6     | `errors` |
 * | `blank`                                            | Live; blank when every present leaf is       | D6     | yes      |
 * | `validating`                                       | Live; a removed row's run stops counting     | D6     | yes      |
 * | `transforming`                                     | Live                                         | D6     | no       |
 * | `focused`, `blurred`, `connected`                  | Live, DOM-owned                              | D6     | no       |
 *
 * "Survive" means a container reads OR(its present descendants, its own
 * record), and a removal folds the dropped record's flags into the own
 * record of every ancestor. "Live" means the reading comes from what exists
 * now, and no `flush: 'sync'` observer can freeze it (D7).
 *
 * Every write runs twice: with the aggregates read (and so cached) before
 * the write and nothing observing them, and under `flush: 'sync'` watchers
 * on the form's aggregates, which evaluate them mid-write. A reading that
 * depends on a structure Vue cannot see goes stale under the second. Both
 * adapters, at two depths: a top-level array and `members[0].income.entries`.
 *
 * Each reading is checked against a truth computed independently of
 * Attaform:
 *
 * - `dirty`: the value at the path differs from its baseline, each surviving
 *   row compared with the baseline of the row it came from;
 * - `errors`: the schema's own `safeParseAsync` verdict on the current value;
 * - interaction flags: which row was interacted with before the write, and
 *   where that row went;
 * - `blank`: the present leaves under the path;
 * - `validating`: whether the row holding an in-flight check still exists.
 *
 * Two readings are out of scope and skipped where they arise: the errors a
 * history replay restores (the history contract, see `Op.history`), and the
 * blank mark of a leaf a whole-array write passes back through (the blank
 * rules for written leaves, see `Op.rewritesRows`).
 *
 * Soft expectations, so one run reports every broken aggregate of a row.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { h, nextTick, watch, withDirectives, type App, type VNode, type WatchOptions } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { historyPlugin } from '../../src/history'
import { vRegister } from '../../src/runtime/core/directive'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { unset, useForm as useFormV4 } from '../../src/zod-v4'
import { makeMounter, wait, waitUntil } from '../utils/form-harness'

// The v3 and v4 `useForm` overload sets do not unify into one callable
// signature, so an adapter-agnostic caller types the function the way
// `makeMounter` does.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (options: any) => any

type Segment = string | number
type Path = readonly Segment[]

type ErrorProbe = { readonly path: readonly Segment[]; readonly code: string }

/** The aggregate slice of a `FieldState` the matrix reads. */
type StateProbe = {
  readonly value: unknown
  readonly dirty: boolean
  readonly touched: boolean
  readonly interacted: boolean
  readonly blurredAfterInteraction: boolean
  readonly blank: boolean
  readonly validating: boolean
  readonly errors: readonly ErrorProbe[]
  readonly displayState: string
}

/** The slice of the form handle the matrix drives and reads. */
type Probe = {
  readonly setValue: (path: Path, value: unknown) => boolean
  readonly clear: (path: Path) => boolean
  readonly append: (path: string, value: unknown) => void
  readonly prepend: (path: string, value: unknown) => void
  readonly insert: (path: string, index: number, value: unknown) => void
  readonly remove: (path: string, index: number) => void
  readonly swap: (path: string, a: number, b: number) => void
  readonly move: (path: string, from: number, to: number) => void
  readonly replace: (path: string, index: number, value: unknown) => void
  readonly reset: () => void
  readonly resetField: (path: string) => void
  readonly interact: (path: Path) => Promise<void>
  readonly history: { readonly undo: () => boolean; readonly redo: () => boolean }
  readonly meta: StateProbe
  readonly fields: (path: Path) => StateProbe | undefined
  readonly register: (path: string) => unknown
}

// --- The held check ---

/** The value whose async check stays in flight until the test releases it. */
const SLOW = 'slow'

let release: () => void = () => {}
let held: Promise<void> = Promise.resolve()

function holdChecks(): void {
  held = new Promise<void>((resolve) => {
    release = resolve
  })
}

async function settles(value: string): Promise<boolean> {
  if (value === SLOW) await held
  return true
}

// --- Schemas ---

function buildSchemaV4() {
  const entry = zV4.object({
    amount: zV4.string().min(2, 'amount').refine(settles),
    memo: zV4.string().optional(),
  })
  const pay = zV4.discriminatedUnion('kind', [
    zV4.object({ kind: zV4.literal('cash'), amount: zV4.string() }),
    zV4.object({ kind: zV4.literal('card'), last4: zV4.string() }),
  ])
  const scope = { entries: zV4.array(entry).min(2, 'two rows'), pay }
  return zV4.object({
    note: zV4.string(),
    ...scope,
    members: zV4.array(zV4.object({ name: zV4.string(), income: zV4.object(scope) })),
  })
}

function buildSchemaV3() {
  const entry = zV3.object({
    amount: zV3.string().min(2, 'amount').refine(settles),
    memo: zV3.string().optional(),
  })
  const pay = zV3.discriminatedUnion('kind', [
    zV3.object({ kind: zV3.literal('cash'), amount: zV3.string() }),
    zV3.object({ kind: zV3.literal('card'), last4: zV3.string() }),
  ])
  const scope = { entries: zV3.array(entry).min(2, 'two rows'), pay }
  return zV3.object({
    note: zV3.string(),
    ...scope,
    members: zV3.array(zV3.object({ name: zV3.string(), income: zV3.object(scope) })),
  })
}

type Adapter = {
  readonly name: string
  readonly useFormFn: AnyUseForm
  readonly schema: unknown
  /** The schema's own verdict on `value`, as sorted `path:code` keys. */
  readonly verdict: (value: unknown) => Promise<string[]>
}

const issueKey = (path: readonly PropertyKey[], code: string): string =>
  `${path.map((s) => String(s)).join('.')}:zod:${code}`

const schemaV4 = buildSchemaV4()
const schemaV3 = buildSchemaV3()

const adapters: readonly Adapter[] = [
  {
    name: 'zod v4',
    useFormFn: useFormV4,
    schema: schemaV4,
    verdict: async (value) => {
      const result = await schemaV4.safeParseAsync(value)
      return result.success ? [] : result.error.issues.map((i) => issueKey(i.path, i.code)).sort()
    },
  },
  {
    name: 'zod v3',
    useFormFn: useFormV3,
    schema: schemaV3,
    verdict: async (value) => {
      const result = await schemaV3.safeParseAsync(value)
      return result.success ? [] : result.error.issues.map((i) => issueKey(i.path, i.code)).sort()
    },
  },
]

// --- Defaults and baseline ---

/**
 * Row 1 is invalid (`amount` is too short) and its `memo` is marked blank
 * through `unset`, so an index shift moves an error and a blank mark.
 */
const scopeDefaults = (blankMemo: unknown) => ({
  entries: [
    { amount: 'aa', memo: 'ma' },
    { amount: 'b', memo: blankMemo },
    { amount: 'cc', memo: 'mc' },
  ],
  pay: { kind: 'cash', amount: '10' },
})

const formValues = (blankMemo: unknown) => ({
  note: 'n',
  ...scopeDefaults(blankMemo),
  members: [
    { name: 'm0', income: scopeDefaults(blankMemo) },
    { name: 'm1', income: scopeDefaults(blankMemo) },
  ],
})

/** What `useForm` receives. */
const defaultValues = () => formValues(unset)
/** What storage holds at construction: an `unset` optional leaf is absent. */
const baseline = () => formValues(undefined)

const depths: readonly { name: string; scope: Path }[] = [
  { name: 'top level', scope: [] },
  { name: 'members[0].income', scope: ['members', 0, 'income'] },
]

// --- Plain-value helpers ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A deep plain copy, free of Vue proxies. */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain)
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = plain(v)
    return out
  }
  return value
}

/** Deep equality that reads a key holding `undefined` as an absent key. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]))
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) if (!sameValue(a[k], b[k])) return false
    return true
  }
  return false
}

function valueAt(source: unknown, path: Path): unknown {
  let cursor: unknown = source
  for (const segment of path) {
    if (Array.isArray(cursor) && typeof segment === 'number') cursor = cursor[segment]
    else if (isRecord(cursor) && typeof segment === 'string') cursor = cursor[segment]
    else return undefined
  }
  return cursor
}

function listAt(source: unknown): unknown[] {
  return Array.isArray(source) ? source : []
}

const dotted = (path: Path): string => path.join('.')

/** The root, every ancestor of `target`, and `target` itself. */
function chainTo(target: Path): Path[] {
  const out: Path[] = []
  for (let i = 0; i <= target.length; i++) out.push(target.slice(0, i))
  return out
}

const errorKeys = (errors: readonly ErrorProbe[] | undefined): string[] =>
  (errors ?? []).map((e) => `${dotted(e.path)}:${e.code}`).sort()

// --- The rows ---

type Ctx = {
  readonly form: Probe
  readonly root: HTMLElement
  readonly scope: Path
  readonly target: Path
  readonly row: (i: number) => Path
}

/** Where each present row came from: its pre-write index, or `'fresh'`. */
type Origins = readonly (number | 'fresh')[]

type Op = {
  readonly name: string
  readonly target: 'entries' | 'pay'
  /** The path, relative to the scope, interacted with before the write. */
  readonly victim: Path
  readonly run: (ctx: Ctx) => void
  /** Where each present row of `entries` came from; omitted for a replay. */
  readonly origins?: Origins
  /** Interaction flags the write itself sets, by present row. */
  readonly ownFlags?: Readonly<Record<number, Partial<Flags>>>
  /** The write clears the interaction history under the target (D6). */
  readonly clearsFlags?: true
  /**
   * The write passes every row's value back through a value write, so the
   * `unset` mark on row 1's `memo` follows the blank rules for a written
   * leaf rather than the removal rules this file pins; that leaf is skipped.
   */
  readonly rewritesRows?: true
  /** Writes that set the row up, after the interaction and before the write. */
  readonly prep?: (ctx: Ctx) => void
  /**
   * A history replay. It restores the error map recorded with the position,
   * which under an async schema predates that position's own verdict, so a
   * replay's errors are the history contract and are not pinned here.
   */
  readonly history?: true
  readonly render?: (form: Probe, ctx: { scope: Path }) => VNode
  /**
   * Whether the in-flight check row runs. It needs the write to keep or
   * remove the held row, not overwrite it while its run is in flight.
   */
  readonly inFlight?: false
}

type Flags = {
  readonly touched: boolean
  readonly interacted: boolean
  readonly blurredAfterInteraction: boolean
}

const FLAG_KEYS: readonly (keyof Flags)[] = ['touched', 'interacted', 'blurredAfterInteraction']

const rowsNow = (ctx: Ctx): unknown[] => listAt(plain(ctx.form.fields(ctx.target)?.value))

const rowAt = (ctx: Ctx, i: number): Record<string, unknown> => {
  const row = rowsNow(ctx)[i]
  return isRecord(row) ? row : {}
}

/** The removals, each replayed under `undo` and `redo` below. */
const removals: readonly Op[] = [
  {
    name: 'setValue shrink',
    target: 'entries',
    victim: ['entries', 2],
    run: (ctx) => ctx.form.setValue(ctx.target, rowsNow(ctx).slice(0, 1)),
    origins: [0],
    rewritesRows: true,
  },
  {
    name: 'setValue empty',
    target: 'entries',
    victim: ['entries', 2],
    run: (ctx) => ctx.form.setValue(ctx.target, []),
    origins: [],
  },
  {
    name: 'clear',
    target: 'entries',
    victim: ['entries', 2],
    run: (ctx) => ctx.form.clear(ctx.target),
    origins: [],
  },
  {
    name: 'remove first',
    target: 'entries',
    victim: ['entries', 0],
    run: (ctx) => ctx.form.remove(dotted(ctx.target), 0),
    origins: [1, 2],
  },
  {
    name: 'remove last',
    target: 'entries',
    victim: ['entries', 2],
    run: (ctx) => ctx.form.remove(dotted(ctx.target), 2),
    origins: [0, 1],
  },
  {
    // Drops the victim row's baseline `memo`, whose record goes with it.
    name: 'setValue key drop',
    target: 'entries',
    victim: ['entries', 2],
    run: (ctx) => ctx.form.setValue(ctx.row(2), { amount: rowAt(ctx, 2)['amount'] }),
    origins: [0, 1, 2],
  },
]

const fresh = () => ({ amount: 'dd' })

const ops: readonly Op[] = [
  ...removals,
  {
    name: 'setValue grow',
    target: 'entries',
    victim: ['entries', 2],
    run: (ctx) => ctx.form.setValue(ctx.target, [...rowsNow(ctx), fresh()]),
    origins: [0, 1, 2, 'fresh'],
    rewritesRows: true,
  },
  {
    name: 'setValue key add',
    target: 'entries',
    victim: ['entries', 2],
    run: (ctx) => ctx.form.setValue(ctx.row(1), { ...rowAt(ctx, 1), memo: 'mb' }),
    origins: [0, 1, 2],
  },
  {
    name: 'setValue leaf change',
    target: 'entries',
    victim: ['entries', 2],
    run: (ctx) => ctx.form.setValue([...ctx.row(0), 'amount'], 'zz'),
    origins: [0, 1, 2],
  },
  {
    name: 'append',
    target: 'entries',
    victim: ['entries', 2],
    run: (ctx) => ctx.form.append(dotted(ctx.target), fresh()),
    origins: [0, 1, 2, 'fresh'],
  },
  {
    name: 'prepend',
    target: 'entries',
    victim: ['entries', 2],
    run: (ctx) => ctx.form.prepend(dotted(ctx.target), fresh()),
    origins: ['fresh', 0, 1, 2],
  },
  {
    name: 'insert',
    target: 'entries',
    victim: ['entries', 2],
    run: (ctx) => ctx.form.insert(dotted(ctx.target), 1, fresh()),
    origins: [0, 'fresh', 1, 2],
  },
  {
    name: 'swap',
    target: 'entries',
    victim: ['entries', 2],
    run: (ctx) => ctx.form.swap(dotted(ctx.target), 0, 2),
    origins: [2, 1, 0],
  },
  {
    name: 'move',
    target: 'entries',
    victim: ['entries', 2],
    run: (ctx) => ctx.form.move(dotted(ctx.target), 0, 2),
    origins: [1, 2, 0],
  },
  {
    // The replaced row is the victim, so its record is dropped.
    name: 'replace',
    target: 'entries',
    victim: ['entries', 2],
    run: (ctx) => ctx.form.replace(dotted(ctx.target), 2, { amount: 'zz' }),
    origins: [0, 1, 'fresh'],
  },
  {
    name: 'reset',
    target: 'entries',
    victim: ['entries', 2],
    prep: (ctx) => ctx.form.setValue([...ctx.row(0), 'amount'], 'zz'),
    run: (ctx) => ctx.form.reset(),
    origins: [0, 1, 2],
    clearsFlags: true,
    inFlight: false,
  },
  {
    name: 'resetField',
    target: 'entries',
    victim: ['entries', 2],
    prep: (ctx) => ctx.form.setValue([...ctx.row(0), 'amount'], 'zz'),
    run: (ctx) => ctx.form.resetField(dotted(ctx.target)),
    origins: [0, 1, 2],
    clearsFlags: true,
    rewritesRows: true,
    inFlight: false,
  },
  {
    name: 'v-register text edit',
    target: 'entries',
    victim: ['entries', 2],
    render: (form, { scope }) =>
      withDirectives(h('input', { type: 'text', class: 'edit' }), [
        [vRegister, form.register(dotted([...scope, 'entries', 0, 'amount']))],
      ]),
    run: (ctx) => {
      const input = ctx.root.querySelector<HTMLInputElement>('input.edit')
      if (input === null) throw new Error('v-register text edit: no input rendered')
      input.value = 'zz'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    },
    origins: [0, 1, 2],
    ownFlags: { 0: { interacted: true } },
  },
  // A history replay restores the recorded error map rather than validating
  // the restored value, so whether a restored row's check is in flight is the
  // history contract, not this one: the in-flight row skips them.
  ...removals.flatMap((removal): Op[] => [
    {
      name: `undo ${removal.name}`,
      target: 'entries',
      victim: removal.victim,
      history: true,
      prep: (ctx) => removal.run(ctx),
      run: (ctx) => ctx.form.history.undo(),
      inFlight: false,
    },
    {
      name: `redo ${removal.name}`,
      target: 'entries',
      victim: removal.victim,
      history: true,
      prep: (ctx) => {
        removal.run(ctx)
        ctx.form.history.undo()
      },
      run: (ctx) => ctx.form.history.redo(),
      inFlight: false,
    },
  ]),
  {
    // Drops the victim `pay.amount`, whose record goes with it.
    name: 'discriminated-union switch',
    target: 'pay',
    victim: ['pay', 'amount'],
    run: (ctx) => ctx.form.setValue([...ctx.target, 'kind'], 'card'),
    // `pay` carries no async check, and the switch writes nothing in `entries`.
    inFlight: false,
  },
]

type Observation = 'unobserved' | 'sync-observed'

const OBSERVATIONS: readonly Observation[] = ['unobserved', 'sync-observed']

const apps: App[] = []

beforeEach(() => {
  holdChecks()
})

afterEach(() => {
  release()
  while (apps.length > 0) apps.pop()?.unmount()
  document.body.innerHTML = ''
})

/** Read every aggregate the row asserts, so each computed is cached. */
function readAggregates(ctx: Ctx): void {
  const { form } = ctx
  const reads: unknown[] = [form.meta.dirty, form.meta.touched, form.meta.blank]
  reads.push(form.meta.validating, form.meta.errors.length)
  for (const path of chainTo(ctx.target)) {
    const state = form.fields(path)
    reads.push(state?.dirty, state?.touched, state?.blank, state?.validating, state?.errors)
  }
  for (let i = 0; i < 3; i++) reads.push(form.fields(ctx.row(i))?.dirty)
}

/** Install `flush: 'sync'` watchers on the form's aggregates. */
function observe(ctx: Ctx): void {
  const { form, target } = ctx
  const noop = () => {}
  const sync: WatchOptions = { flush: 'sync' }
  watch(() => form.meta.dirty, noop, sync)
  watch(() => form.meta.touched, noop, sync)
  watch(() => form.meta.blank, noop, sync)
  watch(() => form.meta.validating, noop, sync)
  watch(() => form.meta.errors.length, noop, sync)
  watch(() => form.fields(target)?.dirty, noop, sync)
  watch(() => form.fields(target)?.touched, noop, sync)
}

/**
 * Wait until no validation is in flight. A macrotask first, so a pass queued
 * as a microtask (the construction-time async pass, a write's own run) has
 * started before `validating` is polled.
 */
async function settled(form: Probe): Promise<void> {
  await wait(0)
  await waitUntil(() => (form.meta.validating ? null : true))
}

/**
 * Like `settled`, but gives up quietly after `ms`, so a `validating` that
 * never clears fails the soft assertion that follows rather than the wait.
 */
async function settledWithin(form: Probe, ms: number): Promise<void> {
  await wait(0)
  const deadline = Date.now() + ms
  while (form.meta.validating && Date.now() < deadline) await wait(5)
}

/** Let the write's own validation, which nothing holds, commit. */
async function letUnheldWorkSettle(): Promise<void> {
  await nextTick()
  await wait(5)
  await nextTick()
}

function mountFor(adapter: Adapter, op: Op, scope: Path): Ctx {
  const mount = makeMounter(
    adapter.useFormFn,
    adapter.schema,
    {
      defaultValues: defaultValues(),
      ...(op.history === true ? { history: historyPlugin() } : {}),
    },
    op.render === undefined ? undefined : (form: Probe) => op.render?.(form, { scope }) ?? h('div')
  )
  const { api, app, root } = mount()
  apps.push(app)
  const form: Probe = api
  const target: Path = [...scope, op.target]
  const ctx: Ctx = { form, root, scope, target, row: (i) => [...scope, 'entries', i] }
  return ctx
}

describe.each(adapters)('$name: container aggregates after a write', (adapter) => {
  describe.each(depths)('$name', ({ scope }) => {
    for (const op of ops) {
      for (const observation of OBSERVATIONS) {
        it(`${op.target}: ${op.name} (${observation})`, async () => {
          const ctx = mountFor(adapter, op, scope)
          const { form, target } = ctx
          await settled(form)
          await form.interact([...scope, ...op.victim])
          op.prep?.(ctx)
          await settled(form)
          readAggregates(ctx)
          if (observation === 'sync-observed') observe(ctx)

          op.run(ctx)
          await nextTick()

          const after = plain(form.fields([])?.value)
          const base = baseline()
          const chain = chainTo(target)

          // dirty: the value against its baseline, row by row through origins.
          expect.soft(form.meta.dirty, 'dirty: meta === fields([])').toBe(form.fields([])?.dirty)
          for (const path of chain) {
            const truth = !sameValue(valueAt(after, path), valueAt(base, path))
            expect.soft(form.fields(path)?.dirty, `dirty ${dotted(path) || '(root)'}`).toBe(truth)
          }
          const baseRows = listAt(valueAt(base, [...scope, 'entries']))
          const rows = listAt(valueAt(after, [...scope, 'entries']))
          if (op.target === 'entries' && op.origins !== undefined) {
            op.origins.forEach((origin, j) => {
              const row = rows[j]
              const baseRow = origin === 'fresh' ? undefined : baseRows[origin]
              expect
                .soft(form.fields(ctx.row(j))?.dirty, `dirty row ${j} (from ${origin})`)
                .toBe(!sameValue(row, baseRow))
              for (const leaf of ['amount', 'memo']) {
                if (leaf === 'memo' && origin === 1 && op.rewritesRows === true) continue
                const truth = !Object.is(valueAt(row, [leaf]), valueAt(baseRow, [leaf]))
                expect
                  .soft(form.fields([...ctx.row(j), leaf])?.dirty, `dirty row ${j}.${leaf}`)
                  .toBe(truth)
              }
            })
          }

          // Interaction history, per D6.
          const victimRow = op.victim[0] === 'entries' ? op.victim[1] : undefined
          for (const path of chain) {
            const state = form.fields(path)
            for (const flag of FLAG_KEYS) {
              expect
                .soft(state?.[flag], `${flag} ${dotted(path) || '(root)'}`)
                .toBe(op.clearsFlags !== true)
            }
          }
          if (op.target === 'entries' && op.origins !== undefined) {
            op.origins.forEach((origin, j) => {
              const state = form.fields(ctx.row(j))
              for (const flag of FLAG_KEYS) {
                const truth =
                  op.clearsFlags !== true &&
                  (origin === victimRow || op.ownFlags?.[j]?.[flag] === true)
                expect.soft(state?.[flag], `${flag} row ${j} (from ${origin})`).toBe(truth)
              }
            })
          }

          // blank: every present leaf under the path is blank. Only `memo` of
          // the row that came from index 1 is, while it stays unwritten.
          for (const path of chain) {
            const value = valueAt(after, path)
            const truth = Array.isArray(value) && value.length === 0
            expect.soft(form.fields(path)?.blank, `blank ${dotted(path) || '(root)'}`).toBe(truth)
          }
          if (op.target === 'entries' && op.origins !== undefined) {
            op.origins.forEach((origin, j) => {
              expect.soft(form.fields(ctx.row(j))?.blank, `blank row ${j}`).toBe(false)
              if (origin === 'fresh' || (origin === 1 && op.rewritesRows === true)) return
              const truth = origin === 1 && valueAt(rows[j], ['memo']) === undefined
              expect
                .soft(form.fields([...ctx.row(j), 'memo'])?.blank, `blank row ${j}.memo`)
                .toBe(truth)
            })
          }

          // errors, once the write's own validation commits.
          if (op.history === true) return
          await settled(form)
          await nextTick()
          const settledValue = plain(form.fields([])?.value)
          const verdict = await adapter.verdict(settledValue)
          expect.soft(errorKeys(form.meta.errors), 'errors: meta').toStrictEqual(verdict)
          const containers = [...chain]
          if (op.target === 'entries') {
            listAt(valueAt(settledValue, [...scope, 'entries'])).forEach((_, j) => {
              containers.push(ctx.row(j))
            })
          }
          for (const path of containers) {
            const expected = verdict.filter((key) => {
              const at = key.slice(0, key.lastIndexOf(':zod:'))
              return path.length === 0 || at === dotted(path) || at.startsWith(`${dotted(path)}.`)
            })
            expect
              .soft(errorKeys(form.fields(path)?.errors), `errors ${dotted(path) || '(root)'}`)
              .toStrictEqual(expected)
          }
          // An error the write itself caused at the container reveals, since
          // the container's history says it was edited and left.
          const ownError = verdict.some((key) => key.startsWith(`${dotted(target)}:zod:`))
          if (ownError && op.clearsFlags !== true) {
            expect
              .soft(form.fields(target)?.displayState, `displayState ${dotted(target)}`)
              .toBe('error')
          }
        })

        if (op.inFlight === false || op.target !== 'entries') continue

        it(`${op.target}: ${op.name}, a row's check in flight (${observation})`, async () => {
          const ctx = mountFor(adapter, op, scope)
          const { form, target } = ctx
          await settled(form)
          const victimIndex = op.victim[1]
          if (typeof victimIndex !== 'number') throw new Error('in-flight row needs a row victim')
          form.setValue([...ctx.row(victimIndex), 'amount'], SLOW)
          await letUnheldWorkSettle()
          expect(form.fields([...ctx.row(victimIndex), 'amount'])?.validating).toBe(true)
          op.prep?.(ctx)
          await letUnheldWorkSettle()
          readAggregates(ctx)
          if (observation === 'sync-observed') observe(ctx)

          op.run(ctx)
          await letUnheldWorkSettle()

          const origins = op.origins
          if (origins === undefined) throw new Error('in-flight row needs row origins')
          const at = origins.indexOf(victimIndex)
          const chain = chainTo(target)
          if (at >= 0) {
            // The held row survives, so its run still counts, at its new
            // index and up the chain. A row the write itself validated may
            // read its own run too, held by a whole-form scope, so only the
            // held row is pinned.
            expect
              .soft(form.fields([...ctx.row(at), 'amount'])?.validating, `validating row ${at}`)
              .toBe(true)
            for (const path of chain) {
              expect
                .soft(form.fields(path)?.validating, `validating ${dotted(path) || '(root)'}`)
                .toBe(true)
            }
            expect.soft(form.meta.validating, 'validating meta').toBe(true)
          } else {
            // The held row is gone, and nothing present waits on it.
            origins.forEach((_, j) => {
              expect
                .soft(form.fields([...ctx.row(j), 'amount'])?.validating, `validating row ${j}`)
                .toBe(false)
            })
            for (const path of chain) {
              expect
                .soft(form.fields(path)?.validating, `validating ${dotted(path) || '(root)'}`)
                .toBe(false)
            }
            expect.soft(form.meta.validating, 'validating meta').toBe(false)
          }

          // Once the held run settles, nothing reads in flight, wherever the
          // row moved to.
          release()
          await settledWithin(form, 300)
          expect.soft(form.meta.validating, 'released meta').toBe(false)
          for (const path of chain) {
            expect
              .soft(form.fields(path)?.validating, `released ${dotted(path) || '(root)'}`)
              .toBe(false)
          }
          if (at >= 0) {
            expect
              .soft(form.fields([...ctx.row(at), 'amount'])?.validating, `released row ${at}`)
              .toBe(false)
          }
        })
      }
    }
  })
})
