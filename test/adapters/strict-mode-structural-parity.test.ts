/**
 * Structural-completeness parity between the adapters, at BOTH `strict`
 * settings.
 *
 * Every write is supposed to leave the form satisfying the slim schema,
 * and construction is the first such write: a `defaultValues` that
 * supplies a primitive where the schema declares an object has to be
 * repaired before the form mounts, or the runtime walks a shape its own
 * schema does not describe.
 *
 * v4 runs that repair inside `getDefaultValuesFromZodSchema`, so it
 * covers both modes. v3 ran it only in the lax tail, so STRICT mode —
 * which is the DEFAULT — skipped it entirely: `{ user: 'not-an-object' }`
 * stayed a string, and the strict parse then reported an error about a
 * shape the adapter was supposed to have fixed.
 *
 * The existing v3/v4 parity suites did not catch it because 19 of their
 * 27 cases pass `strict: false`, which is precisely the arm that
 * worked. So this file exists to cross the mode axis explicitly: every
 * case runs through both adapters at both settings and all four cells
 * must agree. A divergence is the finding, whichever side moved.
 */
import { describe, expect, it } from 'vitest'
import { z as z3 } from 'zod-v3'
import { z as z4 } from 'zod'
import { zodAdapter as v3Adapter } from '../../src/runtime/adapters/zod-v3'
import { zodV4Adapter } from '../../src/runtime/adapters/zod-v4/adapter'

type DefaultsResult = { data: unknown; success: boolean }
type Buildable = { getDefaultValues: (config: unknown) => DefaultsResult }

function defaultsFor(
  adapter: unknown,
  schema: unknown,
  constraints: unknown,
  strict: boolean
): DefaultsResult {
  const factory = adapter as (s: unknown) => (k: string, o: unknown) => Buildable
  return factory(schema)('parity', { maxRecursionDepth: 64 }).getDefaultValues({
    useDefaultSchemaValues: true,
    constraints,
    strict,
  })
}

/** One shape, declared once per major, with the constraint to feed it. */
const CASES: {
  name: string
  v3: unknown
  v4: unknown
  constraints: unknown
  expected: unknown
}[] = [
  {
    name: 'a primitive supplied where an object is declared',
    v3: z3.object({ user: z3.object({ name: z3.string(), age: z3.number() }) }),
    v4: z4.object({ user: z4.object({ name: z4.string(), age: z4.number() }) }),
    constraints: { user: 'not-an-object' },
    expected: { user: { name: '', age: 0 } },
  },
  {
    name: 'a primitive supplied where an array is declared',
    v3: z3.object({ tags: z3.array(z3.string()) }),
    v4: z4.object({ tags: z4.array(z4.string()) }),
    constraints: { tags: 7 },
    expected: { tags: [] },
  },
  {
    name: 'a wrong primitive type at a leaf',
    v3: z3.object({ name: z3.string() }),
    v4: z4.object({ name: z4.string() }),
    constraints: { name: 42 },
    expected: { name: '' },
  },
  {
    name: 'a partial object filled from the schema',
    v3: z3.object({ user: z3.object({ name: z3.string(), age: z3.number() }) }),
    v4: z4.object({ user: z4.object({ name: z4.string(), age: z4.number() }) }),
    constraints: { user: { name: 'ada' } },
    expected: { user: { name: 'ada', age: 0 } },
  },
  {
    name: 'a nested container two levels down',
    v3: z3.object({ a: z3.object({ b: z3.object({ c: z3.string() }) }) }),
    v4: z4.object({ a: z4.object({ b: z4.object({ c: z4.string() }) }) }),
    constraints: { a: { b: null } },
    expected: { a: { b: { c: '' } } },
  },
  {
    name: 'an object supplied where an array of objects is declared',
    v3: z3.object({ rows: z3.array(z3.object({ n: z3.number() })) }),
    v4: z4.object({ rows: z4.array(z4.object({ n: z4.number() })) }),
    constraints: { rows: { n: 1 } },
    expected: { rows: [] },
  },
  {
    name: 'a declared default survives a sibling being repaired',
    v3: z3.object({ kept: z3.string().default('keep'), user: z3.object({ n: z3.string() }) }),
    v4: z4.object({ kept: z4.string().default('keep'), user: z4.object({ n: z4.string() }) }),
    constraints: { user: 'wrong' },
    expected: { kept: 'keep', user: { n: '' } },
  },
  {
    name: 'a valid constraint is left alone (the counterweight)',
    v3: z3.object({ user: z3.object({ name: z3.string() }) }),
    v4: z4.object({ user: z4.object({ name: z4.string() }) }),
    constraints: { user: { name: 'ada' } },
    expected: { user: { name: 'ada' } },
  },
]

describe('construction repairs the same shapes in both adapters and both modes', () => {
  for (const { name, v3, v4, constraints, expected } of CASES) {
    it(name, () => {
      const cells = {
        'v3 strict': defaultsFor(v3Adapter, v3, constraints, true),
        'v3 lax': defaultsFor(v3Adapter, v3, constraints, false),
        'v4 strict': defaultsFor(zodV4Adapter, v4, constraints, true),
        'v4 lax': defaultsFor(zodV4Adapter, v4, constraints, false),
      }
      for (const [cell, result] of Object.entries(cells)) {
        expect(result.data, `${cell} produced the wrong shape`).toEqual(expected)
      }
    })
  }

  it('a repaired shape parses cleanly in strict mode, rather than reporting itself', () => {
    // The user-visible half. A form whose defaults were repaired must not
    // ALSO mount holding an error about the shape it just repaired.
    const constraints = { user: 'not-an-object' }
    expect(
      defaultsFor(v3Adapter, CASES[0]?.v3, constraints, true).success,
      'v3 strict reported an error about a shape it had repaired'
    ).toBe(true)
    expect(defaultsFor(zodV4Adapter, CASES[0]?.v4, constraints, true).success).toBe(true)
  })
})
