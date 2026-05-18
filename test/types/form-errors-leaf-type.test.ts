import { describe, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { useForm } from '../../src/zod-v4'
import type { ValidationError } from '../../src/runtime/types/types-api'

/**
 * Type-level regression for `form.errors.<leaf>`.
 *
 * Statically-known leaves must surface as `readonly ValidationError[]`.
 * The `| undefined` branch in `LeafSchemeFor.errors` is reserved for
 * dynamic-key boundaries (array indices, record keys) where the proxy
 * genuinely can't promise an array — never for leaves whose StorageShape
 * happens to be `unknown` (preprocess / coerce wrappers).
 *
 * Mirrors the consumer ergonomic where `form.errors.email.length` should
 * compile without an `if (form.errors.email)` guard at every read site.
 */

describe('form.errors.<leaf> stays non-optional at statically-known paths', () => {
  it('plain z.string() leaf: readonly ValidationError[] (regression guard)', () => {
    function _neverInvoked() {
      const form = useForm({
        schema: z.object({ email: z.string() }),
        key: 'form-errors-plain-string',
      })
      expectTypeOf(form.errors.email).toEqualTypeOf<readonly ValidationError[]>()
    }
    void _neverInvoked
  })

  it('z.preprocess(fn, inner) leaf: readonly ValidationError[]', () => {
    function _neverInvoked() {
      const form = useForm({
        schema: z.object({
          url: z.preprocess((v) => v, z.string()),
        }),
        key: 'form-errors-preprocess',
      })
      // StorageShape collapses to `unknown` here under the no-write-
      // mutation contract; the errors type must NOT widen with it.
      expectTypeOf(form.errors.url).toEqualTypeOf<readonly ValidationError[]>()
    }
    void _neverInvoked
  })

  it('z.coerce.X() leaf: readonly ValidationError[]', () => {
    function _neverInvoked() {
      const form = useForm({
        schema: z.object({ count: z.coerce.number() }),
        key: 'form-errors-coerce',
      })
      expectTypeOf(form.errors.count).toEqualTypeOf<readonly ValidationError[]>()
    }
    void _neverInvoked
  })

  it('z.preprocess wrapping a refined inner: readonly ValidationError[]', () => {
    function _neverInvoked() {
      const form = useForm({
        schema: z.object({
          url: z.preprocess(
            (v) => v,
            z.string().refine(() => true)
          ),
        }),
        key: 'form-errors-preprocess-with-refine',
      })
      expectTypeOf(form.errors.url).toEqualTypeOf<readonly ValidationError[]>()
    }
    void _neverInvoked
  })
})
