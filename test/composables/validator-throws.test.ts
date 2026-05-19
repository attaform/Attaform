// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, type App } from 'vue'
import { z } from 'zod'
import { useForm } from '../../src/zod'
import { createAttaform } from '../../src/runtime/core/plugin'
import { AttaformErrorCode } from '../../src/runtime/core/error-codes'
import type { ValidationError } from '../../src/runtime/types/types-api'

/**
 * Pin Zod's "catch throws and convert to issues" contract for the
 * three user-code surfaces inside a parse: `z.preprocess`, `.refine`,
 * and `.transform`. A throw inside any of them must NOT propagate as
 * an uncaught exception. It must surface as a `ValidationError` at
 * the field path so the consumer sees a normal-shaped error rather
 * than an unhandled rejection.
 *
 * The behavior is inherited from Zod's `safeParseAsync` contract, not
 * implemented by Attaform directly, so these tests guard against a
 * Zod-release regression as much as an Attaform one. If Zod ever
 * changes how `safeParseAsync` handles throws, this file goes red and
 * we notice on the next test run.
 *
 * Submit-side contract: a throw at any of these three surfaces leaves
 * `handleSubmit` on its "validation failed" path. `onSubmit` is not
 * called; `onError` is invoked with the error array; the form's
 * `submitError` ref stays null (only callback-thrown errors land
 * there, not validation-side ones).
 */

function mountForm<R>(setup: () => R): { api: R; unmount: () => void } {
  let captured: R | undefined
  const App = defineComponent({
    setup() {
      captured = setup()
      return () => h('div')
    },
  })
  const app = createApp(App).use(createAttaform())
  app.mount(document.createElement('div'))
  return { api: captured as R, unmount: () => app.unmount() }
}

function uniqueKey(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`
}

const apps: App[] = []
afterEach(() => {
  while (apps.length > 0) apps.pop()?.unmount()
})

describe('user-code throws inside preprocess', () => {
  it('sync throw surfaces as a ValidationError, not an uncaught exception', async () => {
    const schema = z.object({
      name: z.preprocess(() => {
        throw new Error('preprocess sync boom')
      }, z.string()),
    })
    const { api } = mountForm(() =>
      useForm({
        schema,
        key: uniqueKey('preproc-sync-throw'),
        defaultValues: { name: 'whatever' },
      })
    )

    const onSubmit = vi.fn()
    const onError = vi.fn<(errors: readonly ValidationError[]) => void>()
    await api.handleSubmit(onSubmit, onError)()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(api.meta.submitError).toBeNull()
    const errors = onError.mock.calls[0]?.[0] ?? []
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.code).toBe(AttaformErrorCode.ValidatorThrew)
  })

  it('async throw surfaces as a ValidationError, not a rejected promise', async () => {
    const schema = z.object({
      name: z.preprocess(async () => {
        throw new Error('preprocess async boom')
      }, z.string()),
    })
    const { api } = mountForm(() =>
      useForm({
        schema,
        key: uniqueKey('preproc-async-throw'),
        defaultValues: { name: 'whatever' },
      })
    )

    const onSubmit = vi.fn()
    const onError = vi.fn<(errors: readonly ValidationError[]) => void>()
    await api.handleSubmit(onSubmit, onError)()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(api.meta.submitError).toBeNull()
    const errors = onError.mock.calls[0]?.[0] ?? []
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.code).toBe(AttaformErrorCode.ValidatorThrew)
  })
})

describe('user-code throws inside .refine', () => {
  it('sync throw surfaces as a ValidationError, not an uncaught exception', async () => {
    const schema = z.object({
      name: z.string().refine(() => {
        throw new Error('refine sync boom')
      }, 'unreachable'),
    })
    const { api } = mountForm(() =>
      useForm({
        schema,
        key: uniqueKey('refine-sync-throw'),
        defaultValues: { name: 'whatever' },
      })
    )

    const onSubmit = vi.fn()
    const onError = vi.fn<(errors: readonly ValidationError[]) => void>()
    await api.handleSubmit(onSubmit, onError)()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(api.meta.submitError).toBeNull()
    const errors = onError.mock.calls[0]?.[0] ?? []
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.code).toBe(AttaformErrorCode.ValidatorThrew)
  })

  it('async throw surfaces as a ValidationError, not a rejected promise', async () => {
    const schema = z.object({
      name: z.string().refine(async () => {
        throw new Error('refine async boom')
      }, 'unreachable'),
    })
    const { api } = mountForm(() =>
      useForm({
        schema,
        key: uniqueKey('refine-async-throw'),
        defaultValues: { name: 'whatever' },
      })
    )

    const onSubmit = vi.fn()
    const onError = vi.fn<(errors: readonly ValidationError[]) => void>()
    await api.handleSubmit(onSubmit, onError)()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(api.meta.submitError).toBeNull()
    const errors = onError.mock.calls[0]?.[0] ?? []
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.code).toBe(AttaformErrorCode.ValidatorThrew)
  })
})

describe('user-code throws inside .transform', () => {
  it('sync throw surfaces as a ValidationError, not an uncaught exception', async () => {
    const schema = z.object({
      name: z.string().transform(() => {
        throw new Error('transform sync boom')
      }),
    })
    const { api } = mountForm(() =>
      useForm({
        schema,
        key: uniqueKey('transform-sync-throw'),
        defaultValues: { name: 'whatever' },
      })
    )

    const onSubmit = vi.fn()
    const onError = vi.fn<(errors: readonly ValidationError[]) => void>()
    await api.handleSubmit(onSubmit, onError)()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(api.meta.submitError).toBeNull()
    const errors = onError.mock.calls[0]?.[0] ?? []
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.code).toBe(AttaformErrorCode.ValidatorThrew)
  })

  it('async throw surfaces as a ValidationError, not a rejected promise', async () => {
    const schema = z.object({
      name: z.string().transform(async () => {
        throw new Error('transform async boom')
      }),
    })
    const { api } = mountForm(() =>
      useForm({
        schema,
        key: uniqueKey('transform-async-throw'),
        defaultValues: { name: 'whatever' },
      })
    )

    const onSubmit = vi.fn()
    const onError = vi.fn<(errors: readonly ValidationError[]) => void>()
    await api.handleSubmit(onSubmit, onError)()

    expect(onSubmit).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(api.meta.submitError).toBeNull()
    const errors = onError.mock.calls[0]?.[0] ?? []
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.code).toBe(AttaformErrorCode.ValidatorThrew)
  })
})
