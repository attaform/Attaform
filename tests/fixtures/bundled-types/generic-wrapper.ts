/**
 * Bundled-types regression fixture for #422 — generic form wrappers, Zod v4
 * consumer. Imports from `dist/*` (the published artifact shape), NOT `src/*`,
 * so it guards what a real consumer sees through `attaform/zod` (unified) and
 * `attaform/zod-v4` (direct). The companion `bundled-types-v3/generic-wrapper.ts`
 * covers the Zod v3 path (unified + v3-direct) under a single-major install.
 *
 * Scenario: the natural way to share form plumbing — a generic helper that
 * takes a schema `S` and forwards a schema-derived `defaultValues`. Before the
 * fix this tripped TS2769 ("no overload matches") / TS2589 ("excessively
 * deep") because the `defaultValues` slot was a `DefaultValuesInput`
 * conditional cascade TS cannot relate to a free `S`. The `AcceptableDefaults`
 * slot now carries the schema's own input as a reflexive escape arm.
 *
 * Inference is asserted with strict `Equal`, so a regression to `never` /
 * `any` fails. `_neverInvoked` shapes call-site inference without a Vue app
 * context.
 */
import { z } from 'zod'
import { useForm } from '../../../dist/zod'
import { useForm as useFormV4 } from '../../../dist/zod-v4'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

function _neverInvoked() {
  // ---- unified entry (attaform/zod), Zod v4 schema ----
  function makeUnified<S extends z.ZodObject<z.ZodRawShape>>(schema: S, defaultValues: z.input<S>) {
    return useForm({ schema, key: 'unified', defaultValues })
  }
  const unified = makeUnified(z.object({ email: z.string(), age: z.number() }), {
    email: '',
    age: 0,
  })
  type _UEmail = Expect<Equal<typeof unified.values.email, string>>
  type _UAge = Expect<Equal<typeof unified.values.age, number>>

  // ---- v4-direct entry (attaform/zod-v4) ----
  function makeV4<S extends z.ZodObject<z.ZodRawShape>>(schema: S, defaultValues: z.input<S>) {
    return useFormV4({ schema, key: 'v4', defaultValues })
  }
  const v4 = makeV4(z.object({ name: z.string() }), { name: '' })
  type _V4Name = Expect<Equal<typeof v4.values.name, string>>

  // ---- forwarding a defaultValues factory through a generic wrapper ----
  function makeFactory<S extends z.ZodObject<z.ZodRawShape>>(
    schema: S,
    defaults: () => z.input<S>
  ) {
    return useForm({ schema, key: 'factory', defaultValues: defaults })
  }
  void makeFactory

  // ---- concrete call sites still reject a wrongly-typed default ----
  // @ts-expect-error number is not assignable to the string input slot
  useFormV4({ schema: z.object({ email: z.string() }), key: 'neg-v4', defaultValues: { email: 1 } })
  // @ts-expect-error number is not assignable to the string input slot
  useForm({
    schema: z.object({ email: z.string() }),
    key: 'neg-unified',
    defaultValues: { email: 1 },
  })

  return [unified, v4] as const
}

void _neverInvoked
