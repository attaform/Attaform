/**
 * Bundled-types depth-pressure regression fixture. Imports from
 * `dist/*` (the published artifact shape) — NOT from `src/*`. This
 * mirrors what a real consumer sees through `attaform/zod-v4` and
 * `attaform`. The fixture compiles under `vue-tsc` via
 * `scripts/check-bundled-types.mjs` and is the acceptance test for
 * the type-system depth-efficiency refactor: if vue-tsc reports
 * TS2589 ("Type instantiation is excessively deep") here, the
 * refactor has regressed.
 *
 * Scenario: a 4-form multistep wizard with the same compounding
 * pressure profile as the shipment-demo restructure (nested objects,
 * arrays of objects, tuples, discriminated unions). Four `useForm`
 * calls composed via `useWizard({ steps })` in a single scope.
 *
 * Companion fixture `mixed-wizard.ts` covers the v2-specific surfaces
 * (string / function / lazy slots, namespaced aggregation, the
 * universal handleSubmit context) — this file stays narrowly focused
 * on instantiation depth so a regression there isolates cleanly.
 *
 * The fixture is never executed at runtime — `_neverInvoked` shapes
 * the call-site inference so the typechecker exercises each surface
 * end-to-end without needing a Vue app context.
 */
import { z } from 'zod'
import { useForm } from '../../../dist/zod-v4'
import { useWizard } from '../../../dist/index'

const referenceSchema = z.object({
  shipperRef: z.string(),
  internalNotes: z.string(),
  customerCode: z.string(),
  poNumber: z.string(),
  contactName: z.string(),
})

const cargoSchema = z.object({
  items: z.array(
    z.object({
      sku: z.string(),
      quantity: z.number(),
      weightKg: z.number(),
    })
  ),
  details: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('dry'), fragile: z.boolean() }),
    z.object({ kind: z.literal('refrigerated'), tempMinC: z.number(), tempMaxC: z.number() }),
    z.object({
      kind: z.literal('hazmat'),
      unNumber: z.string(),
      hazardClass: z.enum(['1', '2', '3']),
    }),
    z.object({
      kind: z.literal('oversized'),
      lengthCm: z.number(),
      widthCm: z.number(),
      heightCm: z.number(),
    }),
  ]),
  declaredValueUsd: z.number(),
  insurance: z.object({
    insured: z.boolean(),
    coverageUsd: z.number(),
  }),
})

const serviceSchema = z.object({
  pickup: z.object({
    line1: z.string(),
    line2: z.string(),
    city: z.string(),
    state: z.string(),
    postalCode: z.string(),
    country: z.string(),
  }),
  delivery: z.object({
    line1: z.string(),
    line2: z.string(),
    city: z.string(),
    state: z.string(),
    postalCode: z.string(),
    country: z.string(),
  }),
  speed: z.enum(['standard', 'expedited', 'overnight']),
  scheduledDates: z.tuple([z.string(), z.string()]),
})

const reviewSchema = z.object({
  termsAccepted: z.boolean(),
  signature: z.string(),
  acknowledgements: z.array(z.string()),
})

function _neverInvoked() {
  const refForm = useForm({ schema: referenceSchema, key: 'reference' as const })
  const cargoForm = useForm({ schema: cargoSchema, key: 'cargo' as const })
  const serviceForm = useForm({ schema: serviceSchema, key: 'service' as const })
  const reviewForm = useForm({ schema: reviewSchema, key: 'review' as const })

  const wizard = useWizard({
    steps: [refForm, cargoForm, serviceForm, reviewForm],
  })

  refForm.setValue('shipperRef', 'TRACK-001')
  cargoForm.setValue('items.0.sku', 'X')
  cargoForm.setValue('declaredValueUsd', 100)
  cargoForm.setValue('insurance.coverageUsd', 200)
  serviceForm.setValue('pickup.city', 'Lusaka')
  serviceForm.setValue('delivery.country', 'ZM')

  const refValid: boolean = wizard.statuses.reference.valid
  const cargoErr: number = wizard.statuses.cargo.errorCount
  const current: string = wizard.currentStep

  cargoForm.handleSubmit((data) => {
    const items: Array<{ sku: string; quantity: number; weightKg: number }> = data.items
    const value: number = data.declaredValueUsd
    void [items, value]
  })

  void [refValid, cargoErr, current, reviewForm]
}
void _neverInvoked
