// @vitest-environment jsdom
/**
 * Render-isolation lock — the standing reactivity guard for P3
 * (PERF-ANALYSIS.md row P3). Firmed from the P3 discovery probe once the
 * bust-vs-lock call was made: both-adapter coverage + exact-count assertions.
 *
 * THE CONTRACT THIS LOCKS
 *
 *   Editing one field re-renders ONLY the components subscribed to that
 *   field and its ANCESTOR containers. A component subscribed to an
 *   unrelated sibling (or sibling subtree) does NOT re-render.
 *
 * The store layer was already proven granular (PERF-ANALYSIS "Already
 * optimal": the `fields` / `schemaErrors` Maps + `blankPaths` Set use Vue 3.5
 * collection tracking). P3 measured the next layer up: with one COMPONENT per
 * field, typing into field X re-rendered the components of EVERY other field
 * (O(F) over-render), because each field's `form.fields(path)` computed
 * carried two whole-form dependencies —
 *
 *   1. `getFormMetaBase()` (field-state-api.ts), called unconditionally to
 *      build the predicate's `formMeta` arg, ran `buildContainerFieldStateBase
 *      (ROOT)` — a rollup that walks every leaf (incl. the edited leaf's
 *      `updatedAt`, bumped on every write) and aggregates all errors.
 *   2. `state.derivedBlankErrors.value` (create-form-store.ts) — a computed
 *      returning a FRESH Map, read per-leaf; any blank transition gave it a
 *      new identity and woke every field.
 *
 * The bust made `formMeta` lazy (the default predicate reads only
 * `formMeta.submissionAttempts`, an O(1) ref) and synthesized each field's
 * blank error from its OWN `blankPaths.has(key)`. Output stayed byte-identical
 * (locked by behavior-lock.test.ts); only the render COUNT dropped — the one
 * signal P3 set out to move.
 *
 * THE DECISIVE CONTRAST (the subscription style each field component uses):
 *
 *   - `fields-display` / `fields-value` — reads `form.fields(path).displayState`
 *     / `.value`, i.e. the field-state computed that carried the two whole-form
 *     deps. This is what over-rendered.
 *   - `register-value` — reads `form.register(path).displayValue.value`, which
 *     tracks only `getValueAtPath(path)` + `blankPaths.has(path)`
 *     (register-api.ts). Already isolated; the granular CONTROL. Its presence
 *     proves the harness measures real isolation rather than a setup in which
 *     nothing ever re-renders.
 *
 * Each scenario marks every non-edited field `isolated` (must stay 0) or
 * `ancestor` (a container ABOVE the edit — legitimately re-renders, asserted
 * `>= 1` so the bust cannot over-shoot and freeze a container that should
 * stay live). Run against BOTH adapters: the over-render lived in shared core,
 * so the lock must hold identically on zod-v3 and zod-v4.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z as zV4 } from 'zod'
import { z as zV3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import { createAttaform } from '../../src/runtime/core/plugin'
import { wait } from '../utils/form-harness'

const ADAPTERS = [
  { name: 'zod-v4', z: zV4 as any, useForm: useFormV4 as any },
  { name: 'zod-v3', z: zV3 as any, useForm: useFormV3 as any },
] as const

type SubStyle = 'fields-display' | 'fields-value' | 'register-value'

type FieldSpec = {
  path: string
  label: string
  // The lock: a field marked `isolated` MUST NOT re-render when an unrelated
  // field is edited. A field marked `ancestor` is a container above the edit
  // and legitimately re-renders (asserted `>= 1`).
  role: 'isolated' | 'ancestor'
}

type LockScenario = {
  id: string
  style: SubStyle
  makeSchema: (z: any) => any
  defaultValues: Record<string, unknown>
  fields: ReadonlyArray<FieldSpec>
  edit: { label: string; path: string; value: unknown }
  validateOn: 'change' | 'submit'
  prewrite?: ReadonlyArray<{ path: string; value: unknown }>
  note: string
}

/** Cover the 0 ms validation debounce (setTimeout) + reactive flush. */
async function settle(): Promise<void> {
  await wait(20)
  await nextTick()
  await nextTick()
}

// ── Scenario fixtures ────────────────────────────────────────────────────────

const flatSchema = (z: any): any =>
  z.object({
    a: z.string().min(2),
    b: z.string(),
    c: z.string(),
    d: z.string(),
    e: z.string().min(3),
  })
const flatDefaults = { a: '', b: '', c: '', d: '', e: '' }
const flatSiblings: ReadonlyArray<FieldSpec> = [
  { path: 'b', label: 'b', role: 'isolated' },
  { path: 'c', label: 'c', role: 'isolated' },
  { path: 'd', label: 'd', role: 'isolated' },
  { path: 'e', label: 'e', role: 'isolated' },
]
const flatFields = (edit: FieldSpec): ReadonlyArray<FieldSpec> => [edit, ...flatSiblings]

const SCENARIOS: ReadonlyArray<LockScenario> = [
  // CONTROL — register-value is already granular. Green before AND after the
  // bust; proves the harness can SEE isolation (siblings genuinely hit 0).
  {
    id: 'control: flat / register-value',
    style: 'register-value',
    makeSchema: flatSchema,
    defaultValues: flatDefaults,
    fields: flatFields({ path: 'a', label: 'a', role: 'isolated' }),
    edit: { label: 'a', path: 'a', value: 'Ada' },
    validateOn: 'change',
    note: 'granular control — register tracks own value + own blank only',
  },
  // VECTOR 1 (structural) — validation off, every field pre-dirtied to a
  // non-blank value, then "a" re-edited to ANOTHER non-blank value. No blank
  // transition, no pristine flip, no validation. Any sibling re-render is the
  // root rollup reading the edited leaf's `updatedAt` — pure formMeta deps.
  {
    id: 'vector1: flat / fields-display (quiet re-edit)',
    style: 'fields-display',
    makeSchema: flatSchema,
    defaultValues: flatDefaults,
    fields: flatFields({ path: 'a', label: 'a', role: 'isolated' }),
    edit: { label: 'a', path: 'a', value: 'Adam' },
    validateOn: 'submit',
    prewrite: [
      { path: 'a', value: 'Ada' },
      { path: 'b', value: 'bee' },
      { path: 'c', value: 'cee' },
      { path: 'd', value: 'dee' },
      { path: 'e', value: 'eee' },
    ],
    note: 'structural — isolates the formMeta rollup dep from blank/validation',
  },
  // VECTORS 1 + 2 (default mode) — the everyday keystroke: validateOn:'change',
  // editing "a" from blank to non-blank. Drops "a" from blankPaths (vector 2)
  // AND bumps the rollup (vector 1); both must be busted for siblings to hold 0.
  {
    id: 'vectors1+2: flat / fields-display (blank->value, change mode)',
    style: 'fields-display',
    makeSchema: flatSchema,
    defaultValues: flatDefaults,
    fields: flatFields({ path: 'a', label: 'a', role: 'isolated' }),
    edit: { label: 'a', path: 'a', value: 'Ada' },
    validateOn: 'change',
    note: 'everyday keystroke through the displayState surface',
  },
  {
    id: 'vectors1+2: flat / fields-value (blank->value, change mode)',
    style: 'fields-value',
    makeSchema: flatSchema,
    defaultValues: flatDefaults,
    fields: flatFields({ path: 'a', label: 'a', role: 'isolated' }),
    edit: { label: 'a', path: 'a', value: 'Ada' },
    validateOn: 'change',
    note: 'same keystroke through the value surface',
  },
  // NESTED — editing a leaf must leave the sibling subtree (contact.*) and the
  // sibling container untouched, while the OWN ancestor container stays live.
  {
    id: 'nested: fields-display',
    style: 'fields-display',
    makeSchema: (z: any): any =>
      z.object({
        profile: z.object({ first: z.string().min(2), last: z.string() }),
        contact: z.object({ email: z.string().min(3), phone: z.string() }),
      }),
    defaultValues: { profile: { first: '', last: '' }, contact: { email: '', phone: '' } },
    fields: [
      { path: 'profile.first', label: 'profile.first', role: 'isolated' },
      { path: 'profile.last', label: 'profile.last', role: 'isolated' },
      { path: 'contact.email', label: 'contact.email', role: 'isolated' },
      { path: 'contact.phone', label: 'contact.phone', role: 'isolated' },
      { path: 'profile', label: 'profile(container)', role: 'ancestor' },
      { path: 'contact', label: 'contact(container)', role: 'isolated' },
    ],
    edit: { label: 'profile.first', path: 'profile.first', value: 'Grace' },
    validateOn: 'change',
    note: 'ancestor container stays live; sibling subtree + sibling container hold 0',
  },
  // ARRAY — editing one cell must leave the other cells (same row and other
  // rows) untouched.
  {
    id: 'array: fields-display',
    style: 'fields-display',
    makeSchema: (z: any): any =>
      z.object({ rows: z.array(z.object({ name: z.string().min(2), qty: z.string() })) }),
    defaultValues: {
      rows: [
        { name: '', qty: '' },
        { name: '', qty: '' },
        { name: '', qty: '' },
      ],
    },
    fields: [
      { path: 'rows.0.name', label: 'rows.0.name', role: 'isolated' },
      { path: 'rows.0.qty', label: 'rows.0.qty', role: 'isolated' },
      { path: 'rows.1.name', label: 'rows.1.name', role: 'isolated' },
      { path: 'rows.1.qty', label: 'rows.1.qty', role: 'isolated' },
      { path: 'rows.2.name', label: 'rows.2.name', role: 'isolated' },
      { path: 'rows.2.qty', label: 'rows.2.qty', role: 'isolated' },
    ],
    edit: { label: 'rows.0.name', path: 'rows.0.name', value: 'Ann' },
    validateOn: 'change',
    note: 'sibling cells (same row + other rows) hold 0',
  },
]

describe.each(ADAPTERS)('render isolation on a single-field keystroke ($name)', (adapter) => {
  const apps: App[] = []
  let keySeq = 0

  // Per-path render-fn invocation counter, shared with the field components via
  // closure. Cleared AFTER the initial mount+settle so counts reflect ONLY the
  // renders the scripted write caused.
  const renders = new Map<string, number>()
  const bump = (label: string): void => {
    renders.set(label, (renders.get(label) ?? 0) + 1)
  }

  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    document.body.innerHTML = ''
    renders.clear()
  })

  // Subscribes to exactly one path through the real public surface, then counts
  // its own render-fn invocations under a label.
  const Field = defineComponent({
    props: {
      form: { type: Object, required: true },
      path: { type: String, required: true },
      label: { type: String, required: true },
      style: { type: String, required: true },
    },
    setup(props) {
      // `register` returns a fresh RegisterValue per call, so it is called ONCE
      // in setup; `fields` is memoised per path and read in the render body.
      const rv = props.style === 'register-value' ? (props.form as any).register(props.path) : null
      return () => {
        bump(props.label)
        let read: unknown
        if (props.style === 'register-value') read = rv.displayValue.value
        else if (props.style === 'fields-value') read = (props.form as any).fields(props.path).value
        else read = (props.form as any).fields(props.path).displayState
        return h('div', String(read ?? ''))
      }
    },
  })

  function mount(scenario: LockScenario): any {
    keySeq += 1
    const schema = scenario.makeSchema(adapter.z)
    let capturedForm: any
    const Harness = defineComponent({
      setup() {
        capturedForm = adapter.useForm({
          schema,
          key: `iso-${adapter.name}-${keySeq}`,
          defaultValues: scenario.defaultValues,
          strict: false,
          validateOn: scenario.validateOn,
          debounceMs: 0,
        })
        return () =>
          h(
            'div',
            scenario.fields.map((f) =>
              h(Field, {
                key: `${scenario.style}:${f.label}`,
                form: capturedForm,
                path: f.path,
                label: f.label,
                style: scenario.style,
              })
            )
          )
      },
    })
    const app = createApp(Harness).use(createAttaform())
    const root = document.createElement('div')
    document.body.appendChild(root)
    app.mount(root)
    apps.push(app)
    return capturedForm
  }

  /** Mount, settle, (optionally pre-write,) zero counters, drive the edit. */
  async function drive(scenario: LockScenario): Promise<Record<string, number>> {
    const form = mount(scenario)
    await settle()
    if (scenario.prewrite) {
      for (const w of scenario.prewrite) form.setValue(w.path, w.value)
      await settle()
    }
    renders.clear()
    form.setValue(scenario.edit.path, scenario.edit.value)
    await settle()
    return Object.fromEntries(renders)
  }

  it.each(SCENARIOS)('$id — $note', async (scenario) => {
    const counts = await drive(scenario)

    // The edited field re-renders (sanity: the write landed and was observed).
    expect(counts[scenario.edit.label] ?? 0).toBeGreaterThanOrEqual(1)

    // Isolated fields hold 0; ancestor containers stay live.
    for (const f of scenario.fields) {
      if (f.label === scenario.edit.label) continue
      if (f.role === 'ancestor') {
        expect(
          counts[f.label] ?? 0,
          `ancestor "${f.label}" should stay reactive`
        ).toBeGreaterThanOrEqual(1)
      } else {
        expect(counts[f.label] ?? 0, `sibling "${f.label}" must not re-render`).toBe(0)
      }
    }
  })
})
