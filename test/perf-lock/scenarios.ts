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
 * writes + submit + reset — enough to lock value/dirty/touched, the
 * displayState reveal gate (hidden pre-submit, revealed after), validation
 * structure, and reset restoration. Arrays (S4, key identity) and
 * event-driven focus/blur land in later slices.
 *
 * Constraints honored: schemas use only `.min()` length constraints, which
 * are identical across zod v3/v4 (no `.email()` API drift).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { nextTick } from 'vue'
import { wait } from '../utils/form-harness'
import type { FormLike } from './capture'

/** The form API surface the drive scripts touch. */
export type DriveForm = FormLike & {
  setValue: (path: string, value: unknown) => boolean
  handleSubmit: (
    onSubmit: (data: unknown) => void,
    onError?: (errors: unknown) => void
  ) => (e: Event) => Promise<void>
  reset: (next?: unknown) => void
  touch: (path?: string) => void
}

export type Scenario = {
  id: string
  title: string
  makeSchema: (z: any) => unknown
  defaultValues: Record<string, unknown>
  fieldPaths: string[]
  drive: (form: DriveForm, snap: (label: string) => void) => Promise<void>
}

/** Cover the 0 ms validation debounce (setTimeout) + reactive flush. */
async function settle(): Promise<void> {
  await wait(20)
  await nextTick()
  await nextTick()
}

const noop = (): void => {}

export const SCENARIOS: Scenario[] = [
  {
    id: 's0-tiny',
    title: 'tiny — 5 flat scalars, depth 1',
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
    title: 'medium — nested objects, depth 2',
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
]
