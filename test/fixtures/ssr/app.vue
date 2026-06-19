<script setup lang="ts">
  import { useForm } from '@runtime/composables/use-form'
  // The SSR fixture exercises the zod v3 adapter via useForm auto-import.
  // Installed side-by-side with zod v4 via pnpm alias.
  import { z } from 'zod-v3'
  import AriaWrapper from './AriaWrapper.vue'

  const schema = z.object({
    favoriteGame: z.string().default('chess'),
    chessInArray: z.array(z.string()).default(['chess']),
    // Repros the schema-to-inputs demo's country pattern: a schema-level
    // default chained AFTER a refine. The SSR-time transform must still
    // emit a `selected` attribute on the option matching the default
    // value, even though the schema chain wraps `.default()` inside a
    // `.refine()`.
    refinedDefault: z
      .string()
      .default('JP')
      .refine((v) => v.length === 2, 'must be a 2-letter code'),
  })
  const { register } = useForm({ schema, key: 'ssr-select-fixture' })

  // -- Error API SSR fixtures --
  // Destructured at setup level so the refs become top-level template
  // bindings (Vue auto-unwraps top-level refs but not refs nested in plain
  // objects, so `directErrorForm.errors.value` would not unwrap reliably).

  // Direct setErrors on the server, rendered into HTML so the SSR test
  // can prove the reactive error store survives serialisation/hydration.
  const directErrorSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
  })
  const directForm = useForm({
    schema: directErrorSchema,
    key: 'errors-direct',
    // Pin lax: this fixture proves user-injected errors render across
    // the SSR boundary. Strict-mode default would also seed schema
    // errors from the empty defaults, displacing the user-injected
    // entries at errors[0] (schema-first ordering). The schema is two
    // strings — neither auto-marks blank, so `derivedBlankErrors`
    // stays empty and the user-injected entries are the only thing
    // appearing at errors[0].
    strict: false,
  })
  directForm.setErrors([
    {
      message: 'Email already in use',
      path: ['email'],
      formKey: 'errors-direct',
      code: 'api:duplicate-email',
    },
    {
      message: 'Password must be at least 8 characters',
      path: ['password'],
      formKey: 'errors-direct',
      code: 'api:password-too-short',
    },
  ])

  // A server 422 mapped onto fields before the page renders: the
  // server's ValidationError[] hands straight to setErrors, two entries
  // at the same `username` path.
  const apiErrorForm = useForm({
    schema: z.object({ username: z.string() }),
    key: 'errors-from-api',
  })
  apiErrorForm.setErrors([
    { message: 'Username taken', path: ['username'], code: 'api:duplicate-username' },
    { message: 'Reserved word', path: ['username'], code: 'api:reserved-word' },
  ])

  // -- handleSubmit return-shape fixture --
  // Proves handleSubmit(cb) returns a function (not a Promise) so it can be
  // bound directly to a form's @submit handler without a wrapper.
  const submitForm = useForm({
    schema: z.object({ name: z.string().min(1) }),
    key: 'submit-shape',
  })
  const submitHandler = submitForm.handleSubmit(() => {})
  const submitHandlerType = typeof submitHandler

  // -- Hydration round-trip fixture --
  // Server writes a value into form state during setup; the value must
  // appear in the rendered HTML *and* serialise into the `__NUXT__` payload
  // so the client-side registry reconstructs the state. Phase 7.9 test.
  const hydrationForm = useForm({
    schema: z.object({ hydratedField: z.string() }),
    key: 'hydration-check',
  })
  hydrationForm.setValue('hydratedField', 'server-written-value')

  // -- autoAria component-host fixture (#404) --
  // A required field rendered through a presentational wrapper component.
  // The wrapper's root <div> must NOT carry aria-required (invalid ARIA on
  // a role-less element); the inner <input> the wrapper re-binds via
  // useRegister carries it. Exercises the compiled-SSR null-vnode path.
  const ariaHostForm = useForm({
    schema: z.object({ email: z.string().min(1) }),
    key: 'aria-host',
  })
</script>

<template>
  <div>
    <h1>SSR Tests</h1>

    <section>
      <h2>Select matching logic</h2>

      <select id="matching-logic-select-1" v-register="register('favoriteGame')">
        <option value="monopoly">Monopoly</option>
        <option value="chess">chess Top</option>
        <option value="chess">Chess Middle</option>
        <option value="chess">Chess Bottom</option>
        <option value="blackjack">Blackjack</option>
      </select>

      <select id="matching-logic-select-2" v-register="register('favoriteGame')">
        <option value="chess" selected="false">Chess</option>
      </select>

      <select id="random-nested-select-1" v-register="register('favoriteGame')">
        <div>
          <optgroup>
            <p>
              <span>
                <option value="chess">Chess Option Nested</option>
              </span>
            </p>
          </optgroup>
        </div>
      </select>

      <select id="select-with-no-matching-options-1" v-register="register('favoriteGame')">
        <option value="mario_kart">Mario Kart</option>
        <option value="tekken">Tekken</option>
        <option value="brain_game">Brain Game</option>
      </select>

      <select id="select-without-options-1" v-register="register('favoriteGame')"></select>

      <!-- Reproduces the docs schema-to-inputs demo: placeholder option
           with value="" plus a schema chain that puts `.default('JP')`
           inside a `.refine(...)`. The SSR-time `selected` attribute
           must land on the JP option, NOT the placeholder. -->
      <select id="refined-default-select" v-register="register('refinedDefault')">
        <option value="">- Select -</option>
        <option value="US">US</option>
        <option value="JP">JP</option>
        <option value="CA">CA</option>
      </select>

      <select
        id="select-with-invalid-element-matching-value-1"
        v-register="register('favoriteGame')"
      >
        <input value="chess" />
      </select>

      <select
        id="select-multiple-false-default-success-case-1"
        v-register="register('favoriteGame')"
      >
        <option value="chess">Chess</option>
      </select>

      <select
        id="select-multiple-false-default-failure-case-1"
        v-register="register('chessInArray')"
      >
        <option value="chess">Chess</option>
      </select>
    </section>

    <section>
      <h2>Error API</h2>

      <!-- Direct setErrors -->
      <div id="errors-direct">
        <span id="errors-direct-fielderrors-email">{{
          directForm.errors.email?.[0]?.message ?? ''
        }}</span>
        <span id="errors-direct-fielderrors-password">{{
          directForm.errors.password?.[0]?.message ?? ''
        }}</span>
        <span id="errors-direct-fieldstate-email">{{
          directForm.fields.email.errors[0]?.message ?? ''
        }}</span>
        <span id="errors-direct-count">{{ directForm.meta.errors.length }}</span>
      </div>

      <!-- Server 422 errors → setErrors -->
      <div id="errors-from-api">
        <span id="errors-from-api-first">{{
          apiErrorForm.errors.username?.[0]?.message ?? ''
        }}</span>
        <span id="errors-from-api-second">{{
          apiErrorForm.errors.username?.[1]?.message ?? ''
        }}</span>
        <span id="errors-from-api-count">{{ apiErrorForm.errors.username?.length ?? 0 }}</span>
      </div>

      <!-- handleSubmit return shape -->
      <div id="handle-submit-shape">
        <span id="handle-submit-typeof">{{ submitHandlerType }}</span>
      </div>

      <!-- Hydration round-trip -->
      <div id="hydration-check">
        <span id="hydration-check-value">{{ hydrationForm.values.hydratedField }}</span>
      </div>
    </section>

    <section>
      <h2>autoAria component host</h2>
      <AriaWrapper v-register="ariaHostForm.register('email')" />
    </section>
  </div>
</template>
