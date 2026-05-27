// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, withDirectives, type App } from 'vue'
import { z as zV4 } from 'zod'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { createAttaform } from '../../src/runtime/core/plugin'
import { vRegister } from '../../src/runtime/core/directive'

/**
 * `validateOn: 'blur'` revalidation dedup.
 *
 * A blur fires a fresh whole-form validation pass. That is the correct
 * trigger when the user edited the field, but a focus/blur cycle with no
 * intervening edit changes nothing the schema could rule on differently.
 * Re-running the pipeline there is wasted work, and because the run flips
 * `validating` true for the duration, it flickers a settled error through
 * `'pending'` and back on every refocus — `error → pending → error`.
 *
 * Attaform should recognise that nothing changed since the last pass and
 * skip the run. These tests count refine invocations as a direct proxy for
 * "the pipeline ran": `validating` only flips inside the run, so a flat
 * count across an idle blur is exactly the absence of the flicker.
 */

type FormLike = {
  register: (path: string) => unknown
  fields: (path: string) => {
    displayState: 'idle' | 'pending' | 'error' | 'success'
    validating: boolean
    errors: readonly unknown[]
    value: unknown
  }
}

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
  document.body.innerHTML = ''
})

function mountCounted(opts: { lazy?: boolean; defaultValue?: string } = {}): {
  api: FormLike
  input: HTMLInputElement
  runs: () => number
} {
  let runs = 0
  const schema = zV4.object({
    email: zV4.string().refine(
      (val) => {
        runs += 1
        return /.+@.+\..+/.test(val)
      },
      { error: 'Enter a valid email' }
    ),
  })
  const handle: { api?: FormLike } = {}
  const Comp = defineComponent({
    setup() {
      const api = useFormV4({
        schema,
        key: `blur-dedup-${Math.random()}`,
        strict: false,
        validateOn: 'blur',
        ...(opts.defaultValue !== undefined ? { defaultValues: { email: opts.defaultValue } } : {}),
      } as never) as unknown as FormLike & { register: (p: string) => unknown }
      handle.api = api
      return () =>
        opts.lazy === true
          ? withDirectives(h('input', { type: 'text' }), [
              [vRegister, api.register('email'), '', { lazy: true }],
            ])
          : withDirectives(h('input', { type: 'text' }), [[vRegister, api.register('email')]])
    },
  })
  const app = createApp(Comp).use(createAttaform())
  const root = document.createElement('div')
  document.body.appendChild(root)
  app.mount(root)
  apps.push(app)
  if (handle.api === undefined) throw new Error('mountCounted: api never set')
  return { api: handle.api, input: root.firstElementChild as HTMLInputElement, runs: () => runs }
}

function typeInto(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('validateOn: blur — skip revalidation when nothing changed', () => {
  it('a focus/blur cycle with no edit does not re-run the validation pipeline', async () => {
    const { api, input, runs } = mountCounted()

    // Edit to an invalid value and blur: the pass runs, the error reveals.
    input.dispatchEvent(new FocusEvent('focus'))
    typeInto(input, 'nope')
    await nextTick()
    input.dispatchEvent(new FocusEvent('blur'))
    await settle()
    expect(api.fields('email').displayState).toBe('error')
    const runsAfterEdit = runs()

    // Refocus and leave without touching the value. Nothing changed, so the
    // pipeline must not run again: the count stays flat and the settled error
    // never flickers through 'pending'.
    input.dispatchEvent(new FocusEvent('focus'))
    input.dispatchEvent(new FocusEvent('blur'))
    await settle()
    expect(runs()).toBe(runsAfterEdit)
    expect(api.fields('email').validating).toBe(false)
    expect(api.fields('email').displayState).toBe('error')
  })

  it('still re-runs when the value actually changed between blurs', async () => {
    const { api, input, runs } = mountCounted()

    input.dispatchEvent(new FocusEvent('focus'))
    typeInto(input, 'nope')
    await nextTick()
    input.dispatchEvent(new FocusEvent('blur'))
    await settle()
    const runsAfterFirstEdit = runs()

    // A real edit before the next blur must revalidate.
    input.dispatchEvent(new FocusEvent('focus'))
    typeInto(input, 'still-bad')
    await nextTick()
    input.dispatchEvent(new FocusEvent('blur'))
    await settle()
    expect(runs()).toBeGreaterThan(runsAfterFirstEdit)
    expect(api.fields('email').displayState).toBe('error')
  })

  // The dedup must key on the value, not on "was there any write". Editing a
  // field away and back to its last-validated value ("a" -> "ab" -> "a")
  // leaves the verdict provably unchanged, so the blur must not re-run. A
  // write-counter approach fails this: each keystroke counts as a mutation, so
  // the round-trip looks "changed" and the settled error flickers through
  // 'pending' again.
  it('does not re-run when the value round-trips back to the last-validated value', async () => {
    const { api, input, runs } = mountCounted()

    // Establish a validated baseline at "a".
    input.dispatchEvent(new FocusEvent('focus'))
    typeInto(input, 'a')
    await nextTick()
    input.dispatchEvent(new FocusEvent('blur'))
    await settle()
    expect(api.fields('email').displayState).toBe('error')
    const runsAtBaseline = runs()

    // Refocus and edit away then back: "a" -> "ab" -> "a". The value at blur is
    // identical to what was just validated.
    input.dispatchEvent(new FocusEvent('focus'))
    typeInto(input, 'ab')
    await nextTick()
    typeInto(input, 'a')
    await nextTick()
    expect(api.fields('email').value).toBe('a')
    input.dispatchEvent(new FocusEvent('blur'))
    await settle()
    expect(runs()).toBe(runsAtBaseline)
    expect(api.fields('email').validating).toBe(false)
    expect(api.fields('email').displayState).toBe('error')
  })

  // The dedup must never swallow the FIRST interactive blur, even when the
  // value at that blur equals an earlier-validated snapshot. A field can be
  // validated before the user ever interacts (the construction pass over its
  // initial value), and that verdict may have been filtered or simply not yet
  // visible. If the user edits away and back to the initial value, the first
  // blur after interaction is when the verdict becomes visible, so it must run
  // and surface the real errors rather than skipping on the stale match.
  it('runs on the first interactive blur even when the value round-trips to its initial value', async () => {
    const { api, input, runs } = mountCounted({ defaultValue: 'bad' })

    // Seed a validated snapshot of the initial value with a non-interactive
    // tab-through (no edit), so "bad" is on record regardless of whether the
    // construction pass ran.
    input.dispatchEvent(new FocusEvent('focus'))
    input.dispatchEvent(new FocusEvent('blur'))
    await settle()
    const runsAfterSeed = runs()

    // Interact: edit away from the initial value and back to it.
    input.dispatchEvent(new FocusEvent('focus'))
    typeInto(input, 'good@example.com')
    await nextTick()
    typeInto(input, 'bad')
    await nextTick()
    expect(api.fields('email').value).toBe('bad')

    // First interactive blur. The value matches the seeded snapshot, but the
    // verdict becomes visible here, so validation must run and surface it.
    input.dispatchEvent(new FocusEvent('blur'))
    await settle()
    expect(runs()).toBeGreaterThan(runsAfterSeed)
    expect(api.fields('email').displayState).toBe('error')
  })

  // `.lazy` commits the model on `change`, which the browser fires before
  // `blur` when a changed input loses focus, so the committed value has landed
  // by blur time (asserted below) and that blur validates it. A following idle
  // reblur then skips, the value being unchanged.
  it('a .lazy commit validates on the same blur, then skips an idle reblur', async () => {
    const { api, input, runs } = mountCounted({ lazy: true })

    // Tab through once so a pass has run and recorded the current write
    // version. Without this baseline the first-ever blur would run regardless
    // (no version recorded yet), and the test couldn't tell a working commit
    // from a broken one.
    input.dispatchEvent(new FocusEvent('focus'))
    input.dispatchEvent(new FocusEvent('blur'))
    await settle()
    const runsAfterTabThrough = runs()

    // Edit a .lazy input and tab away: `change` commits the value (bumping the
    // write version) before `blur` fires, so the blur validates it.
    input.dispatchEvent(new FocusEvent('focus'))
    input.value = 'nope'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    expect(api.fields('email').value).toBe('nope')
    input.dispatchEvent(new FocusEvent('blur'))
    await settle()
    // The just-committed value was validated on this blur, not skipped.
    expect(runs()).toBeGreaterThan(runsAfterTabThrough)
    expect(api.fields('email').displayState).toBe('error')
    const runsAfterCommit = runs()

    // Refocus and leave without editing: no `change`, nothing committed, so
    // the form is unchanged and the guard skips the run.
    input.dispatchEvent(new FocusEvent('focus'))
    input.dispatchEvent(new FocusEvent('blur'))
    await settle()
    expect(runs()).toBe(runsAfterCommit)
    expect(api.fields('email').displayState).toBe('error')
  })
})
