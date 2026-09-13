import { describe, expectTypeOf, it } from 'vitest'
import { z as z4 } from 'zod'
import { z as z3 } from 'zod-v3'
import { useForm as useFormV4 } from '../../src/zod-v4'
import { useForm as useFormV3 } from '../../src/zod-v3'
import type {
  SegmentPathRejection,
  SegmentRegisterRejection,
} from '../../src/runtime/types/types-core'

/**
 * Standing pin for paths whose segments are only known at runtime.
 *
 * #568 reported a `z.record` segment typing as `never` in `register()`.
 * It does not, and did not on the reported version: a record
 * contributes `${string}` to the path union, so a dynamic key is
 * accepted everywhere a path is. What actually failed was an opaque
 * `string` PREFIX, which rejects a path with no record in it just as
 * hard. Both halves are pinned below, because the report is only
 * answered for as long as both stay true.
 *
 * The last block pins the rejection MESSAGES. Those are the observable
 * surface #568 asked for ("a clearer message than `never`"), so a
 * reworded diagnostic should be a deliberate edit here rather than a
 * silent drift.
 *
 * Compile-time only; `pnpm typecheck` is the gate. The `_neverInvoked`
 * wrappers declare real `useForm` calls so inference runs at the call
 * site, but nothing is invoked, so no Vue app context is needed.
 * `tests/fixtures/bundled-types/dynamic-paths.ts` pins the same matrix
 * against the published `.d.ts`.
 */

const schemaV4 = z4.object({
  boxes: z4
    .array(
      z4.object({
        choice: z4.string(),
        pairs: z4.record(z4.string(), z4.string()).default({}),
      })
    )
    .default([]),
  prefs: z4.record(z4.string(), z4.boolean()).default({}),
})

const schemaV3 = z3.object({
  boxes: z3
    .array(
      z3.object({
        choice: z3.string(),
        pairs: z3.record(z3.string(), z3.string()).default({}),
      })
    )
    .default([]),
  prefs: z3.record(z3.string(), z3.boolean()).default({}),
})

declare const token: string
declare const index: number
declare const opaquePath: string

type RowPath = `boxes.${number}`
declare const rowPath: RowPath

describe('dynamic path segments (#568)', () => {
  describe('zod v4', () => {
    it('accepts a dynamic record key on every path-addressed API', () => {
      function _neverInvoked() {
        const form = useFormV4({ schema: schemaV4, key: 'dyn-v4' })
        form.register(`prefs.${token}`)
        form.setValue(`prefs.${token}`, true)
        form.toRef(`prefs.${token}`)
        form.clear(`prefs.${token}`)
        form.fields(`prefs.${token}`)
        form.errors(`prefs.${token}`)
      }
      void _neverInvoked
    })

    it('accepts a dynamic index and a dynamic key together', () => {
      function _neverInvoked() {
        const form = useFormV4({ schema: schemaV4, key: 'dyn-v4' })
        form.register(`boxes.${index}.choice`)
        form.register(`boxes.${index}.pairs.${token}`)
        form.setValue(`boxes.${index}.pairs.${token}`, 'X')
      }
      void _neverInvoked
    })

    it('accepts the segment-array spelling of the same paths', () => {
      function _neverInvoked() {
        const form = useFormV4({ schema: schemaV4, key: 'dyn-v4' })
        form.register(['prefs', token])
        form.register(['boxes', index, 'choice'])
        form.register(['boxes', index, 'pairs', token])
        form.setValue(['boxes', index, 'pairs', token], 'X')
        form.toRef(['boxes', index, 'pairs', token])
        form.clear(['boxes', index, 'pairs', token])
      }
      void _neverInvoked
    })

    it('keeps a typed prefix checkable through interpolation', () => {
      function _neverInvoked() {
        const form = useFormV4({ schema: schemaV4, key: 'dyn-v4' })
        form.register(`${rowPath}.choice`)
        form.register(`${rowPath}.pairs.${token}`)
        form.setValue(`${rowPath}.choice`, 'X')
      }
      void _neverInvoked
    })

    it('rejects on the prefix, not on the record', () => {
      function _neverInvoked() {
        const form = useFormV4({ schema: schemaV4, key: 'dyn-v4' })
        // @ts-expect-error an opaque `string` prefix cannot be checked.
        // No record in this path: the record was never the cause.
        form.register(`${opaquePath}.choice`)
        // @ts-expect-error same rejection with a record segment on the end
        form.register(`${opaquePath}.pairs.${token}`)
        // @ts-expect-error `pair` is not a key of the row
        form.register(`boxes.${index}.pair.${token}`)
        // @ts-expect-error a container is addressable, not registrable
        form.register(['boxes', index])
        // @ts-expect-error the segment array is checked like the dotted form
        form.register(['boxes', index, 'nope'])
      }
      void _neverInvoked
    })
  })

  describe('zod v3', () => {
    it('accepts a dynamic record key on every path-addressed API', () => {
      function _neverInvoked() {
        const form = useFormV3({ schema: schemaV3, key: 'dyn-v3' })
        form.register(`prefs.${token}`)
        form.setValue(`prefs.${token}`, true)
        form.toRef(`prefs.${token}`)
        form.clear(`prefs.${token}`)
        form.fields(`prefs.${token}`)
        form.errors(`prefs.${token}`)
      }
      void _neverInvoked
    })

    it('accepts a dynamic index, a dynamic key, and both spellings', () => {
      function _neverInvoked() {
        const form = useFormV3({ schema: schemaV3, key: 'dyn-v3' })
        form.register(`boxes.${index}.pairs.${token}`)
        form.register(['boxes', index, 'pairs', token])
        form.setValue(`boxes.${index}.pairs.${token}`, 'X')
      }
      void _neverInvoked
    })

    it('keeps a typed prefix checkable through interpolation', () => {
      function _neverInvoked() {
        const form = useFormV3({ schema: schemaV3, key: 'dyn-v3' })
        form.register(`${rowPath}.choice`)
        form.register(`${rowPath}.pairs.${token}`)
      }
      void _neverInvoked
    })

    it('rejects on the prefix, not on the record', () => {
      function _neverInvoked() {
        const form = useFormV3({ schema: schemaV3, key: 'dyn-v3' })
        // @ts-expect-error an opaque `string` prefix cannot be checked
        form.register(`${opaquePath}.choice`)
        // @ts-expect-error a container is addressable, not registrable
        form.register(['boxes', index])
      }
      void _neverInvoked
    })
  })

  describe('rejection messages', () => {
    it('names the joined path when the segment array inferred', () => {
      expectTypeOf<
        SegmentPathRejection<'boxes.0.nope'>
      >().toEqualTypeOf<"attaform: 'boxes.0.nope' is not a path in this form's schema">()
      expectTypeOf<
        SegmentRegisterRejection<'boxes.0'>
      >().toEqualTypeOf<"attaform: 'boxes.0' is not a registrable path. v-register binds a leaf input, so container paths are excluded.">()
    })

    it('advises instead of naming a path when nothing inferred', () => {
      // A plain `string` argument never infers a tuple, so `JoinSegments`
      // is `''`. Naming a path there would be a fiction.
      expectTypeOf<
        SegmentPathRejection<''>
      >().toEqualTypeOf<'attaform: a plain string cannot be checked against the schema. Pass a literal path, type the dynamic prefix, or use the segment-array form.'>()
      expectTypeOf<SegmentRegisterRejection<''>>().toEqualTypeOf<SegmentPathRejection<''>>()
    })
  })
})
