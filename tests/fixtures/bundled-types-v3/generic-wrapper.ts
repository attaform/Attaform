/**
 * Bundled-types regression fixture for #422 — generic form wrapper, Zod v3
 * consumer (single-major install). Compiled with `zod` remapped to a v3
 * install via the sibling tsconfig's `paths`, recreating what a consumer who
 * installs only `zod@3` sees through the bundled `.d.mts` of both the unified
 * `attaform/zod` entry and the direct `attaform/zod-v3` entry (whose bundled
 * output imports `z` from `'zod'`, i.e. the consumer's single major).
 *
 * Guards full v3 parity for the generic-wrapper fix: a helper that takes a
 * schema `S` and forwards `z.input<S>` as `defaultValues` must compile under
 * the bundled `.d.ts` (no TS2769 / TS2589) AND keep field inference. The
 * in-repo type test can't represent this — the repo installs both majors — so
 * this single-major fixture is the real v3 guard.
 *
 * `_neverInvoked` shapes call-site inference without a Vue app context.
 */
import { z } from 'zod' // remapped to a v3 install via tsconfig `paths`
import { useForm } from '../../../dist/zod'
import { useForm as useFormV3 } from '../../../dist/zod-v3'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

function _neverInvoked() {
  // ---- unified entry (attaform/zod) with a v3 schema ----
  function makeUnified<S extends z.ZodObject<z.ZodRawShape>>(schema: S, defaultValues: z.input<S>) {
    return useForm({ schema, key: 'v3-unified', defaultValues })
  }
  const unified = makeUnified(z.object({ urls: z.array(z.string()), name: z.string() }), {
    urls: [],
    name: '',
  })
  type _UUrls = Expect<Equal<typeof unified.values.urls, string[]>>
  type _UName = Expect<Equal<typeof unified.values.name, string>>

  // ---- v3-direct entry (attaform/zod-v3) ----
  function makeV3<S extends z.ZodObject<z.ZodRawShape>>(schema: S, defaultValues: z.input<S>) {
    return useFormV3({ schema, key: 'v3-direct', defaultValues })
  }
  const direct = makeV3(z.object({ email: z.string(), age: z.number() }), { email: '', age: 0 })
  type _DEmail = Expect<Equal<typeof direct.values.email, string>>
  type _DAge = Expect<Equal<typeof direct.values.age, number>>

  // ---- a wrongly-typed default is still rejected at concrete call sites ----
  // @ts-expect-error number is not assignable to the string input slot
  useForm({ schema: z.object({ name: z.string() }), key: 'v3-neg', defaultValues: { name: 1 } })
  // @ts-expect-error number is not assignable to the string input slot
  useFormV3({
    schema: z.object({ name: z.string() }),
    key: 'v3-neg-direct',
    defaultValues: { name: 1 },
  })

  return [unified, direct] as const
}

void _neverInvoked
