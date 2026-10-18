// @vitest-environment jsdom
/**
 * Every write that changes a value is recorded in `updatedAt`, the writes
 * that remove structure included (#705).
 *
 * The contract (decision D5 of the #705 plan):
 *
 * - A write that changes a value stamps each path it patched and every
 *   ancestor up to the root, with one `now` per write.
 * - A container reads its own recorded stamp. Removing descendants never
 *   lowers it, so `form.meta.updatedAt` never decreases.
 * - A written path never reads `null` afterwards, even when it now holds
 *   `[]` or `undefined`. Only a removed index may.
 * - After an index shift (`remove`, `insert`, `prepend`, `move`, `swap`),
 *   every surviving element keeps its own stamp at its new index.
 * - #20 stays: a write that changes nothing stamps nothing.
 *
 * The matrix runs every write kind over an array of object rows (`entries`),
 * an optional array of primitives (`tags`, a checkbox group's shape) and a
 * discriminated union (`pay`), at two depths (top level, and under
 * `members[0].income`), on both adapters, two ways:
 *
 * - **target newest**: the subtree under test holds the form's newest stamp,
 *   written last through a value-neutral round trip. A removal that loses the
 *   newest stamp used to move `meta.updatedAt` backwards.
 * - **other newest**: another field (`note`) was written since, the usual case
 *   in a real form. A removal used to leave `meta.updatedAt` unchanged, so a
 *   `watch(() => form.meta.updatedAt)` autosave never heard it.
 *
 * Each row asserts, with soft expectations so one run reports every broken
 * guarantee of the row:
 *
 * - `value`: the write did what the row says (guards the row itself);
 * - `fired`: a `flush: 'sync'` watcher on `meta.updatedAt` fires exactly once;
 * - `root` and `ancestor`: the root and every ancestor of each written path
 *   read this write's stamp, which is strictly newer than before;
 * - `written`: each written path reads this write's stamp (non-null);
 * - `survivor` and `fresh`: survivors keep their own stamps at their new
 *   indices, and a freshly created element reads this write's stamp;
 * - `unchanged` and `bystander`: paths the write did not change keep their
 *   stamps (#20);
 * - `no-change`: repeating the write with the value already in place stamps
 *   nothing and fires nothing (#20).
 *
 * The clock is `Date` alone, faked, so every stamp is exact and a write's
 * stamp is the faked `now`. Timers stay real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h, nextTick, watch, withDirectives, type App, type VNode } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { historyPlugin } from '../../src/history'
import { vRegister } from '../../src/runtime/core/directive'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { makeMounter } from '../utils/form-harness'

// The v3 and v4 `useForm` overload sets do not unify into one callable
// signature, so an adapter-agnostic caller types the function the way
// `makeMounter` does.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUseForm = (options: any) => any

type Segment = string | number
type Path = readonly Segment[]

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
  readonly history: { readonly undo: () => boolean; readonly redo: () => boolean }
  readonly meta: { readonly updatedAt: string | null }
  readonly fields: (
    path: Path
  ) => { readonly updatedAt: string | null; readonly value: unknown } | undefined
  readonly register: (path: string) => unknown
}

function buildSchemaV4() {
  const entry = zV4.object({ amount: zV4.string(), memo: zV4.string().optional() })
  const pay = zV4.discriminatedUnion('kind', [
    zV4.object({ kind: zV4.literal('cash'), amount: zV4.string() }),
    zV4.object({ kind: zV4.literal('card'), last4: zV4.string() }),
  ])
  const scope = { entries: zV4.array(entry), tags: zV4.array(zV4.string()).optional(), pay }
  return zV4.object({
    note: zV4.string(),
    ...scope,
    members: zV4.array(zV4.object({ name: zV4.string(), income: zV4.object(scope) })),
  })
}

function buildSchemaV3() {
  const entry = zV3.object({ amount: zV3.string(), memo: zV3.string().optional() })
  const pay = zV3.discriminatedUnion('kind', [
    zV3.object({ kind: zV3.literal('cash'), amount: zV3.string() }),
    zV3.object({ kind: zV3.literal('card'), last4: zV3.string() }),
  ])
  const scope = { entries: zV3.array(entry), tags: zV3.array(zV3.string()).optional(), pay }
  return zV3.object({
    note: zV3.string(),
    ...scope,
    members: zV3.array(zV3.object({ name: zV3.string(), income: zV3.object(scope) })),
  })
}

const adapters: readonly { name: string; useFormFn: AnyUseForm; schema: unknown }[] = [
  { name: 'zod v4', useFormFn: useFormV4, schema: buildSchemaV4() },
  { name: 'zod v3', useFormFn: useFormV3, schema: buildSchemaV3() },
]

const scopeDefaults = () => ({
  entries: [{ amount: 'a', memo: 'ma' }, { amount: 'b' }, { amount: 'c', memo: 'mc' }],
  tags: ['x', 'y', 'z'],
  pay: { kind: 'cash', amount: '10' },
})

const defaultValues = () => ({
  note: 'n',
  ...scopeDefaults(),
  members: [
    { name: 'm0', income: scopeDefaults() },
    { name: 'm1', income: scopeDefaults() },
  ],
})

const depths: readonly { name: string; scope: Path }[] = [
  { name: 'top level', scope: [] },
  { name: 'members[0].income', scope: ['members', 0, 'income'] },
]

// --- Plain-value helpers ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A deep plain copy, free of Vue proxies, safe to hand back to `setValue`. */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain)
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = plain(v)
    return out
  }
  return value
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

/** `prefix` is `path` itself or one of its ancestors. */
function isPrefix(prefix: Path, path: Path): boolean {
  return prefix.length <= path.length && prefix.every((s, i) => s === path[i])
}

/** Every strict ancestor of `path`, the root `[]` first. */
function ancestorsOf(path: Path): Path[] {
  const out: Path[] = []
  for (let i = 0; i < path.length; i++) out.push(path.slice(0, i))
  return out
}

// --- The clock ---

const EPOCH = Date.parse('2026-01-01T00:00:00.000Z')
let clock = EPOCH

/** Move the faked clock one second forward and return the new ISO stamp. */
function advance(): string {
  clock += 1000
  vi.setSystemTime(clock)
  return new Date(clock).toISOString()
}

// --- The rows ---

type TargetName = 'entries' | 'tags' | 'pay'

type Ctx = {
  readonly form: Probe
  readonly root: HTMLElement
  /** The scope the target sits in: `[]` or `['members', 0, 'income']`. */
  readonly scope: Path
  /** Absolute path of the subtree under test. */
  readonly target: Path
  /** The element at `i` of the target array. */
  readonly item: (i: number) => Path
  /** The leaf the matrix stamps and edits inside element `i`. */
  readonly leaf: (i: number) => Path
}

type Op = {
  readonly name: string
  readonly target: TargetName
  /** The measured write. */
  readonly run: (ctx: Ctx) => void
  /** The value the target holds afterwards, from the value it held before. */
  readonly expected: (before: unknown) => unknown
  /** Every path the write changes, which must read the write's stamp. */
  readonly written: (ctx: Ctx) => readonly Path[]
  /** `[newIndex, oldIndex]` for every element that survives the write. */
  readonly survivors?: readonly (readonly [number, number])[]
  /** Indices of elements the write creates. */
  readonly fresh?: readonly number[]
  /** Paths under the target the write leaves unchanged. */
  readonly unchanged?: (ctx: Ctx) => readonly Path[]
  /** The leaf a target-newest row round-trips last, or none. */
  readonly hot?: (ctx: Ctx) => Path
  /** Writes that set the row up, after the per-element stamps. */
  readonly prep?: (ctx: Ctx) => void
  /**
   * A whole-form `reset()` writes back every path it restores, `note`
   * included, so no path outside the target counts as a bystander.
   */
  readonly pinsBystanders?: false
  /** The row needs `historyPlugin()`. */
  readonly history?: true
  /** The modes the row runs in, both unless restricted. */
  readonly modes?: readonly Mode[]
  readonly render?: (form: Probe, ctx: { scope: Path }) => VNode
}

type Mode = 'target newest' | 'other newest'

const BOTH_MODES: readonly Mode[] = ['target newest', 'other newest']

/** A path with the stamp it read before the measured write. */
type Stamped = readonly [Path, string | null | undefined]

type ItemKind = {
  readonly target: 'entries' | 'tags'
  readonly fresh: () => unknown
  readonly changed: () => unknown
  readonly leaf: (target: Path, i: number) => Path
  /** The target's value once `clear()` has run. */
  readonly cleared: unknown
  /** Replace the leaf value of element `i` in a plain copy of the array. */
  readonly withLeaf: (list: unknown[], i: number, value: string) => unknown[]
}

const rowsKind: ItemKind = {
  target: 'entries',
  fresh: () => ({ amount: 'd' }),
  changed: () => ({ amount: 'q' }),
  leaf: (target, i) => [...target, i, 'amount'],
  cleared: [],
  withLeaf: (list, i, value) =>
    list.map((row, j) => (j === i && isRecord(row) ? { ...row, amount: value } : row)),
}

const itemsKind: ItemKind = {
  target: 'tags',
  fresh: () => 'w',
  changed: () => 'q',
  leaf: (target, i) => [...target, i],
  cleared: undefined,
  withLeaf: (list, i, value) => list.map((item, j) => (j === i ? value : item)),
}

const current = (ctx: Ctx): unknown[] => listAt(plain(ctx.form.fields(ctx.target)?.value))

/** The removals, each replayed under `undo` and `redo` below. */
function removalOps(kind: ItemKind): Op[] {
  const t = kind.target
  const ops: Op[] = [
    {
      name: 'setValue shrink',
      target: t,
      run: (ctx) => ctx.form.setValue(ctx.target, current(ctx).slice(0, 1)),
      expected: (before) => listAt(before).slice(0, 1),
      written: (ctx) => [ctx.target],
      survivors: [[0, 0]],
      hot: (ctx) => ctx.leaf(2),
    },
    {
      name: 'setValue empty',
      target: t,
      run: (ctx) => ctx.form.setValue(ctx.target, []),
      expected: () => [],
      written: (ctx) => [ctx.target],
      hot: (ctx) => ctx.leaf(2),
    },
    {
      name: 'clear',
      target: t,
      run: (ctx) => ctx.form.clear(ctx.target),
      expected: () => kind.cleared,
      written: (ctx) => [ctx.target],
      hot: (ctx) => ctx.leaf(2),
    },
    {
      name: 'remove first',
      target: t,
      run: (ctx) => ctx.form.remove(dotted(ctx.target), 0),
      expected: (before) => listAt(before).slice(1),
      written: (ctx) => [ctx.target],
      survivors: [
        [0, 1],
        [1, 2],
      ],
      hot: (ctx) => ctx.leaf(0),
    },
    {
      name: 'remove last',
      target: t,
      run: (ctx) => ctx.form.remove(dotted(ctx.target), 2),
      expected: (before) => listAt(before).slice(0, 2),
      written: (ctx) => [ctx.target],
      survivors: [
        [0, 0],
        [1, 1],
      ],
      hot: (ctx) => ctx.leaf(2),
    },
  ]
  if (kind.target === 'entries') {
    ops.push({
      name: 'setValue key drop',
      target: t,
      run: (ctx) => ctx.form.setValue(ctx.item(0), { amount: 'a' }),
      expected: (before) => listAt(before).map((row, j) => (j === 0 ? { amount: 'a' } : row)),
      written: (ctx) => [ctx.item(0)],
      survivors: [
        [1, 1],
        [2, 2],
      ],
      unchanged: (ctx) => [ctx.leaf(0)],
      hot: (ctx) => [...ctx.item(0), 'memo'],
    })
  }
  return ops
}

function arrayOps(kind: ItemKind): Op[] {
  const t = kind.target
  const ops: Op[] = [
    ...removalOps(kind),
    {
      name: 'setValue grow',
      target: t,
      run: (ctx) => ctx.form.setValue(ctx.target, [...current(ctx), kind.fresh()]),
      expected: (before) => [...listAt(before), kind.fresh()],
      written: (ctx) => [ctx.target],
      survivors: [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
      fresh: [3],
      hot: (ctx) => ctx.leaf(2),
    },
    {
      name: 'setValue leaf change',
      target: t,
      run: (ctx) => ctx.form.setValue(ctx.leaf(1), 'q'),
      expected: (before) => kind.withLeaf(listAt(before), 1, 'q'),
      written: (ctx) => [ctx.leaf(1)],
      survivors: [
        [0, 0],
        [2, 2],
      ],
      hot: (ctx) => ctx.leaf(1),
    },
    {
      name: 'append',
      target: t,
      run: (ctx) => ctx.form.append(dotted(ctx.target), kind.fresh()),
      expected: (before) => [...listAt(before), kind.fresh()],
      written: (ctx) => [ctx.target],
      survivors: [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
      fresh: [3],
      hot: (ctx) => ctx.leaf(2),
    },
    {
      name: 'prepend',
      target: t,
      run: (ctx) => ctx.form.prepend(dotted(ctx.target), kind.fresh()),
      expected: (before) => [kind.fresh(), ...listAt(before)],
      written: (ctx) => [ctx.target],
      survivors: [
        [1, 0],
        [2, 1],
        [3, 2],
      ],
      fresh: [0],
      hot: (ctx) => ctx.leaf(2),
    },
    {
      name: 'insert',
      target: t,
      run: (ctx) => ctx.form.insert(dotted(ctx.target), 1, kind.fresh()),
      expected: (before) => {
        const list = listAt(before)
        return [list[0], kind.fresh(), ...list.slice(1)]
      },
      written: (ctx) => [ctx.target],
      survivors: [
        [0, 0],
        [2, 1],
        [3, 2],
      ],
      fresh: [1],
      hot: (ctx) => ctx.leaf(2),
    },
    {
      name: 'swap',
      target: t,
      run: (ctx) => ctx.form.swap(dotted(ctx.target), 0, 2),
      expected: (before) => {
        const list = listAt(before)
        return [list[2], list[1], list[0]]
      },
      written: (ctx) => [ctx.target],
      survivors: [
        [0, 2],
        [1, 1],
        [2, 0],
      ],
      hot: (ctx) => ctx.leaf(0),
    },
    {
      name: 'move',
      target: t,
      run: (ctx) => ctx.form.move(dotted(ctx.target), 0, 2),
      expected: (before) => {
        const list = listAt(before)
        return [list[1], list[2], list[0]]
      },
      written: (ctx) => [ctx.target],
      survivors: [
        [0, 1],
        [1, 2],
        [2, 0],
      ],
      hot: (ctx) => ctx.leaf(0),
    },
    {
      name: 'replace',
      target: t,
      run: (ctx) => ctx.form.replace(dotted(ctx.target), 1, kind.changed()),
      expected: (before) => listAt(before).map((item, j) => (j === 1 ? kind.changed() : item)),
      written: (ctx) => [ctx.target],
      survivors: [
        [0, 0],
        [2, 2],
      ],
      fresh: [1],
      hot: (ctx) => ctx.leaf(1),
    },
    {
      name: 'reset',
      target: t,
      prep: (ctx) => {
        advance()
        ctx.form.setValue(ctx.leaf(1), 'q')
      },
      run: (ctx) => ctx.form.reset(),
      expected: () => valueAt(scopeDefaults(), [t]),
      written: (ctx) => [ctx.leaf(1)],
      pinsBystanders: false,
      hot: (ctx) => ctx.leaf(2),
    },
    {
      name: 'resetField',
      target: t,
      prep: (ctx) => {
        advance()
        ctx.form.setValue(ctx.leaf(1), 'q')
      },
      run: (ctx) => ctx.form.resetField(dotted(ctx.target)),
      expected: () => valueAt(scopeDefaults(), [t]),
      written: (ctx) => [ctx.target, ctx.leaf(1)],
      hot: (ctx) => ctx.leaf(2),
    },
  ]
  if (kind.target === 'entries') {
    ops.push(
      {
        name: 'setValue key add',
        target: t,
        run: (ctx) => ctx.form.setValue(ctx.item(1), { amount: 'b', memo: 'mb' }),
        expected: (before) =>
          listAt(before).map((row, j) => (j === 1 ? { amount: 'b', memo: 'mb' } : row)),
        written: (ctx) => [ctx.item(1), [...ctx.item(1), 'memo']],
        survivors: [
          [0, 0],
          [2, 2],
        ],
        unchanged: (ctx) => [ctx.leaf(1)],
        hot: (ctx) => ctx.leaf(1),
      },
      {
        name: 'v-register text edit',
        target: t,
        render: (form, { scope }) =>
          withDirectives(h('input', { type: 'text', class: 'edit' }), [
            [vRegister, form.register(dotted([...scope, 'entries', 1, 'amount']))],
          ]),
        run: (ctx) => {
          const input = ctx.root.querySelector<HTMLInputElement>('input.edit')
          if (input === null) throw new Error('v-register text edit: no input rendered')
          input.value = 'typed'
          input.dispatchEvent(new Event('input', { bubbles: true }))
        },
        expected: (before) => kind.withLeaf(listAt(before), 1, 'typed'),
        written: (ctx) => [ctx.leaf(1)],
        survivors: [
          [0, 0],
          [2, 2],
        ],
        hot: (ctx) => ctx.leaf(1),
      }
    )
  } else {
    ops.push({
      // Unticking a box in a checkbox group is a whole-array write, so the
      // surviving 'z' moves by position, not by identity, and only index 0
      // survives in place.
      name: 'v-register checkbox untick',
      target: t,
      render: (form, { scope }) =>
        h(
          'div',
          ['x', 'y', 'z'].map((value) =>
            withDirectives(h('input', { type: 'checkbox', value, class: `box-${value}` }), [
              [vRegister, form.register(dotted([...scope, 'tags']))],
            ])
          )
        ),
      run: (ctx) => {
        const box = ctx.root.querySelector<HTMLInputElement>('input.box-y')
        if (box === null) throw new Error('v-register checkbox untick: no box rendered')
        box.checked = false
        box.dispatchEvent(new Event('change', { bubbles: true }))
      },
      expected: (before) => listAt(before).filter((item) => item !== 'y'),
      written: (ctx) => [ctx.target],
      survivors: [[0, 0]],
      hot: (ctx) => ctx.leaf(2),
    })
  }
  // Undo and redo of every removal. A history replay is a whole-value
  // write with no element identity, so survivors are not pinned.
  for (const removal of removalOps(kind)) {
    ops.push({
      name: `undo ${removal.name}`,
      target: t,
      history: true,
      prep: (ctx) => {
        advance()
        removal.run(ctx)
      },
      run: (ctx) => ctx.form.history.undo(),
      expected: () => valueAt(scopeDefaults(), [t]),
      written: removal.written,
    })
    ops.push({
      name: `redo ${removal.name}`,
      target: t,
      history: true,
      prep: (ctx) => {
        advance()
        removal.run(ctx)
        advance()
        ctx.form.history.undo()
      },
      run: (ctx) => ctx.form.history.redo(),
      expected: () => removal.expected(valueAt(scopeDefaults(), [t])),
      written: removal.written,
      // A redo replays the most recently undone write, and any other write in
      // between would discard the redo branch, so no other field can have
      // been written since.
      modes: ['target newest'],
    })
  }
  return ops
}

const unionOp: Op = {
  name: 'discriminated-union switch',
  target: 'pay',
  run: (ctx) => ctx.form.setValue([...ctx.target, 'kind'], 'card'),
  expected: () => ({ kind: 'card', last4: '' }),
  written: (ctx) => [ctx.target, [...ctx.target, 'kind'], [...ctx.target, 'last4']],
  hot: (ctx) => [...ctx.target, 'amount'],
}

const ops: readonly Op[] = [...arrayOps(rowsKind), ...arrayOps(itemsKind), unionOp]

/** Stamp-bearing paths across the whole form, for the #20 bystander pins. */
function probePaths(): Path[] {
  const out: Path[] = [['note'], ['members', 0, 'name'], ['members', 1], ['members', 1, 'name']]
  for (const scope of depths.map((d) => d.scope)) {
    out.push([...scope, 'entries'], [...scope, 'tags'], [...scope, 'pay'])
    for (let i = 0; i < 3; i++) {
      out.push([...scope, 'entries', i], [...scope, 'entries', i, 'amount'], [...scope, 'tags', i])
    }
    out.push([...scope, 'pay', 'kind'], [...scope, 'pay', 'amount'])
  }
  return out
}

/** Round-trip a leaf back to its own value: stamped, value unchanged. */
function roundTrip(form: Probe, leaf: Path): void {
  const original = plain(form.fields(leaf)?.value)
  form.setValue(leaf, `${String(original)}~`)
  form.setValue(leaf, original)
}

const apps: App[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  clock = EPOCH
  vi.setSystemTime(clock)
})

afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe.each(adapters)('$name: every write is recorded in updatedAt', ({ useFormFn, schema }) => {
  describe.each(depths)('$name', ({ scope }) => {
    for (const op of ops) {
      for (const mode of op.modes ?? BOTH_MODES) {
        it(`${op.target}: ${op.name} (${mode})`, async () => {
          const target: Path = [...scope, op.target]
          const kind = op.target === 'tags' ? itemsKind : rowsKind
          const mount = makeMounter(
            useFormFn,
            schema,
            {
              defaultValues: defaultValues(),
              ...(op.history === true ? { history: historyPlugin() } : {}),
            },
            op.render === undefined
              ? undefined
              : (form: Probe) => op.render?.(form, { scope }) ?? h('div')
          )
          const { api, app, root } = mount()
          apps.push(app)
          const form: Probe = api
          const ctx: Ctx = {
            form,
            root,
            scope,
            target,
            item: (i) => [...target, i],
            leaf: (i) => kind.leaf(target, i),
          }
          await nextTick()

          // Give every element of an array target its own distinct stamp, so
          // a survivor's stamp is identifiable after an index shift.
          if (op.target !== 'pay') {
            for (let i = 0; i < 3; i++) {
              advance()
              roundTrip(form, ctx.leaf(i))
            }
          }
          op.prep?.(ctx)
          if (mode === 'target newest') {
            const hot = op.hot?.(ctx)
            if (hot !== undefined) {
              advance()
              roundTrip(form, hot)
            }
          } else if (op.history === true) {
            // The measured undo has to revert the removal, so the other field's
            // write is undone first. That undo is itself a write to `note`,
            // newer than the removal, and leaves the removal next in line.
            advance()
            form.setValue(['note'], 'written since')
            advance()
            form.history.undo()
          } else {
            advance()
            form.setValue(['note'], 'written since')
          }

          const beforeValue = plain(form.fields(target)?.value)
          const beforeRoot = form.meta.updatedAt
          const itemStamps = [0, 1, 2].map((i) => form.fields(ctx.item(i))?.updatedAt)
          const leafStamps = [0, 1, 2].map((i) => form.fields(ctx.leaf(i))?.updatedAt)
          const stampOf = (path: Path): Stamped => [path, form.fields(path)?.updatedAt]
          const unchanged = (op.unchanged?.(ctx) ?? []).map(stampOf)
          const bystanders = probePaths()
            .filter((path) => !isPrefix(path, target) && !isPrefix(target, path))
            .map(stampOf)

          const now = advance()
          let fired = 0
          watch(
            () => form.meta.updatedAt,
            () => {
              fired += 1
            },
            { flush: 'sync' }
          )
          op.run(ctx)
          await nextTick()

          expect.soft(plain(form.fields(target)?.value), 'value').toEqual(op.expected(beforeValue))
          expect.soft(fired, 'fired').toBe(1)
          expect.soft(beforeRoot !== null && beforeRoot < now, 'root was older').toBe(true)
          expect.soft(form.meta.updatedAt, 'root: meta.updatedAt').toBe(now)
          expect.soft(form.fields([])?.updatedAt, 'root: fields([])').toBe(now)
          const written = op.written(ctx)
          const ancestors = new Map<string, Path>()
          for (const path of written) {
            for (const ancestor of ancestorsOf(path)) ancestors.set(dotted(ancestor), ancestor)
          }
          for (const [label, path] of ancestors) {
            if (path.length === 0) continue
            expect.soft(form.fields(path)?.updatedAt, `ancestor ${label}`).toBe(now)
          }
          for (const path of written) {
            expect.soft(form.fields(path)?.updatedAt, `written ${dotted(path)}`).toBe(now)
          }
          for (const [next, prev] of op.survivors ?? []) {
            expect
              .soft(form.fields(ctx.item(next))?.updatedAt, `survivor ${prev} -> ${next}`)
              .toBe(itemStamps[prev])
            if (op.target === 'entries') {
              expect
                .soft(form.fields(ctx.leaf(next))?.updatedAt, `survivor leaf ${prev} -> ${next}`)
                .toBe(leafStamps[prev])
            }
          }
          for (const index of op.fresh ?? []) {
            expect.soft(form.fields(ctx.item(index))?.updatedAt, `fresh ${index}`).toBe(now)
          }
          for (const [path, stamp] of unchanged) {
            expect.soft(form.fields(path)?.updatedAt, `unchanged ${dotted(path)}`).toBe(stamp)
          }
          if (op.pinsBystanders !== false) {
            for (const [path, stamp] of bystanders) {
              expect.soft(form.fields(path)?.updatedAt, `bystander ${dotted(path)}`).toBe(stamp)
            }
          }

          // #20: the same write again, with the value already in place. Read
          // against the state the write left, so a broken write above does
          // not also fail this pin.
          const [first] = written
          if (first !== undefined) {
            const firedAfter = fired
            const rootAfter = form.meta.updatedAt
            const firstAfter = form.fields(first)?.updatedAt
            advance()
            form.setValue(first, plain(form.fields(first)?.value))
            await nextTick()
            expect.soft(fired, 'no-change: fired').toBe(firedAfter)
            expect.soft(form.meta.updatedAt, 'no-change: root').toBe(rootAfter)
            expect.soft(form.fields(first)?.updatedAt, 'no-change: written').toBe(firstAfter)
          }
        })
      }
    }
  })
})
