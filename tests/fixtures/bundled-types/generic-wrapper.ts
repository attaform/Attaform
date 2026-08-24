/**
 * Bundled-types regression fixture for #422 — generic form wrappers, Zod v4
 * consumer. Imports by package name, resolved through the exports map
 * to the published `dist/*.d.mts`, NOT `src/*`, so it guards what a real consumer sees through `attaform/zod` (unified) and
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
import { useForm } from 'attaform/zod'
import { useForm as useFormV4 } from 'attaform/zod-v4'
import type { FlatPath, GenericForm, UseFormReturnType } from 'attaform'

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

  // Concrete rejection of a wrongly-typed default (and the intentional
  // widening) is asserted in `test/types/generic-wrapper-422.test.ts`. It is
  // deliberately NOT re-checked here: a bad default at the unified entry is a
  // TS2769 "no overload matches" whose error elaboration over both overloads
  // is heavy, and stacking several such elaborations in one fixture program
  // inflates instantiation depth artificially (a single such call in
  // isolation compiles fine). This fixture stays focused on its job — proving
  // the generic wrappers compile against the bundled `.d.ts` without TS2589.

  // ---- parse call forms under a free generic form (the autosave shape) ----
  // Both public shapes must resolve against the bundled overloads with the
  // path slot still generic: `parse(path, options)` and the lone options
  // bag. A regression here is exactly what a generic composable (autosave,
  // step guards) hits first.
  async function parseForms<Form extends GenericForm>(
    form: UseFormReturnType<Form>,
    path: FlatPath<Form>
  ) {
    await form.parse(path, { commit: true })
    await form.parse({ commit: true })
    await form.parse()
    await form.parse(path)
    return form
  }
  void parseForms

  return [unified, v4] as const
}

void _neverInvoked
