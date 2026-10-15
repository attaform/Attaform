/**
 * Schema and component builders for the construction-cost measurements
 * (#691): `bench/construction.bench.ts` (vitest, dev build, trends only)
 * and `scripts/construction-ab.mjs` (production builds, interleaved A/B).
 * Both import this file, so the two tools always measure the same shapes.
 *
 * It has no runtime imports. Every builder takes the adapter's `z`, and the
 * component builder takes Vue and Attaform as injected dependencies, so the
 * bench can pass `src/` while the A/B script passes a built `dist/`. That
 * also keeps the file loadable by Node's built-in type stripping, which is
 * how the plain-node A/B script reads it: erasable TypeScript only (no
 * enums, no parameter properties, no runtime `import` of a `.ts` module).
 *
 * Two profiles, each a real consumer shape rather than one axis:
 *
 *   issue  The reproduction in #691. Six leaf kinds cycled across each
 *          page (trimmed string, enum, phone-or-blank, address object,
 *          household array, optional long text), no `defaultValues`, and a
 *          page that renders the wizard's current step key only, so no
 *          form's error state is read at mount.
 *   cubic  The shape of the downstream application form that reported
 *          #691. Every leaf is a `z.string()` whose `superRefine` runs a
 *          nested `safeParse` against a core format schema, every page
 *          passes complete blank `defaultValues`, and the page renders a
 *          step rail reading `wizard.statuses[key].valid` for every step,
 *          so every form is observed at mount.
 *
 * Each page is a strict object of `perPage` leaves. A wizard is one form per
 * page, all built in one setup, the shape whose cost #691 reports.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type ZodMajor = 'v3' | 'v4'
export type ConstructionProfile = 'issue' | 'cubic'

/** One wizard step: its schema, and the `defaultValues` its profile passes. */
export type ConstructionPage = {
  schema: unknown
  defaultValues: Record<string, unknown> | undefined
}

/** The fields per page form. */
export const FIELDS_PER_PAGE = 30

/** What each profile passes and reads, beside its leaf style. */
export const PROFILES: Record<ConstructionProfile, { defaults: boolean; rail: boolean }> = {
  issue: { defaults: false, rail: false },
  cubic: { defaults: true, rail: true },
}

type Leaf = { schema: unknown; blank: unknown }

/** The six leaf kinds from the #691 report, cycled by field index. */
function issueLeaf(z: any, index: number): Leaf {
  switch (index % 6) {
    case 0:
      return { schema: z.string().trim().min(1, 'Enter your answer').max(200), blank: '' }
    case 1:
      return { schema: z.enum(['yes', 'no', 'unsure']), blank: '' }
    case 2:
      return {
        schema: z
          .string()
          .regex(/^\d{3}-\d{3}-\d{4}$/, 'Enter a phone number')
          .or(z.literal('')),
        blank: '',
      }
    case 3:
      return {
        schema: z.object({
          line1: z.string().min(1),
          line2: z.string(),
          city: z.string().min(1),
          state: z.string().length(2),
          zip: z.string().regex(/^\d{5}$/),
        }),
        blank: { line1: '', line2: '', city: '', state: '', zip: '' },
      }
    case 4:
      return {
        schema: z
          .array(
            z.object({
              name: z.string().min(1),
              relation: z.enum(['spouse', 'child', 'other']),
              income: z.number().int().nonnegative(),
            })
          )
          .max(20),
        blank: [],
      }
    default:
      return { schema: z.string().max(2000).optional(), blank: '' }
  }
}

/**
 * The core format schemas a cubic-style leaf re-parses inside its
 * `superRefine`. Built once per wizard, so a fresh-schema mount pays for
 * them too. v3 has no top-level format constructors, hence `major`.
 */
function cubicCore(z: any, major: ZodMajor): any[] {
  return [
    z.string().trim().min(1).max(200),
    z.string().regex(/^\d{3}-\d{3}-\d{4}$/),
    major === 'v4' ? z.email() : z.string().email(),
    major === 'v4' ? z.iso.date() : z.string().date(),
  ]
}

function cubicLeaf(z: any, core: any[], index: number): Leaf {
  const format = core[index % core.length]
  return {
    schema: z.string().superRefine((value: string, ctx: any) => {
      if (value === '') {
        ctx.addIssue({ code: 'custom', message: 'Required' })
        return
      }
      const result = format.safeParse(value)
      if (result.success !== true) {
        for (const issue of result.error.issues) {
          ctx.addIssue({ code: 'custom', message: issue.message })
        }
      }
    }),
    blank: '',
  }
}

/**
 * Build one wizard's worth of page schemas. Every call returns new schema
 * objects, so calling it per mount is the fresh-schema scenario and calling
 * it once is the cached one.
 */
export function buildPages(
  z: any,
  major: ZodMajor,
  profile: ConstructionProfile,
  pages: number,
  perPage: number
): ConstructionPage[] {
  const core = profile === 'cubic' ? cubicCore(z, major) : []
  const out: ConstructionPage[] = []
  for (let p = 0; p < pages; p++) {
    const shape: Record<string, unknown> = {}
    const blank: Record<string, unknown> = {}
    for (let i = 0; i < perPage; i++) {
      const leaf = profile === 'cubic' ? cubicLeaf(z, core, i) : issueLeaf(z, i)
      shape[`p${p}_f${i}`] = leaf.schema
      blank[`p${p}_f${i}`] = leaf.blank
    }
    out.push({
      schema: z.object(shape).strict(),
      defaultValues: PROFILES[profile].defaults ? blank : undefined,
    })
  }
  return out
}

/** Vue and Attaform, injected so the caller picks `src/` or a built `dist/`. */
export type WizardRootDeps = {
  defineComponent: any
  h: any
  useForm: any
  useWizard: any
}

/**
 * The root component: one `useForm` per page, keyed `p0..pN`, composed by
 * one `useWizard`, rendered the way the profile renders it. `getPages` is
 * read once per setup, so a caller that swaps what it returns between
 * mounts gets fresh schemas without rebuilding the component. Fixed keys
 * are what let a server render's payload hydrate a client mount.
 */
export function wizardRoot(
  deps: WizardRootDeps,
  profile: ConstructionProfile,
  getPages: () => ConstructionPage[]
): unknown {
  const { defineComponent, h, useForm, useWizard } = deps
  return defineComponent({
    setup() {
      const pages = getPages()
      const keys = pages.map((_, p) => `p${p}`)
      const forms = pages.map((page, p) =>
        page.defaultValues === undefined
          ? useForm({ schema: page.schema, key: keys[p] })
          : useForm({ schema: page.schema, key: keys[p], defaultValues: page.defaultValues })
      )
      const wizard = useWizard({ steps: forms, restore: false, persist: false })
      if (!PROFILES[profile].rail) return () => h('div', wizard.currentStep)
      return () =>
        h(
          'ol',
          keys.map((key) =>
            h('li', { class: wizard.statuses[key].valid === true ? 'done' : '' }, key)
          )
        )
    },
  })
}
