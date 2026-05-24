/**
 * Bundled-types v2-surface regression fixture. Companion to
 * `4-form-wizard.ts` (which carries the depth-efficiency regression).
 * This file pins the v2-introduced surfaces against the bundled `.d.ts`
 * so a divergence between src and dist on any of them fails CI before
 * a consumer hits the same drift.
 *
 * Surfaces under test:
 *   - StepSlot variants: form, string (affordance), function slot,
 *     `lazy()`-wrapped memoized slot.
 *   - WizardCtx inside function slots: `ctx.forms.<key>.values.<path>`
 *     reads stay loose-typed (per the deliberate looseness on
 *     `WizardCtxForm`), and `ctx.currentKey` narrows to `FormKey`.
 *   - WizardSubmitContext: `values` (namespaced), `get(form)` (typed
 *     per-form), `currentKey`, `isFinal`.
 *   - Namespaced aggregation: `wizard.allValues`, `wizard.allErrors`,
 *     `wizard.forms.<key>`.
 *   - Navigation handles: `next` / `back` / `goTo` / `reset` —
 *     including the `(key: string) => void` signature on `goTo`.
 *   - Other v2 fields: `currentStep`, `activeForm`, `activeIndex`,
 *     `isFinalStep`, `steps`, `count`, `canAdvance`, `canGoBack`,
 *     `complete`, `submitting`, `submissionAttempts`, `visited`,
 *     `progress`.
 *
 * The fixture is never executed at runtime — `_neverInvoked` shapes the
 * call-site inference so the typechecker exercises each surface
 * end-to-end without needing a Vue app context.
 */
import { z } from 'zod'
import { useForm } from '../../../dist/zod-v4'
import { useWizard, lazy } from '../../../dist/index'

const loginSchema = z.object({
  email: z.string(),
  password: z.string(),
})

const profileSchema = z.object({
  displayName: z.string(),
  bio: z.string(),
  interests: z.array(z.string()),
})

const confirmSchema = z.object({
  consent: z.boolean(),
  signature: z.string(),
})

function _neverInvoked() {
  const login = useForm({ schema: loginSchema, key: 'login' as const })
  const profile = useForm({ schema: profileSchema, key: 'profile' as const })
  const confirm = useForm({ schema: confirmSchema, key: 'confirm' as const })

  const wizard = useWizard({
    steps: [
      'welcome',
      login,
      (ctx) => {
        // Function-slot ctx surfaces. `currentKey` may be undefined
        // before the first activation lands; `forms[key].values` is a
        // loose record by design (see WizardCtxForm).
        const at: string | undefined = ctx.currentKey
        const liveEmail: unknown = ctx.forms.login?.values.email
        return liveEmail && at !== 'welcome' ? profile : 'maintenance'
      },
      lazy((ctx) => {
        // Memoized lazy slot. Same WizardCtx surface as eager function
        // slots; the resolver re-fires only when its tracked reactive
        // reads change (or `wizard.reset()` invalidates the cache).
        void ctx.currentKey
        return confirm
      }),
      'congrats',
    ],
  })

  // Universal handleSubmit with the v2 context shape.
  const onSubmitted = wizard.handleSubmit(
    (ctx) => {
      const key: string = ctx.currentKey
      const final: boolean = ctx.isFinal
      // `get(form)` returns the form's typed values.
      const loginValues = ctx.get(login)
      const email: string = loginValues.email
      const password: string = loginValues.password
      // `values` mirrors the namespaced aggregate.
      const allByKey: Readonly<Record<string, unknown>> = ctx.values
      void [key, final, email, password, allByKey]
    },
    (errors) => {
      // onError receives the aggregate list — same shape as
      // `wizard.allErrors[key]`.
      const count: number = errors.length
      void count
    }
  )
  void onSubmitted

  // Namespaced aggregation surfaces.
  const aggregateValues: Readonly<Record<string, unknown>> = wizard.allValues
  const aggregateErrors: Readonly<Record<string, readonly unknown[]>> = wizard.allErrors
  void [aggregateValues, aggregateErrors]

  // `forms.<key>` returns the full form handle, typed concretely for
  // statically-known slot keys. Drilling stays type-safe through the
  // schema-derived value shape.
  const loginHandleViaWizard = wizard.forms.login
  const loginEmailViaWizard: string = loginHandleViaWizard.values.email
  const loginPasswordViaWizard: string = loginHandleViaWizard.values.password
  void [loginHandleViaWizard, loginEmailViaWizard, loginPasswordViaWizard]

  // Affordance step slots (string slots) resolve to AnyForm — the noop
  // form is opaque at the type level, so consumers don't get a fields
  // surface to drill, which matches the no-data-collection intent.
  const welcomeNoop = wizard.forms.welcome
  void welcomeNoop

  // A non-static key (e.g. a key resolved by a function slot at
  // runtime) reads as AnyForm via the catch-all index signature on
  // WizardForms<S>.
  const dynamicLookup = wizard.forms['some-runtime-key']
  void dynamicLookup

  // Navigation handles.
  void wizard.next
  void wizard.back
  void wizard.reset
  wizard.goTo('welcome')

  // Other v2 surface fields.
  const at: string | undefined = wizard.currentStep
  const idx: number = wizard.activeIndex
  const finalStep: boolean = wizard.isFinalStep
  const stepCount: number = wizard.count
  const advance: boolean = wizard.canAdvance
  const goBack: boolean = wizard.canGoBack
  const done: boolean = wizard.complete
  const inFlight: boolean = wizard.submitting
  const attempts: number = wizard.submissionAttempts
  const trail: readonly string[] = wizard.visited
  const progress: number = wizard.progress
  const steps = wizard.steps
  const active = wizard.activeForm
  void [at, idx, finalStep, stepCount, advance, goBack, done, inFlight, attempts, trail, progress]
  void [steps, active]
}
void _neverInvoked
