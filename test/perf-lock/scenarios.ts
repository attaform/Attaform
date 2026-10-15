/**
 * Workload-matrix fixtures for the behavior-lock harness.
 *
 * Each scenario builds its schema from the adapter's `z` (so the same
 * fixture runs against zod v3 and v4), declares the leaf paths to capture,
 * and drives the form through a fixed checkpoint protocol using only the
 * public programmatic API. The drive script `snap()`s the observable
 * surface at each labeled checkpoint.
 *
 * Slice 1 covers S0 (flat scalars) and S1 (nested objects) via programmatic
 * writes + submit + reset, enough to lock value/dirty/touched, the
 * displayState reveal gate (hidden pre-submit, revealed after), validation
 * structure, and reset restoration. Arrays (S4, key identity) and
 * event-driven focus/blur land in later slices.
 *
 * Constraints honored: schemas use only `.min()` length constraints, which
 * are identical across zod v3/v4 (no `.email()` API drift).
 *
 * `FIRST_READ_SCENARIOS` drive the first-read mode: the runner snaps the
 * surface synchronously right after `app.mount`, before any activation or
 * settling, then settles and snaps again. Together they lock what a form
 * shows on the frame it mounts, construction's error verdict included.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { nextTick } from 'vue'
import { historyPlugin } from '../../src/history'
import { wait } from '../utils/form-harness'
import type { ArraySpec, FormLike } from './capture'

/** The form API surface the drive scripts touch. */
export type DriveForm = FormLike & {
  setValue: (path: string, value: unknown) => boolean
  handleSubmit: (
    onSubmit: (data: unknown) => void,
    onError?: (errors: unknown) => void
  ) => (e: Event) => Promise<void>
  reset: (next?: unknown) => void
  touch: (path?: string) => void
  insert: (path: string, index: number, value: unknown) => void
  remove: (path: string, index: number) => void
  move: (path: string, from: number, to: number) => void
  append: (path: string, value: unknown) => void
  setErrors: (
    errors: ReadonlyArray<{ path: (string | number)[]; message: string; code: string }>
  ) => void
  history?: { undo: () => boolean }
}

export type Scenario = {
  id: string
  title: string
  makeSchema: (z: any) => unknown
  defaultValues: Record<string, unknown>
  fieldPaths: string[]
  arrays?: ArraySpec[]
  drive: (form: DriveForm, snap: (label: string) => void) => Promise<void>
}

/** Cover the 0 ms validation debounce (setTimeout) + reactive flush. */
export async function settle(): Promise<void> {
  await wait(20)
  await nextTick()
  await nextTick()
}

const noop = (): void => {}

export const SCENARIOS: Scenario[] = [
  {
    id: 's0-tiny',
    title: 'tiny: 5 flat scalars, depth 1',
    makeSchema: (z) =>
      z.object({
        a: z.string().min(2),
        b: z.string(),
        c: z.number(),
        d: z.boolean(),
        e: z.string().min(3),
      }),
    defaultValues: { a: '', b: '', c: 0, d: false, e: '' },
    fieldPaths: ['a', 'b', 'c', 'd', 'e'],
    async drive(form, snap) {
      snap('initial')
      form.setValue('a', 'Ada')
      form.setValue('e', 'abcd')
      await settle()
      snap('after-valid-edit')
      form.setValue('e', 'ab')
      await settle()
      snap('after-invalid-edit')
      await form.handleSubmit(noop, noop)(new Event('submit'))
      await settle()
      snap('after-submit')
      form.reset()
      await settle()
      snap('after-reset')
    },
  },
  {
    id: 's1-nested',
    title: 'medium: nested objects, depth 2',
    makeSchema: (z) =>
      z.object({
        profile: z.object({ first: z.string().min(2), last: z.string() }),
        contact: z.object({ email: z.string().min(3), phone: z.string() }),
        agreed: z.boolean(),
      }),
    defaultValues: {
      profile: { first: '', last: '' },
      contact: { email: '', phone: '' },
      agreed: false,
    },
    fieldPaths: ['profile.first', 'profile.last', 'contact.email', 'contact.phone', 'agreed'],
    async drive(form, snap) {
      snap('initial')
      form.setValue('profile.first', 'Grace')
      form.setValue('contact.email', 'x')
      await settle()
      snap('after-edit')
      await form.handleSubmit(noop, noop)(new Event('submit'))
      await settle()
      snap('after-submit')
      form.reset()
      await settle()
      snap('after-reset')
    },
  },
  {
    id: 's4-array',
    title: 'wide-array: list/key identity across mutations (small N; dashboard runs N=1000)',
    makeSchema: (z) =>
      z.object({
        rows: z.array(z.object({ name: z.string().min(2), qty: z.number() })),
      }),
    defaultValues: {
      rows: [
        { name: '', qty: 0 },
        { name: '', qty: 0 },
        { name: '', qty: 0 },
      ],
    },
    fieldPaths: [],
    arrays: [{ path: 'rows', leaves: ['name', 'qty'] }],
    async drive(form, snap) {
      snap('initial')
      form.setValue('rows.0.name', 'Ann')
      await settle()
      snap('after-edit-row0')
      form.insert('rows', 0, { name: 'New', qty: 9 })
      await settle()
      snap('after-insert-front')
      form.remove('rows', 1)
      await settle()
      snap('after-remove-index1')
      form.move('rows', 0, 2)
      await settle()
      snap('after-move-0-to-2')
      form.append('rows', { name: 'End', qty: 1 })
      await settle()
      snap('after-append')
      form.reset()
      await settle()
      snap('after-reset')
    },
  },
  {
    id: 's5-discriminated-union',
    title: 'DU-heavy: variant switching (exercises the T1 cross-variant guard)',
    makeSchema: (z) =>
      z.object({
        payment: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('card'), cardNumber: z.string().min(4) }),
          z.object({ kind: z.literal('bank'), account: z.string().min(6) }),
        ]),
      }),
    defaultValues: { payment: { kind: 'card', cardNumber: '' } },
    fieldPaths: ['payment.kind'],
    async drive(form, snap) {
      snap('initial')
      form.setValue('payment.cardNumber', '4111')
      await settle()
      snap('after-card-edit')
      // Cross-variant write: 'account' is not in the active 'card' variant;
      // the guard must reject it (no 'account' surfaces in the value tree).
      form.setValue('payment.account', 'SHOULD-REJECT')
      await settle()
      snap('after-crossvariant-write')
      form.setValue('payment', { kind: 'bank', account: '' })
      await settle()
      snap('after-switch-bank')
      form.setValue('payment.account', '12345678')
      await settle()
      snap('after-bank-edit')
      form.setValue('payment', { kind: 'card', cardNumber: '' })
      await settle()
      snap('after-switch-back-card')
      await form.handleSubmit(noop, noop)(new Event('submit'))
      await settle()
      snap('after-submit')
      form.reset()
      await settle()
      snap('after-reset')
    },
  },
]

/**
 * A first-read scenario. The runner mounts the form, runs `beforeFirstRead`
 * synchronously, snaps `first-read`, settles, snaps `settled`, then hands
 * over to `afterSettled` for any further checkpoints.
 */
export type FirstReadScenario = {
  id: string
  title: string
  makeSchema: (z: any) => unknown
  /** Omitted to mount without `defaultValues`, deriving every value. */
  defaultValues?: Record<string, unknown>
  fieldPaths: string[]
  arrays?: ArraySpec[]
  /** Extra `useForm` options, such as `history`. */
  extraOptions?: () => Record<string, unknown>
  /**
   * `ssr-round-trip` builds the form on a server app, renders it, carries
   * `renderAttaformState` through JSON into `hydrateAttaformState`, and
   * mounts a hydrating client under the same fixed key. The client form is
   * the one captured.
   */
  mount: 'client' | 'ssr-round-trip'
  /** Runs on the server form during setup; `ssr-round-trip` only. */
  serverSetup?: (form: DriveForm) => void
  /** Runs synchronously between `app.mount` and the first snap. */
  beforeFirstRead?: (form: DriveForm) => void
  afterSettled?: (form: DriveForm, snap: (label: string) => void) => Promise<void>
  /**
   * Whether the v4 first-read capture holds any schema-channel error. Guards
   * against a vacuous capture: each scenario states what its first frame is
   * supposed to show.
   */
  firstReadSchemaErrors: 'some' | 'none'
  /**
   * Why zod v3 shows a different surface from v4 at some checkpoint. Omitted,
   * the two adapters must match exactly; given, the golden records each
   * differing value v3 shows.
   */
  v3Divergence?: string
}

/**
 * v3 cannot tell a sync `.refine` from an async one without running it, so
 * any refine makes `needsAsyncValidation()` answer `true`. The form then
 * starts with the `firstValidationDone` gate closed and `valid` held `false`
 * until the queued post-mount pass lands. v4 reads the refine as sync and
 * starts ungated.
 */
const V3_REFINE_GATE =
  'v3 counts every .refine as possibly async, so the first-validation gate starts closed until the post-mount pass'

/** Leaf, container and root sync refines over one small form. */
function makeRefineSchema(z: any): unknown {
  return z
    .object({
      name: z.string().refine((v: string) => v.length >= 2, { message: 'too short' }),
      password: z.string().min(1),
      confirm: z.string(),
      address: z
        .object({ zip: z.string(), city: z.string() })
        .refine((a: { zip: string; city: string }) => a.zip === '' || a.city !== '', {
          message: 'city needed',
        }),
    })
    .refine((v: { password: string; confirm: string }) => v.password === v.confirm, {
      message: 'mismatch',
      path: ['confirm'],
    })
}

/** Fails the leaf, container and root refines at once. */
const REFINE_DEFAULTS = {
  name: '',
  password: 'a',
  confirm: 'b',
  address: { zip: '1', city: '' },
}

const REFINE_FIELDS = ['name', 'password', 'confirm', 'address.zip', 'address.city']

function makeRowsSchema(z: any): unknown {
  return z.object({
    rows: z.array(z.object({ name: z.string().min(2), qty: z.number().min(1) })),
  })
}

/** One failing leaf per row, each at a different index. */
const ROWS_DEFAULTS = {
  rows: [
    { name: '', qty: 1 },
    { name: 'ok', qty: 0 },
    { name: 'x', qty: 5 },
  ],
}

const NEW_FIRST_READ_SCENARIOS: FirstReadScenario[] = [
  {
    id: 't0-sync-refines',
    title: 'fresh form failing a leaf, a container and a root sync refine',
    makeSchema: makeRefineSchema,
    defaultValues: REFINE_DEFAULTS,
    fieldPaths: REFINE_FIELDS,
    mount: 'client',
    firstReadSchemaErrors: 'some',
    v3Divergence: V3_REFINE_GATE,
  },
  {
    id: 't0-derived-defaults',
    title: 'no defaultValues: every value derived from the schema',
    makeSchema: makeRefineSchema,
    fieldPaths: REFINE_FIELDS,
    mount: 'client',
    firstReadSchemaErrors: 'some',
    v3Divergence: V3_REFINE_GATE,
  },
  {
    id: 't0-set-value-before-read',
    title: 'setValue fixes one leaf and breaks another before the first read',
    makeSchema: makeRefineSchema,
    defaultValues: REFINE_DEFAULTS,
    fieldPaths: REFINE_FIELDS,
    mount: 'client',
    beforeFirstRead(form) {
      form.setValue('name', 'Ada')
      form.setValue('password', '')
    },
    firstReadSchemaErrors: 'some',
    v3Divergence: V3_REFINE_GATE,
  },
  {
    id: 't0-array-ops-before-read',
    title: 'append, remove and move before the first read drop every shifted verdict',
    makeSchema: makeRowsSchema,
    defaultValues: ROWS_DEFAULTS,
    fieldPaths: [],
    arrays: [{ path: 'rows', leaves: ['name', 'qty'] }],
    mount: 'client',
    beforeFirstRead(form) {
      form.append('rows', { name: '', qty: 0 })
      form.remove('rows', 0)
      form.move('rows', 0, 1)
    },
    // Every seeded verdict sat at an index the remove or the move shifted, so
    // the bookkeeping dropped them all; the field passes re-derive them once
    // settled.
    firstReadSchemaErrors: 'none',
  },
  {
    id: 't0-array-append-before-read',
    title: 'append and a tail remove before the first read keep unshifted verdicts',
    makeSchema: makeRowsSchema,
    defaultValues: ROWS_DEFAULTS,
    fieldPaths: [],
    arrays: [{ path: 'rows', leaves: ['name', 'qty'] }],
    mount: 'client',
    beforeFirstRead(form) {
      form.append('rows', { name: '', qty: 0 })
      form.remove('rows', 2)
    },
    firstReadSchemaErrors: 'some',
  },
  {
    id: 't0-reset-before-read',
    title: 'reset to new defaults before the first read',
    makeSchema: makeRefineSchema,
    defaultValues: REFINE_DEFAULTS,
    fieldPaths: REFINE_FIELDS,
    mount: 'client',
    beforeFirstRead(form) {
      form.setValue('name', 'Ada')
      form.reset({ name: 'B', password: '', confirm: '', address: { zip: '', city: '' } })
    },
    firstReadSchemaErrors: 'some',
    v3Divergence: V3_REFINE_GATE,
  },
  {
    id: 't0-ssr-round-trip',
    title: 'hydrating client replays the server verdict and a user error',
    makeSchema: makeRefineSchema,
    defaultValues: REFINE_DEFAULTS,
    fieldPaths: REFINE_FIELDS,
    mount: 'ssr-round-trip',
    serverSetup(form) {
      form.setErrors([{ path: ['password'], message: 'taken', code: 'api:taken' }])
    },
    firstReadSchemaErrors: 'some',
    v3Divergence: V3_REFINE_GATE,
  },
  {
    id: 't0-async-refine',
    title: 'an async refine skips the construction verdict until the post-mount pass',
    makeSchema: (z) =>
      z.object({
        email: z
          .string()
          .refine(async (v: string) => Promise.resolve(v.includes('@')), { message: 'needs @' }),
        name: z.string().min(2),
      }),
    defaultValues: { email: '', name: '' },
    fieldPaths: ['email', 'name'],
    mount: 'client',
    firstReadSchemaErrors: 'none',
  },
  {
    id: 't0-du-bad-discriminator',
    title: 'discriminated union whose default names no variant',
    makeSchema: (z) =>
      z.object({
        payment: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('card'), cardNumber: z.string().min(4) }),
          z.object({ kind: z.literal('bank'), account: z.string().min(6) }),
        ]),
      }),
    defaultValues: { payment: { kind: 'crypto' } },
    fieldPaths: ['payment.kind'],
    mount: 'client',
    firstReadSchemaErrors: 'some',
    v3Divergence:
      'zod v3 files a discriminator naming no variant as invalid_union_discriminator; v4 files it as invalid_union',
  },
  {
    id: 't0-map-set-date',
    title: 'Map, Set and Date leaves failing their checks',
    makeSchema: (z) =>
      z.object({
        tags: z.set(z.string()).min(1),
        lookup: z.map(z.string(), z.number().min(1)),
        when: z.date().min(new Date('2020-01-01T00:00:00.000Z')),
      }),
    defaultValues: {
      tags: new Set<string>(),
      lookup: new Map([['a', 0]]),
      when: new Date('2019-06-01T00:00:00.000Z'),
    },
    // `fields` exposes a Set or Map as a drill-down container, so the leaves
    // read here are the map entry and the date; the set's own verdict shows
    // in the error channels and `meta.value` carries every collection.
    fieldPaths: ['lookup.a', 'when'],
    mount: 'client',
    firstReadSchemaErrors: 'some',
    v3Divergence:
      "v3's construction verdict skips the Map and Set issue re-filing every other v3 parse applies, so the map entry's error lands at zod's raw [entryIndex, 'value'] path",
  },
  {
    id: 't0-history',
    title: 'history enabled: undo returns to the construction verdict',
    makeSchema: makeRefineSchema,
    defaultValues: REFINE_DEFAULTS,
    fieldPaths: REFINE_FIELDS,
    extraOptions: () => ({ history: historyPlugin() }),
    mount: 'client',
    async afterSettled(form, snap) {
      form.setValue('name', 'Ada')
      await settle()
      snap('after-edit')
      form.history?.undo()
      await settle()
      snap('after-undo')
    },
    firstReadSchemaErrors: 'some',
    v3Divergence: V3_REFINE_GATE,
  },
]

/**
 * Every first-read scenario: the settled matrix above re-run in first-read
 * mode (their own goldens stay as they are), then the construction-focused
 * additions.
 */
export const FIRST_READ_SCENARIOS: FirstReadScenario[] = [
  ...SCENARIOS.map((scenario): FirstReadScenario => ({
    id: scenario.id,
    title: scenario.title,
    makeSchema: scenario.makeSchema,
    defaultValues: scenario.defaultValues,
    fieldPaths: scenario.fieldPaths,
    ...(scenario.arrays === undefined ? {} : { arrays: scenario.arrays }),
    mount: 'client',
    firstReadSchemaErrors: 'some',
  })),
  ...NEW_FIRST_READ_SCENARIOS,
]
