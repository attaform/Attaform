import { fc, test } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { z } from 'zod'
import { zodAdapter } from '../../../src/runtime/adapters/zod-v4'
import { buildZodRootObjectArbitrary } from '../../utils/zod-arbitraries'

/**
 * Property tests: the v4 adapter is total and consistent over arbitrary
 * supported schemas. Depth is capped at 3 (so the largest generated tree
 * has three layers of containers below the root ZodObject) to keep runs
 * cheap while still exercising every wrapper / container combination.
 *
 * numRuns defaults to fast-check's 100: the schema arbitrary is a
 * reasonable mix of leaves vs. containers, so 100 samples exercise each
 * shape. If these tests become a pain point in CI wall-time, drop to 50.
 */

const arbRootSchema = buildZodRootObjectArbitrary(z, 3, (inner) => z.record(z.string(), inner))

describe('zod v4 adapter: fuzz over arbitrary supported schemas', () => {
  test.prop([arbRootSchema])('adapter construction never throws on supported schemas', (schema) => {
    expect(() => zodAdapter(schema as z.ZodObject)('f', { maxRecursionDepth: 64 })).not.toThrow()
  })

  test.prop([arbRootSchema])(
    'getDefaultValues derives a value that validateSync passes',
    (schema) => {
      const adapter = zodAdapter(schema as z.ZodObject)('f', { maxRecursionDepth: 64 })
      const data = adapter.getDefaultValues({
        useDefaultSchemaValues: true,
      })
      // A keyed root derives an object: assert on shape instead of mere
      // existence.
      expect(typeof data).toBe('object')
      expect(adapter.validateSync(data)).toEqual([])
    }
  )

  test.prop([arbRootSchema])(
    'validateAtPath(defaultValues, undefined) passes in lax mode',
    async (schema) => {
      // Lax mode round-trip: the shape the adapter derives for defaults
      // must validate against the slimmed (refinement-stripped) schema.
      // Since the arbitrary doesn't produce refinements, this reduces to
      // "does the shape match the shape", any failure is a bug in the
      // default-values derivation.
      const adapter = zodAdapter(schema as z.ZodObject)('f', { maxRecursionDepth: 64 })
      const initial = adapter.getDefaultValues({
        useDefaultSchemaValues: true,
      })
      expect(adapter.validateSync(initial)).toEqual([])
      const validation = await adapter.validateAtPath(initial, undefined)
      expect(validation.success).toBe(true)
    }
  )

  test.prop([arbRootSchema, fc.string({ minLength: 1, maxLength: 8 })])(
    'the verdict is a pure function of the schema, not of which form asked',
    (schema, formKey) => {
      // The property that lets ONE AbstractSchema serve every form built
      // on a schema: the key the caller happens to carry changes nothing
      // about the answer. The owning store stamps its own `formKey` on
      // the way out; the schema never sees one.
      const built = zodAdapter(schema as z.ZodObject)
      const config = { useDefaultSchemaValues: true } as const
      const mySchema = built(formKey, { maxRecursionDepth: 64 })
      const theirSchema = built('some-other-form', { maxRecursionDepth: 64 })
      const myData = mySchema.getDefaultValues(config)
      const theirData = theirSchema.getDefaultValues(config)
      expect(myData).toEqual(theirData)
      const myErrors = mySchema.validateSync(myData)
      expect(myErrors).toEqual(theirSchema.validateSync(theirData))
      for (const err of myErrors) {
        expect(typeof err.code).toBe('string')
      }
    }
  )
})
