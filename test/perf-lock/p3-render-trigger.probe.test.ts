// @vitest-environment jsdom
/**
 * P3 probe — component over-render on keystroke (PERF-ANALYSIS.md row P3).
 *
 * The store layer is already proven granular (PERF-ANALYSIS "Already
 * optimal": the `fields` / `schemaErrors` Maps + `blankPaths` Set use Vue 3.5
 * collection tracking, so a write to `email` does not wake `name`'s store
 * computed). P3 asks the next question up the stack: when a consumer mounts
 * one COMPONENT per field, does typing into field X re-render the components
 * subscribed to the OTHER fields?
 *
 * Methodology (resolves the open question in PERF-ANALYSIS §"Open questions" —
 * `onRenderTriggered` mount harness vs. a lighter store-effect counter): a
 * jsdom mount with a per-component render-fn invocation counter, reading the
 * REAL public surface. The render-fn count is the actual observable P3 is
 * about (wasted component render work). A store-effect counter would measure
 * effect re-runs (over-counts: a computed re-evaluating is not a component
 * re-render — Vue dedupes) and only sees the store layer we already cleared.
 *
 * The decisive contrast is the SUBSCRIPTION STYLE each field component uses:
 *
 *   - `fields-display` / `fields-value` — reads `form.fields(path).displayState`
 *     / `.value`. The field-state computed (field-state-api.ts) calls
 *     `getFormMetaBase()` UNCONDITIONALLY (field-state-api.ts:581), which runs
 *     `buildContainerFieldStateBase(ROOT)` (build-form-api.ts:161) — a
 *     whole-form rollup that walks every leaf in `originals` and aggregates
 *     errors across the entire form. Because that runs INSIDE every field's
 *     computed, every `form.fields(path)` transitively depends on every other
 *     leaf's pristine / blank / error state. Suspected O(F) over-render.
 *   - `register-value` — reads `form.register(path).displayValue.value`, which
 *     tracks only `state.getValueAtPath(path)` + `state.blankPaths.has(path)`
 *     (register-api.ts:207). No `getFormMetaBase`. The granular control.
 *
 * If siblings re-render under the `fields-*` styles but NOT under
 * `register-value`, the over-render is isolated to the field-state computed's
 * whole-form rollup dependency — not the deep value tree (T5) and not Vue.
 *
 * This is a DISCOVERY probe: it asserts only the sanity invariant (the edited
 * field re-renders) and LOGS the per-field render table so the over-render is
 * read off the output. Once the bust-vs-lock call is made it firms into a
 * standing reactivity-timing lock (PERF-ANALYSIS lines 601-602), at which
 * point it gains both-adapter coverage and exact-count assertions.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, writeFileSync } from 'node:fs'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod-v4'
import { createAttaform } from '../../src/runtime/core/plugin'
import { wait } from '../utils/form-harness'

type SubStyle = 'fields-display' | 'fields-value' | 'register-value'

// Vitest 4.x intercepts worker stdout, so console.log from inside a test is
// swallowed. Mirror the render tables to a file the runner can read back.
const REPORT = '/tmp/p3-report.txt'
writeFileSync(REPORT, 'P3 render-trigger probe\n')

/** Cover the 0 ms validation debounce (setTimeout) + reactive flush. */
async function settle(): Promise<void> {
  await wait(20)
  await nextTick()
  await nextTick()
}

describe('P3: component over-render on a single-field keystroke', () => {
  const apps: App[] = []
  let keySeq = 0

  // Per-path render-fn invocation counter, shared with the field components
  // via closure. Reset to zero AFTER the initial mount+settle so the recorded
  // counts reflect ONLY the renders caused by the scripted write.
  const renders = new Map<string, number>()
  const bump = (label: string): void => {
    renders.set(label, (renders.get(label) ?? 0) + 1)
  }
  const resetRenders = (): void => renders.clear()
  const snapshot = (): Record<string, number> => Object.fromEntries(renders)

  afterEach(() => {
    while (apps.length > 0) apps.pop()?.unmount()
    document.body.innerHTML = ''
    renders.clear()
  })

  // A field component that subscribes to exactly one path through the real
  // public surface, then counts its own render-fn invocations under a label.
  const Field = defineComponent({
    props: {
      form: { type: Object, required: true },
      path: { type: String, required: true },
      label: { type: String, required: true },
      style: { type: String, required: true },
    },
    setup(props) {
      // `register` returns a fresh RegisterValue (with fresh computeds) per
      // call, so it must be called ONCE in setup, not per render. `fields` is
      // memoised per path by the accessor, so it is read in the render body.
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

  function mountFields(
    schema: any,
    defaultValues: Record<string, unknown>,
    fields: ReadonlyArray<{ path: string; label: string }>,
    style: SubStyle,
    validateOn: 'change' | 'submit'
  ): any {
    keySeq += 1
    let capturedForm: any
    const Harness = defineComponent({
      setup() {
        capturedForm = (useForm as any)({
          schema,
          key: `p3-${keySeq}`,
          defaultValues,
          strict: false,
          validateOn,
          debounceMs: 0,
        })
        return () =>
          h(
            'div',
            fields.map((f) =>
              h(Field, {
                key: `${style}:${f.label}`,
                form: capturedForm,
                path: f.path,
                label: f.label,
                style,
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

  /**
   * Mount the field set, settle, zero the counters, drive a single write,
   * settle again, and return the per-label render counts caused by that write.
   */
  async function probe(
    scenario: string,
    style: SubStyle,
    schema: any,
    defaultValues: Record<string, unknown>,
    fields: ReadonlyArray<{ path: string; label: string }>,
    edit: { label: string; path: string; value: unknown },
    opts: {
      validateOn?: 'change' | 'submit'
      prewrite?: ReadonlyArray<{ path: string; value: unknown }>
    } = {}
  ): Promise<Record<string, number>> {
    const validateOn = opts.validateOn ?? 'change'
    const form = mountFields(schema, defaultValues, fields, style, validateOn)
    await settle()
    // Optional pre-edit writes (e.g. pre-dirty every field) so the measured
    // write is a "quiet" re-edit: no blank transition, no pristine flip.
    if (opts.prewrite) {
      for (const w of opts.prewrite) form.setValue(w.path, w.value)
      await settle()
    }
    resetRenders()
    form.setValue(edit.path, edit.value)
    await settle()
    const counts = snapshot()

    const others = fields.filter((f) => f.label !== edit.label)
    const overRendered = others.filter((f) => (counts[f.label] ?? 0) > 0)
    const lines = fields.map((f) => `      ${f.label.padEnd(18)} ${counts[f.label] ?? 0}`)
    const prewriteNote = opts.prewrite ? `, pre-dirtied` : ''
    const msg =
      `\n[P3] ${scenario} / ${style} (validateOn:${validateOn}${prewriteNote}) — edit "${edit.label}"` +
      `\n    edited renders: ${counts[edit.label] ?? 0}` +
      `\n    siblings re-rendered: ${overRendered.length}/${others.length}` +
      `\n${lines.join('\n')}\n`
    appendFileSync(REPORT, msg)
    return counts
  }

  // ── Scenario: flat — 5 sibling leaves, edit one ────────────────────────────
  const flatSchema = z.object({
    a: z.string().min(2),
    b: z.string(),
    c: z.string(),
    d: z.string(),
    e: z.string().min(3),
  })
  const flatDefaults = { a: '', b: '', c: '', d: '', e: '' }
  const flatFields = [
    { path: 'a', label: 'a' },
    { path: 'b', label: 'b' },
    { path: 'c', label: 'c' },
    { path: 'd', label: 'd' },
    { path: 'e', label: 'e' },
  ]
  const flatEdit = { label: 'a', path: 'a', value: 'Ada' }

  it('flat / fields-display — does editing "a" re-render b..e?', async () => {
    const counts = await probe(
      'flat',
      'fields-display',
      flatSchema,
      flatDefaults,
      flatFields,
      flatEdit
    )
    expect(counts[flatEdit.label] ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('flat / fields-value — does editing "a" re-render b..e?', async () => {
    const counts = await probe(
      'flat',
      'fields-value',
      flatSchema,
      flatDefaults,
      flatFields,
      flatEdit
    )
    expect(counts[flatEdit.label] ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('flat / register-value (granular control) — should re-render only "a"', async () => {
    const counts = await probe(
      'flat',
      'register-value',
      flatSchema,
      flatDefaults,
      flatFields,
      flatEdit
    )
    expect(counts[flatEdit.label] ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('flat / fields-display, quiet re-edit (validateOn:submit, pre-dirtied) — structural?', async () => {
    // Isolation: every field is pre-dirtied to a non-blank value, validation
    // is off (validateOn:submit), then "a" is re-edited to ANOTHER non-blank
    // value. No blank transition, no pristine flip, no validation runs. If
    // siblings still re-render, the over-render is STRUCTURAL — the root
    // rollup inside getFormMetaBase reads the edited leaf's field record
    // (updatedAt), which any write bumps — not a validation/blank artifact.
    const counts = await probe(
      'flat',
      'fields-display',
      flatSchema,
      flatDefaults,
      flatFields,
      {
        label: 'a',
        path: 'a',
        value: 'Adam',
      },
      {
        validateOn: 'submit',
        prewrite: [
          { path: 'a', value: 'Ada' },
          { path: 'b', value: 'bee' },
          { path: 'c', value: 'cee' },
          { path: 'd', value: 'dee' },
          { path: 'e', value: 'eee' },
        ],
      }
    )
    expect(counts['a'] ?? 0).toBeGreaterThanOrEqual(1)
  })

  // ── Scenario: nested — leaves + their containers, edit one leaf ─────────────
  const nestedSchema = z.object({
    profile: z.object({ first: z.string().min(2), last: z.string() }),
    contact: z.object({ email: z.string().min(3), phone: z.string() }),
  })
  const nestedDefaults = {
    profile: { first: '', last: '' },
    contact: { email: '', phone: '' },
  }
  const nestedFields = [
    { path: 'profile.first', label: 'profile.first' },
    { path: 'profile.last', label: 'profile.last' },
    { path: 'contact.email', label: 'contact.email' },
    { path: 'contact.phone', label: 'contact.phone' },
    { path: 'profile', label: 'profile(container)' },
    { path: 'contact', label: 'contact(container)' },
  ]
  const nestedEdit = { label: 'profile.first', path: 'profile.first', value: 'Grace' }

  it('nested / fields-display — does editing "profile.first" re-render the contact subtree?', async () => {
    const counts = await probe(
      'nested',
      'fields-display',
      nestedSchema,
      nestedDefaults,
      nestedFields,
      nestedEdit
    )
    expect(counts[nestedEdit.label] ?? 0).toBeGreaterThanOrEqual(1)
  })

  // ── Scenario: array — 3 rows, edit one leaf in row 0 ────────────────────────
  const arraySchema = z.object({
    rows: z.array(z.object({ name: z.string().min(2), qty: z.string() })),
  })
  const arrayDefaults = {
    rows: [
      { name: '', qty: '' },
      { name: '', qty: '' },
      { name: '', qty: '' },
    ],
  }
  const arrayFields = [
    { path: 'rows.0.name', label: 'rows.0.name' },
    { path: 'rows.0.qty', label: 'rows.0.qty' },
    { path: 'rows.1.name', label: 'rows.1.name' },
    { path: 'rows.1.qty', label: 'rows.1.qty' },
    { path: 'rows.2.name', label: 'rows.2.name' },
    { path: 'rows.2.qty', label: 'rows.2.qty' },
  ]
  const arrayEdit = { label: 'rows.0.name', path: 'rows.0.name', value: 'Ann' }

  it('array / fields-display — does editing "rows.0.name" re-render rows 1 and 2?', async () => {
    const counts = await probe(
      'array',
      'fields-display',
      arraySchema,
      arrayDefaults,
      arrayFields,
      arrayEdit
    )
    expect(counts[arrayEdit.label] ?? 0).toBeGreaterThanOrEqual(1)
  })
})
