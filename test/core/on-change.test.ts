// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createFormStore } from '../../src/runtime/core/create-form-store'
import type { OnChangeContext } from '../../src/runtime/types/types-api'
import { fakeSchema } from '../utils/fake-schema'

type Form = {
  email: string
  password: string
  profile: { name: string; age: number }
}

const defaults: Form = {
  email: '',
  password: '',
  profile: { name: '', age: 0 },
}

function makeState(overrides?: { ssr?: boolean }) {
  return createFormStore<Form>({
    formKey: 'test',
    schema: fakeSchema<Form>(defaults),
    ssr: overrides?.ssr,
  })
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Capture each fire's (value, ctx) for assertions. */
function recorder() {
  const calls: { value: unknown; ctx: OnChangeContext }[] = []
  const handler = (value: unknown, ctx: OnChangeContext) => {
    calls.push({ value, ctx })
  }
  return { calls, handler }
}

const noForm = () => undefined

describe('form.onChange registry', () => {
  describe('matching', () => {
    it('fires once for a matching leaf write, with the new value and dotted ctx.path', () => {
      const state = makeState()
      const { calls, handler } = recorder()
      state.registerOnChange('email', handler, undefined, noForm)

      state.setValueAtPath(['email'], 'a@b.c')

      expect(calls).toHaveLength(1)
      expect(calls[0]?.value).toBe('a@b.c')
      expect(calls[0]?.ctx.path).toBe('email')
      expect(calls[0]?.ctx.changed).toEqual(['email'])
      expect(calls[0]?.ctx.attempt).toBe(0)
    })

    it('an ancestor source fires on a descendant write (prefix match downward)', () => {
      const state = makeState()
      const { calls, handler } = recorder()
      state.registerOnChange('profile', handler, undefined, noForm)

      state.setValueAtPath(['profile', 'name'], 'Ada')

      expect(calls).toHaveLength(1)
      expect(calls[0]?.value).toEqual({ name: 'Ada', age: 0 })
      expect(calls[0]?.ctx.path).toBe('profile')
      expect(calls[0]?.ctx.changed).toEqual(['profile.name'])
    })

    it('a descendant source fires on a whole-container write (prefix match upward)', () => {
      const state = makeState()
      const { calls, handler } = recorder()
      state.registerOnChange('profile.name', handler, undefined, noForm)

      state.setValueAtPath(['profile'], { name: 'Bo', age: 5 })

      expect(calls).toHaveLength(1)
      expect(calls[0]?.value).toBe('Bo')
      expect(calls[0]?.ctx.path).toBe('profile.name')
    })

    it('a root handler (no source) fires on any write, ctx.path is the empty string', () => {
      const state = makeState()
      const { calls, handler } = recorder()
      state.registerOnChange(undefined, handler, undefined, noForm)

      state.setValueAtPath(['email'], 'x')

      expect(calls).toHaveLength(1)
      expect(calls[0]?.ctx.path).toBe('')
      expect(calls[0]?.ctx.changed).toEqual(['email'])
      expect((calls[0]?.value as Form).email).toBe('x')
    })

    it('a multi-path source fires once per matched path, distinguished by ctx.path', () => {
      const state = makeState()
      const { calls, handler } = recorder()
      state.registerOnChange(['email', 'password'], handler, undefined, noForm)

      // One whole-form write that changes both listed paths.
      state.setValueAtPath([], { email: 'a', password: 'b', profile: { name: '', age: 0 } })

      expect(calls).toHaveLength(2)
      expect(calls.map((c) => c.ctx.path)).toEqual(['email', 'password'])
      expect(calls.map((c) => c.value)).toEqual(['a', 'b'])
    })

    it('an empty-list source never fires (it lists zero paths)', () => {
      const state = makeState()
      const { calls, handler } = recorder()
      state.registerOnChange([], handler, undefined, noForm)

      state.setValueAtPath(['email'], 'x')

      expect(calls).toHaveLength(0)
    })

    it('a non-matching write does not fire', () => {
      const state = makeState()
      const { calls, handler } = recorder()
      state.registerOnChange('email', handler, undefined, noForm)

      state.setValueAtPath(['password'], 'secret')

      expect(calls).toHaveLength(0)
    })

    it('a no-op write fires nothing (value-equality dedup is free)', () => {
      const state = makeState()
      const { calls, handler } = recorder()
      state.registerOnChange('email', handler, undefined, noForm)

      // email is already '' — no patch is emitted, so no dispatch.
      state.setValueAtPath(['email'], '')

      expect(calls).toHaveLength(0)
    })
  })

  describe('previous', () => {
    it('reports the prior leaf value across edits, seeded at registration', () => {
      const state = makeState()
      const { calls, handler } = recorder()
      state.registerOnChange('email', handler, undefined, noForm)

      state.setValueAtPath(['email'], 'a')
      state.setValueAtPath(['email'], 'b')

      expect(calls).toHaveLength(2)
      expect(calls[0]?.ctx.previous).toBe('')
      expect(calls[1]?.ctx.previous).toBe('a')
    })

    it('for a container source, an in-place leaf edit leaves previous reference-equal to current (the documented gotcha)', () => {
      const state = makeState()
      const { calls, handler } = recorder()
      state.registerOnChange('profile', handler, undefined, noForm)

      state.setValueAtPath(['profile', 'name'], 'Ada')

      expect(calls).toHaveLength(1)
      // The container's identity is preserved by the in-place leaf write, so
      // previous and value are the same mutated object.
      expect(calls[0]?.ctx.previous).toBe(calls[0]?.value)
    })
  })

  describe('suppression: edits, not rebaselines', () => {
    it.each(['hydration', 'silent'] as const)('meta.%s suppresses dispatch', (flag) => {
      const state = makeState()
      const { calls, handler } = recorder()
      state.registerOnChange('email', handler, undefined, noForm)

      state.setValueAtPath(['email'], 'x', { [flag]: true })
      expect(calls).toHaveLength(0)

      // A plain edit afterwards still fires.
      state.setValueAtPath(['email'], 'y')
      expect(calls).toHaveLength(1)
    })

    it('reset() does not fire onChange (it rebaselines, not edits)', () => {
      const state = makeState()
      const { calls, handler } = recorder()
      state.registerOnChange('email', handler, undefined, noForm)

      state.setValueAtPath(['email'], 'x')
      expect(calls).toHaveLength(1)

      state.reset()
      // The reset reverts email to '' — a real value change — but it is
      // tagged silent, so no second fire.
      expect(calls).toHaveLength(1)
    })
  })

  describe('SSR', () => {
    it('registration is a no-op and returns a callable stop', () => {
      const state = makeState({ ssr: true })
      const { calls, handler } = recorder()
      const stop = state.registerOnChange('email', handler, undefined, noForm)

      state.setValueAtPath(['email'], 'x')

      expect(calls).toHaveLength(0)
      expect(() => stop()).not.toThrow()
    })
  })

  describe('cleanup', () => {
    it('stop() removes the handler and is idempotent', () => {
      const state = makeState()
      const { calls, handler } = recorder()
      const stop = state.registerOnChange('email', handler, undefined, noForm)

      state.setValueAtPath(['email'], 'a')
      expect(calls).toHaveLength(1)

      stop()
      stop() // idempotent — no throw, no double-effect
      state.setValueAtPath(['email'], 'b')
      expect(calls).toHaveLength(1)
    })

    it('dispose() drops all handlers', () => {
      const state = makeState()
      const { calls, handler } = recorder()
      state.registerOnChange('email', handler, undefined, noForm)

      state.dispose()
      state.setValueAtPath(['email'], 'a')

      expect(calls).toHaveLength(0)
    })
  })

  describe('ctx.form', () => {
    it('resolves the handle from getForm', () => {
      const state = makeState()
      const sentinel = { iAm: 'the form handle' }
      let seen: unknown
      state.registerOnChange(
        'email',
        (_value, ctx) => {
          seen = ctx.form
        },
        undefined,
        () => sentinel
      )

      state.setValueAtPath(['email'], 'x')

      expect(seen).toBe(sentinel)
    })
  })

  describe('dynamic sources', () => {
    it('a getter source is resolved on each dispatch', () => {
      const state = makeState()
      const { calls, handler } = recorder()
      let aim = 'email'
      state.registerOnChange(() => aim, handler, undefined, noForm)

      state.setValueAtPath(['email'], 'a')
      expect(calls).toHaveLength(1)
      expect(calls[0]?.ctx.path).toBe('email')

      // A write to password does not match while the getter aims at email.
      state.setValueAtPath(['password'], 'p')
      expect(calls).toHaveLength(1)

      // Re-aim. The next write to password now matches.
      aim = 'password'
      state.setValueAtPath(['password'], 'p2')
      expect(calls).toHaveLength(2)
      expect(calls[1]?.ctx.path).toBe('password')
    })

    it('a source getter that throws is isolated — the write and sibling handlers survive', () => {
      const state = makeState()
      const sibling = recorder()
      state.registerOnChange(
        () => {
          throw new Error('bad source')
        },
        () => {
          throw new Error('should never run')
        },
        undefined,
        noForm
      )
      state.registerOnChange('email', sibling.handler, undefined, noForm)

      expect(() => state.setValueAtPath(['email'], 'x')).not.toThrow()
      expect(sibling.calls).toHaveLength(1)
    })
  })

  describe('errors never escape the write', () => {
    it('a synchronous throw routes to onError, not into setValue', () => {
      const state = makeState()
      const onError = vi.fn()
      const boom = new Error('boom')
      state.registerOnChange(
        'email',
        () => {
          throw boom
        },
        { onError },
        noForm
      )

      const wrote = state.setValueAtPath(['email'], 'x')

      expect(wrote).toBe(true)
      expect(state.form.value.email).toBe('x')
      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError.mock.calls[0]?.[0]).toBe(boom)
      expect(onError.mock.calls[0]?.[1]).toMatchObject({ path: 'email', value: 'x', attempt: 0 })
    })

    it('a synchronous throw with no onError is swallowed (write still succeeds)', () => {
      const state = makeState()
      state.registerOnChange(
        'email',
        () => {
          throw new Error('boom')
        },
        undefined,
        noForm
      )

      expect(() => state.setValueAtPath(['email'], 'x')).not.toThrow()
      expect(state.form.value.email).toBe('x')
    })

    it('an async rejection routes to onError on the live run', async () => {
      const state = makeState()
      const onError = vi.fn()
      const boom = new Error('async boom')
      state.registerOnChange('email', () => Promise.reject(boom), { onError }, noForm)

      state.setValueAtPath(['email'], 'x')
      await flush()

      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError.mock.calls[0]?.[0]).toBe(boom)
    })

    it('onError.retry() re-runs with attempt + 1', () => {
      const state = makeState()
      let runs = 0
      const seenAttempts: number[] = []
      state.registerOnChange(
        'email',
        (_value, ctx) => {
          runs += 1
          seenAttempts.push(ctx.attempt)
          if (runs === 1) throw new Error('first attempt fails')
        },
        {
          onError: (_err, ctx) => {
            if (ctx.attempt === 0) ctx.retry()
          },
        },
        noForm
      )

      state.setValueAtPath(['email'], 'x')

      expect(runs).toBe(2)
      expect(seenAttempts).toEqual([0, 1])
    })
  })

  describe('concurrency: latest write wins per (handler, source path)', () => {
    it('a newer write aborts the prior run’s signal', () => {
      const state = makeState()
      const signals: AbortSignal[] = []
      state.registerOnChange(
        'email',
        (_value, ctx) => {
          signals.push(ctx.signal)
          return new Promise<void>(() => {}) // never settles: stands in for an in-flight save
        },
        undefined,
        noForm
      )

      state.setValueAtPath(['email'], 'a')
      state.setValueAtPath(['email'], 'b')

      expect(signals).toHaveLength(2)
      expect(signals[0]?.aborted).toBe(true)
      expect(signals[1]?.aborted).toBe(false)
    })

    it('a superseded run’s rejection is dropped; only the live run reaches onError', async () => {
      const state = makeState()
      const onError = vi.fn()
      const rejects: ((reason: unknown) => void)[] = []
      state.registerOnChange(
        'email',
        () => new Promise<void>((_resolve, reject) => rejects.push(reject)),
        { onError },
        noForm
      )

      state.setValueAtPath(['email'], 'a') // run 1
      state.setValueAtPath(['email'], 'b') // run 2 supersedes run 1

      // Run 1 rejects late — it was superseded, so its failure is dropped.
      rejects[0]?.(new Error('stale'))
      await flush()
      expect(onError).not.toHaveBeenCalled()

      // Run 2 rejects — it is live, so onError fires once.
      rejects[1]?.(new Error('live'))
      await flush()
      expect(onError).toHaveBeenCalledTimes(1)
      expect((onError.mock.calls[0]?.[0] as Error).message).toBe('live')
    })
  })
})
