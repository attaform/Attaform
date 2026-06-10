/**
 * The fairness device: one interface every library implements, so a single
 * driver runs all of them identically. The three design-point layers
 * (headless-form-state, headless-validation-only, batteries-included) are
 * absorbed by WHAT an adapter owns, not by branching in the driver.
 *
 * The contract is scenario-parameterized: the same handle drives a flat form,
 * a deep tree, a dynamic array, a discriminated union, or a wizard. A library
 * that genuinely cannot express a scenario idiomatically declares it
 * `unsupported` in its capability map (which feeds the docs capability matrix)
 * and the driver skips it; it is NEVER hand-rigged into a misleading number.
 */

/** The practical form shapes the suite stress-tests. */
export type ScenarioId =
  | 'flat'
  | 'nested'
  | 'arrays'
  | 'grid'
  | 'discriminated-union'
  | 'massive'
  | 'wizard'

/** What a given (scenario, dimension) cell measures. */
export type DimensionId =
  | 'keystroke'
  | 'mount'
  | 'validate'
  | 'rerender'
  | 'arrayAdd'
  | 'arrayReorder'
  | 'variantFlip'
  | 'stepTransition'

/** The design-point a library occupies; the fairness axis. */
export type LayerId = 'headless-form-state' | 'headless-validation-only' | 'batteries-included'

/** Which validator the adapter feeds. zod v3 is pinned across the zod cohort. */
export type SchemaLib = 'zod3' | 'valibot' | 'native'

/** Validation trigger under test. `input` is the primary (universal) pass. */
export type TriggerMode = 'input' | 'blur'

/** How well a library expresses a scenario; the capability-matrix vocabulary. */
export type Capability = 'native' | 'hand-rolled' | 'unsupported'

/** Dynamic-array mutations exercised by the arrays/grid scenarios. */
export type ArrayOp = 'append' | 'prepend' | 'insert' | 'remove' | 'swap' | 'move'

/** Scenario size knobs, e.g. `{ fields: 50 }`, `{ depth: 8 }`, `{ rows: 100 }`. */
export type ScenarioParams = Readonly<Record<string, number>>

export interface AdapterMeta {
  readonly id: string
  readonly displayName: string
  readonly layer: LayerId
  readonly schemaLib: SchemaLib
  /**
   * True when the library renders its own field components (FormKit). Such an
   * adapter cannot drive the shared bare `<input>`, so it is measured in its
   * idiomatic mode and labeled batteries-included, never placed silently
   * beside the bare-input libraries.
   */
  readonly ownsInputs: boolean
  /** Per-scenario expressiveness; rendered verbatim as the capability matrix. */
  readonly capabilities: Readonly<Record<ScenarioId, Capability>>
}

export interface MountOpts {
  readonly scenario: ScenarioId
  readonly params: ScenarioParams
  readonly trigger: TriggerMode
  /** Deterministic seed so a re-run drives the identical sequence of edits. */
  readonly seed: number
}

/**
 * A mounted form under measurement. Edit/validation methods route through the
 * library's real API; the driver clocks the wall-clock cost around each.
 *
 * Scenario-specific ops (arrayOp/flipVariant/stepTransition) are present on
 * every handle for a uniform driver, but only invoked when the adapter's
 * capability map says the library expresses that scenario. An adapter whose
 * library lacks the primitive throws from the unused op (never reached under
 * capability gating) rather than faking a number.
 */
export interface MountHandle {
  /** One keystroke: set the input value, fire the native event, await settle. */
  typeChar(index: number, value: string): Promise<void>
  /** Set a field without timing it (warmup / pre-dirtying a valid baseline). */
  setFieldValue(index: number, value: string): Promise<void>
  /** Run a full-form validation pass to completion. */
  validateAll(): Promise<void>
  /** Validate a single field. */
  validateField(index: number): Promise<void>
  /**
   * Mutate the active array through the library's own array primitive
   * (arrays/grid scenarios). `append` adds a fresh valid row; `remove` with no
   * index drops the last row, with an index drops that row; `swap` exchanges the
   * rows at `a` and `b`. Awaits the shared settle so the DOM reflow is included.
   */
  arrayOp(op: ArrayOp, a?: number, b?: number): Promise<void>
  /** Flip a discriminated union to another variant (discriminated-union). */
  flipVariant(to: string): Promise<void>
  /** Advance or retreat a wizard step (wizard scenario). */
  stepTransition(dir: 1 | -1): Promise<void>
  /**
   * Components re-rendered since the last reset. `null` for batteries-included
   * libraries that own their inputs, where the driver falls back to a
   * DOM-mutation proxy (explicitly caveated, not directly comparable).
   */
  getRenderCount(): number | null
  resetRenderCount(): void
  teardown(): void
}

export interface BenchAdapter {
  readonly meta: AdapterMeta
  mount(container: HTMLElement, opts: MountOpts): Promise<MountHandle>
}
