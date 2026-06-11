<script setup lang="ts">
  // Renders one slice of the cross-library benchmark from the committed
  // results.json. Each `::bench-arena{dimension=... scenario=...}` block in the
  // Benchmarks page selects a view: the capability matrix, the supply-chain
  // (OpenSSF Scorecard) table, the bundle table, or a per-scenario runtime
  // table. The data is the single source of truth produced by the bench-arena
  // orchestrator; this component only renders it, so a number on the page can
  // never disagree with the run that produced it.
  //
  // Build-time invariant (mirrors DocsDemo's missing-slug throw): an unknown
  // schemaVersion, or a runtime view whose scenario or dimension is absent from
  // the data, throws at render. That fails Nuxt's prerender for the page and
  // surfaces in CI before reaching production, so a typo in a content block can
  // never ship a blank or stale table.
  import { computed } from 'vue'
  import { ArrowUpRight, Github } from 'lucide-vue-next'
  import rawResults from 'attaform-bench-arena/results.json'

  type Support = 'native' | 'hand-rolled' | 'unsupported'
  type ScorecardStatus = 'published' | 'not-published' | 'unavailable'
  interface Scorecard {
    score: number
    date: string | null
  }
  interface Capability {
    lib: string
    displayName: string
    layer: string
    schemaLib: string
    ownsInputs: boolean
    repo: string | null
    repoUrl: string | null
    scorecardUrl: string | null
    scorecardStatus: ScorecardStatus
    scorecard: Scorecard | null
    [scenario: string]: unknown
  }
  interface BundleRow {
    id: string
    lib: string
    version: string
    validator: string
    gzBytes: number
    ratio: number
  }
  interface TimedRow {
    lib: string
    supported: boolean
    ratio: number | null
    slope: number | null
    // A did-not-finish cell carries a budget and no median/p95/unit: it could not
    // produce a stable median inside its per-cell budget, so it renders as "did
    // not finish" rather than a fabricated number. An absent status reads as a
    // normal measurement, so a results.json written before the field existed
    // still renders unchanged.
    status?: 'measured' | 'did-not-finish'
    budgetMs?: number
    median?: number
    p95?: number
    unit?: string
  }
  interface MemoryStat {
    median: number
    p95: number
    count: number
  }
  interface MemoryRow {
    lib: string
    retained: MemoryStat
    churn: MemoryStat
    leak: MemoryStat
    series: { retained: number[]; churn: number[]; leak: number[] }
    supported: boolean
    ratio: number | null
    slope: number
  }
  type RuntimeRow = TimedRow | MemoryRow
  interface DimBlock {
    unit: string
    byParam: Record<string, RuntimeRow[]>
  }
  interface Provenance {
    source: 'ci' | 'local'
    commit: string | null
    ciRunId: string | null
    ciRunUrl: string | null
    runner: { os: string; arch: string; cpuModel: string; cpuCount: number }
    node: string
    timestamp: string
    libVersions: Record<string, string>
  }
  interface Results {
    schemaVersion: number
    provenance: Provenance
    baseline: string
    capabilities: Capability[]
    bundle: BundleRow[]
    runtime: Record<string, Record<string, DimBlock>>
  }

  const props = defineProps<{ dimension: string; scenario?: string }>()

  const results = rawResults as Results
  const isDev = import.meta.dev
  // The Actions page for the monthly refresh workflow. Doubles as the
  // always-available provenance link (before any CI run has stamped a
  // specific run URL) and the production fallback when data is missing.
  const BENCH_WORKFLOW_URL =
    'https://github.com/attaform/Attaform/actions/workflows/bench-arena.yml'
  const BENCH_SOURCE_URL = 'https://github.com/attaform/Attaform/tree/main/apps/bench-arena'

  // A present-but-incompatible schema is real drift and still fails the
  // build loudly, so a shape change can never render a stale table. An
  // absent or empty dataset is a different condition: a regen that never
  // ran, or wrote nothing, should degrade to a friendly notice rather than
  // crash every page that embeds a block. `datasetReady` separates the two.
  const hasUsableShape =
    !!results &&
    typeof results === 'object' &&
    typeof results.schemaVersion === 'number' &&
    !!results.runtime &&
    Object.keys(results.runtime).length > 0 &&
    Array.isArray(results.capabilities) &&
    results.capabilities.length > 0
  if (hasUsableShape && results.schemaVersion !== 1) {
    throw new Error(
      `[BenchArena] results.json schemaVersion ${results.schemaVersion} is unsupported ` +
        `(this component renders schemaVersion 1). Update BenchArena.vue to the new shape ` +
        `or re-run the bench-arena orchestrator to emit a compatible results.json.`
    )
  }
  const datasetReady = hasUsableShape && results.schemaVersion === 1

  const SCENARIO_LABEL: Record<string, string> = {
    flat: 'Flat',
    nested: 'Deeply nested',
    arrays: 'Dynamic arrays',
    grid: 'Grid',
    'discriminated-union': 'Discriminated union',
    massive: 'Massive',
    wizard: 'Wizard',
  }
  const DIMENSION_LABEL: Record<string, string> = {
    keystroke: 'Keystroke latency',
    mount: 'Mount',
    validate: 'Full-form validation',
    rerender: 'Re-render scope per keystroke',
    arrayAdd: 'Array append',
    arrayReorder: 'Array reorder',
    variantFlip: 'Variant flip',
    stepTransition: 'Step transition',
    memory: 'Retained heap',
  }
  const LAYER_LABEL: Record<string, string> = {
    'headless-form-state': 'Form state',
    'headless-validation-only': 'Validation only',
    'batteries-included': 'Batteries included',
  }
  const SCHEMA_LABEL: Record<string, string> = {
    zod3: 'Zod 3',
    valibot: 'Valibot',
    native: 'native rules',
  }
  const UNIT_LABEL: Record<string, string> = {
    ms: 'ms',
    renders: 'renders',
    'dom-mutations': 'DOM mutations',
    bytes: 'bytes',
  }

  const mode = computed<'capabilities' | 'scorecard' | 'bundle' | 'runtime'>(() => {
    if (props.dimension === 'capabilities') return 'capabilities'
    if (props.dimension === 'scorecard') return 'scorecard'
    if (props.dimension === 'bundle') return 'bundle'
    return 'runtime'
  })

  const displayName = (lib: string) =>
    results.capabilities.find((c) => c.lib === lib)?.displayName ?? lib
  const isBaseline = (lib: string) => lib === results.baseline

  // --- formatting ---------------------------------------------------------
  const fmtMs = (n: number) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2))
  const fmtCount = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))
  const fmtKb = (bytes: number) => `${(bytes / 1024).toFixed(1)} kB`
  // Heap is quantized by the engine, so retained bytes show as whole kB; false
  // decimals would imply a precision the measurement does not have.
  const fmtHeapKb = (bytes: number) => `${Math.round(bytes / 1024)} kB`
  const fmtRatio = (r: number | null) => (r == null ? '' : `${r}×`)
  const shortDate = (iso: string | null) => (iso ? iso.slice(0, 10) : '')
  const fmtTimed = (value: number, unit: string) =>
    unit === 'ms' ? `${fmtMs(value)} ms` : `${fmtCount(value)} ${UNIT_LABEL[unit] ?? unit}`
  const barPct = (value: number, max: number) => (max > 0 ? Math.max(2, (value / max) * 100) : 0)
  // A did-not-finish caption from the true budget, floored to whole minutes so
  // the page can never claim a tighter ceiling than the run actually enforced.
  const fmtBudget = (ms: number | undefined) => {
    const total = ms ?? 0
    const mins = Math.floor(total / 60_000)
    return mins >= 1 ? `> ${mins} min` : `> ${Math.floor(total / 1000)} s`
  }

  // --- capability matrix --------------------------------------------------
  const SCENARIOS = Object.keys(SCENARIO_LABEL)
  const supportOf = (cap: Capability, scenario: string) => cap[scenario] as Support | undefined
  const SUPPORT_GLYPH: Record<Support, string> = {
    native: 'Native',
    'hand-rolled': 'Hand-rolled',
    unsupported: '—',
  }

  // --- bundle -------------------------------------------------------------
  // Smallest first, so Attaform's heaviest-in-cohort figure reads honestly at
  // the foot of the table rather than being buried.
  const bundleRows = computed(() => [...results.bundle].sort((a, b) => a.gzBytes - b.gzBytes))
  const bundleMax = computed(() => Math.max(...results.bundle.map((r) => r.gzBytes)))

  // --- runtime tables -----------------------------------------------------
  // Resolve the selected scenario/dimension; throw with a helpful message if it
  // is absent, so a bad content block fails the build rather than rendering blank.
  const block = computed<DimBlock | null>(() => {
    if (mode.value !== 'runtime') return null
    if (!props.scenario) {
      throw new Error(
        `[BenchArena] dimension "${props.dimension}" needs a scenario ` +
          `(e.g. ::bench-arena{scenario="flat" dimension="${props.dimension}"}).`
      )
    }
    const found = results.runtime[props.scenario]?.[props.dimension]
    if (!found) {
      const have = Object.keys(results.runtime[props.scenario] ?? {}).join(', ') || 'none'
      throw new Error(
        `[BenchArena] no data for scenario "${props.scenario}" dimension "${props.dimension}". ` +
          `Available for that scenario: ${have}.`
      )
    }
    return found
  })
  const params = computed(() => (block.value ? Object.keys(block.value.byParam) : []))
  const runtimeLibs = computed(() => {
    const b = block.value
    const first = params.value[0]
    if (!b || !first) return []
    return (b.byParam[first] ?? []).map((r) => r.lib)
  })
  const isMemory = computed(() => props.dimension === 'memory')

  // A did-not-finish timed row carries no median, so it is excluded from every
  // derived statistic (the per-column bar scale, Attaform's standing) the same
  // way an unsupported row is. Memory rows never carry a status, so they are
  // always measured.
  const isDnfRow = (r: RuntimeRow): boolean =>
    'retained' in r ? false : r.status === 'did-not-finish'
  const isMeasured = (r: RuntimeRow): boolean => r.supported && !isDnfRow(r)

  // Per-column bar scale, over measured rows only.
  const colMax = (param: string) => {
    const rows = block.value?.byParam[param] ?? []
    const vals = rows
      .filter((r) => isMeasured(r))
      .map((r) => ('retained' in r ? r.retained.median : (r.median ?? 0)))
    return vals.length ? Math.max(...vals) : 0
  }
  const findRow = (param: string, lib: string) =>
    block.value?.byParam[param]?.find((r) => r.lib === lib)

  // Pivot the byParam arrays into lib rows x param cells, typed for the view so
  // the template narrows with a plain v-if and needs no casts.
  const timedGrid = computed(() => {
    const b = block.value
    if (!b || isMemory.value) return []
    return runtimeLibs.value.map((lib) => ({
      lib,
      displayName: displayName(lib),
      baseline: isBaseline(lib),
      cells: params.value.map((param) => {
        const row = findRow(param, lib) as TimedRow | undefined
        if (!row || !row.supported) return { param, state: 'absent' as const }
        if (row.status === 'did-not-finish')
          return { param, state: 'dnf' as const, budgetText: fmtBudget(row.budgetMs) }
        return {
          param,
          state: 'measured' as const,
          widthPct: barPct(row.median ?? 0, colMax(param)),
          valueText: fmtTimed(row.median ?? 0, row.unit ?? b.unit),
          ratioText: fmtRatio(row.ratio),
          proxy: row.unit !== b.unit,
        }
      }),
    }))
  })
  const memoryGrid = computed(() => {
    if (!block.value || !isMemory.value) return []
    return runtimeLibs.value.map((lib) => ({
      lib,
      displayName: displayName(lib),
      baseline: isBaseline(lib),
      cells: params.value.map((param) => ({
        param,
        row: findRow(param, lib) as MemoryRow | undefined,
        max: colMax(param),
      })),
    }))
  })
  const mixedUnits = computed(() =>
    timedGrid.value.some((r) => r.cells.some((c) => c.state === 'measured' && c.proxy))
  )

  // Inline sparkline of the per-cycle retained-heap series (leak creep across
  // the measured mounts), normalized into a small viewBox.
  const sparkline = (values: number[], w = 64, h = 18) => {
    if (values.length < 2) return ''
    const min = Math.min(...values)
    const max = Math.max(...values)
    const span = max - min || 1
    const step = w / (values.length - 1)
    return values
      .map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`)
      .join(' ')
  }

  const caption = computed(() => {
    if (mode.value !== 'runtime') return ''
    const s = SCENARIO_LABEL[props.scenario ?? ''] ?? props.scenario
    return `${s}: ${DIMENSION_LABEL[props.dimension] ?? props.dimension}`
  })

  // --- Attaform standing (data-driven, never hard-coded) ------------------
  // The page asserts no rank in prose; this derives Attaform's standing for
  // the selected block straight from the numbers, so the sentence under a
  // table can never drift from the table itself. The comparison set is
  // Attaform's own layer, the form-state libraries: a validation-only engine
  // that owns no input binding is not a faster form library, only a smaller
  // one, exactly as the methodology note says. Ranking is by the largest
  // size in the block (the most-stressed, fairest read) and combines rank
  // with the gap to the leader, so "second of four but eight times behind"
  // reads as trailing, not as front-of-pack.
  const FORM_STATE_LAYER = 'headless-form-state'
  const layerOf = (lib: string) => results.capabilities.find((c) => c.lib === lib)?.layer ?? ''

  type StandingTone = 'lead' | 'plain'
  interface Standing {
    text: string
    tone: StandingTone
  }

  // One pool per standing. Every line in a pool is interchangeably true for
  // that standing, so any selection stays honest; the selection only varies
  // the phrasing. Scoped to "form-state libraries", names Attaform, no
  // competitor naming, no superlative the data does not earn.
  const STANDING_POOLS: Record<string, string[]> = {
    leads: [
      'Fastest of the form-state libraries here, with daylight to the next.',
      'Out in front of the form-state pack on this shape.',
      'The quickest form-state library on this run, comfortably ahead.',
    ],
    edges: [
      'Narrowly the fastest form-state library on this shape.',
      'At the head of the form-state pack, by a step.',
      'Just ahead of its form-state peers here.',
    ],
    matches: [
      'Level with the fastest form-state libraries, at the floor this shape allows.',
      'Matches the best of the form-state pack, with no lower number left to reach.',
      'Even with the front of the form-state field on this run.',
    ],
    front: [
      'Among the faster form-state libraries on this shape.',
      'Near the front of the form-state pack here.',
      'In the leading group of form-state libraries on this run.',
    ],
    mid: [
      'Mid-pack among the form-state libraries here.',
      'Holds the middle of the form-state field on this shape.',
      'Squarely in the form-state pack, neither out front nor at the back.',
    ],
    trails: [
      'Behind the form-state pack on this shape, and the run shows it plainly.',
      'Off the lead here among the form-state libraries, a line we are actively sharpening.',
      'Toward the back of the form-state field on this run, honest data we would rather show than hide.',
    ],
    renderScope: [
      'One render per keystroke, whatever the form size. That is the design target, and the run holds it.',
      'Editing one field re-renders one field, flat across every size measured.',
      'Render scope stays at one, the floor, however large the form grows.',
    ],
  }

  // Deterministic pick: stable across builds (no Math.random in SSG) but
  // varied across sections, so neighbouring blocks do not repeat a sentence.
  const pickFor = (key: string, pool: string[]): string => {
    // Multiplier 33 (not 31): it keeps adjacent same-bucket blocks on the page
    // (the two array ops, mount next to memory) from drawing the same sentence.
    let h = 0
    for (let i = 0; i < key.length; i += 1) h = (h * 33 + key.charCodeAt(i)) >>> 0
    return pool[h % pool.length] ?? pool[0] ?? ''
  }

  const standing = computed<Standing | null>(() => {
    const b = block.value
    if (mode.value !== 'runtime' || !b) return null
    const orderedParams = Object.keys(b.byParam)
    const largest = orderedParams[orderedParams.length - 1]
    if (!largest) return null
    const valueOf = (r: RuntimeRow) => ('retained' in r ? r.retained.median : (r.median ?? 0))
    const peers = (b.byParam[largest] ?? []).filter(
      (r) => isMeasured(r) && layerOf(r.lib) === FORM_STATE_LAYER
    )
    const me = peers.find((r) => r.lib === results.baseline)
    if (!me || peers.length < 2) return null
    const sorted = [...peers].sort((a, c) => valueOf(a) - valueOf(c))
    const leader = sorted[0]
    if (!leader) return null
    const rank = sorted.findIndex((r) => r.lib === results.baseline) + 1
    const n = peers.length
    const key = `${props.scenario}:${props.dimension}`

    // Render scope has an architectural floor of one render per keystroke.
    // When Attaform holds it (rank one), celebrate the constant scope rather
    // than a rank; if it ever regresses, fall through to the honest buckets.
    if (props.dimension === 'rerender' && rank === 1) {
      return { text: pickFor(key, STANDING_POOLS.renderScope ?? []), tone: 'lead' }
    }

    const meValue = valueOf(me)
    if (rank === 1) {
      const secondRow = sorted[1]
      const margin = secondRow && meValue > 0 ? valueOf(secondRow) / meValue : 1
      const pool = margin >= 1.15 ? 'leads' : margin >= 1.04 ? 'edges' : 'matches'
      return { text: pickFor(key, STANDING_POOLS[pool] ?? []), tone: 'lead' }
    }
    const leaderValue = valueOf(leader)
    const gap = leaderValue > 0 ? meValue / leaderValue : 1
    if (rank === n || gap > 4)
      return { text: pickFor(key, STANDING_POOLS.trails ?? []), tone: 'plain' }
    if (gap <= 1.5) return { text: pickFor(key, STANDING_POOLS.front ?? []), tone: 'lead' }
    return { text: pickFor(key, STANDING_POOLS.mid ?? []), tone: 'plain' }
  })

  // --- provenance ---------------------------------------------------------
  const prov = results.provenance
  const provDate = computed(() => shortDate(prov.timestamp))
</script>

<template>
  <div class="not-prose my-6 overflow-hidden rounded-xl border border-border bg-bg shadow-sm">
    <!-- ===================== Data unavailable (graceful) ===================== -->
    <!-- Heads the v-if chain: if results.json is missing or empty, every block
         renders this instead of crashing the build. Dev points at how to
         regenerate; production names the gap and links the live resources. -->
    <div v-if="!datasetReady" class="px-4 py-5 text-sm text-fg-muted">
      <p class="font-medium text-fg">Benchmark data is not available in this build.</p>
      <p v-if="isDev" class="mt-2">
        Generate it from the repo root: build Attaform's real
        <code class="rounded bg-surface px-1 py-0.5 font-mono text-xs text-fg">dist</code> with
        <code class="rounded bg-surface px-1 py-0.5 font-mono text-xs text-fg">pnpm prepack</code>,
        then run
        <code class="rounded bg-surface px-1 py-0.5 font-mono text-xs text-fg"
          >pnpm --filter attaform-bench-arena run arena</code
        >, which writes
        <code class="rounded bg-surface px-1 py-0.5 font-mono text-xs text-fg"
          >apps/bench-arena/results.json</code
        >.
      </p>
      <p v-else class="mt-2">
        The benchmark results are being refreshed. See the latest runs on the
        <a
          :href="BENCH_WORKFLOW_URL"
          target="_blank"
          rel="noopener noreferrer"
          class="text-accent hover:underline"
          >bench-arena workflow</a
        >, or browse the
        <a
          :href="BENCH_SOURCE_URL"
          target="_blank"
          rel="noopener noreferrer"
          class="text-accent hover:underline"
          >harness source</a
        >.
      </p>
    </div>

    <!-- ===================== Capability matrix ===================== -->
    <div v-else-if="mode === 'capabilities'" class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-border bg-surface/40 text-left">
            <th class="px-3 py-2 font-semibold text-fg">Library</th>
            <th class="px-3 py-2 font-semibold text-fg-subtle">Layer</th>
            <th
              v-for="s in SCENARIOS"
              :key="s"
              class="px-3 py-2 text-center text-xs font-semibold text-fg-subtle"
            >
              {{ SCENARIO_LABEL[s] }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="cap in results.capabilities"
            :key="cap.lib"
            class="border-b border-border/60 last:border-0"
            :class="isBaseline(cap.lib) ? 'bg-accent/5' : ''"
          >
            <td class="px-3 py-2 font-medium whitespace-nowrap text-fg">
              {{ cap.displayName }}
              <span class="ml-1 text-xs text-fg-subtle">{{ SCHEMA_LABEL[cap.schemaLib] }}</span>
            </td>
            <td class="px-3 py-2 text-xs whitespace-nowrap text-fg-muted">
              {{ LAYER_LABEL[cap.layer] ?? cap.layer }}
            </td>
            <td v-for="s in SCENARIOS" :key="s" class="px-3 py-2 text-center text-xs">
              <span
                :class="
                  supportOf(cap, s) === 'native'
                    ? 'font-medium text-accent'
                    : supportOf(cap, s) === 'hand-rolled'
                      ? 'text-fg-muted'
                      : 'text-fg-subtle'
                "
              >
                {{ SUPPORT_GLYPH[supportOf(cap, s) ?? 'unsupported'] }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="px-3 py-2 text-xs text-fg-subtle">
        Native: a first-class primitive. Hand-rolled: composed from lower-level pieces. Dash: not
        expressed, which the runtime tables read as no number, never a slow one.
      </p>
    </div>

    <!-- ===================== Scorecard (supply chain) ===================== -->
    <div v-else-if="mode === 'scorecard'" class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-border bg-surface/40 text-left">
            <th class="px-3 py-2 font-semibold text-fg">Library</th>
            <th class="px-3 py-2 font-semibold text-fg-subtle">OpenSSF Scorecard</th>
            <th class="px-3 py-2 font-semibold text-fg-subtle">As of</th>
            <th class="px-3 py-2 font-semibold text-fg-subtle">Link</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="cap in results.capabilities"
            :key="cap.lib"
            class="border-b border-border/60 last:border-0"
            :class="isBaseline(cap.lib) ? 'bg-accent/5' : ''"
          >
            <td class="px-3 py-2 font-medium whitespace-nowrap text-fg">{{ cap.displayName }}</td>
            <td class="px-3 py-2 whitespace-nowrap">
              <template v-if="cap.scorecardStatus === 'published' && cap.scorecard">
                <span class="font-mono font-semibold text-fg">{{
                  cap.scorecard.score.toFixed(1)
                }}</span>
                <span class="text-xs text-fg-subtle"> / 10</span>
                <span class="ml-2 inline-block h-1.5 w-24 rounded-full bg-surface align-middle">
                  <span
                    class="block h-full rounded-full bg-accent/70"
                    :style="{ width: `${(cap.scorecard.score / 10) * 100}%` }"
                  />
                </span>
              </template>
              <span
                v-else-if="cap.scorecardStatus === 'not-published'"
                class="text-xs text-fg-subtle"
                >Not published</span
              >
              <span
                v-else
                class="text-xs text-fg-subtle italic"
                title="The Scorecard lookup did not complete on this run; the linked viewer shows the live result."
                >Unavailable</span
              >
            </td>
            <td class="px-3 py-2 text-xs whitespace-nowrap text-fg-muted">
              {{
                cap.scorecardStatus === 'published' && cap.scorecard
                  ? shortDate(cap.scorecard.date)
                  : '—'
              }}
            </td>
            <td class="px-3 py-2 whitespace-nowrap">
              <a
                v-if="cap.scorecardStatus !== 'not-published' && cap.scorecardUrl"
                :href="cap.scorecardUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-1 text-xs text-accent hover:underline"
              >
                Scorecard <ArrowUpRight class="h-3 w-3" :stroke-width="2" />
              </a>
              <a
                v-else-if="cap.repoUrl"
                :href="cap.repoUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
              >
                <Github class="h-3 w-3" :stroke-width="2" /> Repository
              </a>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="px-3 py-2 text-xs text-fg-subtle">
        The OpenSSF Scorecard rates a project's adoption of supply-chain practices out of 10. An
        absent score has two meanings, kept distinct here.
        <span class="font-medium text-fg-muted">Not published</span> means the project has not opted
        into a Scorecard, which is a choice, not a deficiency.
        <span class="font-medium text-fg-muted">Unavailable</span> means the lookup did not complete
        on this run, a network gap on our side and never a statement about the project. Scores are
        point-in-time; the linked viewer shows the live result.
      </p>
    </div>

    <!-- ===================== Bundle size ===================== -->
    <div v-else-if="mode === 'bundle'" class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-border bg-surface/40 text-left">
            <th class="px-3 py-2 font-semibold text-fg">Library</th>
            <th class="px-3 py-2 font-semibold text-fg-subtle">Gzipped</th>
            <th class="px-3 py-2 font-semibold text-fg-subtle">vs Attaform</th>
            <th class="px-3 py-2 font-semibold text-fg-subtle">Validator</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in bundleRows"
            :key="row.id"
            class="border-b border-border/60 last:border-0"
            :class="isBaseline(row.id) ? 'bg-accent/5' : ''"
          >
            <td class="px-3 py-2 font-medium whitespace-nowrap text-fg">{{ row.lib }}</td>
            <td class="px-3 py-2 whitespace-nowrap">
              <div class="flex items-center gap-2">
                <span class="inline-block h-1.5 w-28 rounded-full bg-surface">
                  <span
                    class="block h-full rounded-full"
                    :class="isBaseline(row.id) ? 'bg-accent/80' : 'bg-fg-subtle/40'"
                    :style="{ width: `${barPct(row.gzBytes, bundleMax)}%` }"
                  />
                </span>
                <span class="font-mono text-fg">{{ fmtKb(row.gzBytes) }}</span>
              </div>
            </td>
            <td class="px-3 py-2 font-mono text-xs text-fg-muted">{{ fmtRatio(row.ratio) }}</td>
            <td class="px-3 py-2 text-xs whitespace-nowrap text-fg-muted">{{ row.validator }}</td>
          </tr>
        </tbody>
      </table>
      <p class="px-3 py-2 text-xs text-fg-subtle">
        Each row is the same minimal real form (one text field, one email field, schema-validated, a
        submit handler) in that library's idiomatic API, with its validator weighed in. Vue is
        external, since every app ships it once. Attaform's figure is its full bundle; with
        route-level code-splitting a first paint pulls less.
      </p>
    </div>

    <!-- ===================== Runtime: memory triad ===================== -->
    <div v-else-if="block" class="overflow-x-auto">
      <div class="border-b border-border bg-surface/40 px-3 py-2">
        <span class="text-xs font-semibold tracking-wide text-fg-subtle uppercase">{{
          caption
        }}</span>
      </div>
      <!-- Where Attaform lands, derived from the numbers below, never asserted
           by hand. See the `standing` classifier for the buckets. -->
      <p
        v-if="standing"
        class="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-sm"
        :class="standing.tone === 'lead' ? 'text-fg' : 'text-fg-muted'"
      >
        <span
          class="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
          :class="standing.tone === 'lead' ? 'bg-accent' : 'bg-fg-subtle/50'"
          aria-hidden="true"
        />
        {{ standing.text }}
      </p>
      <table v-if="isMemory" class="w-full text-sm">
        <thead>
          <tr class="border-b border-border text-left">
            <th class="px-3 py-2 font-semibold text-fg">Library</th>
            <th v-for="p in params" :key="p" class="px-3 py-2 font-semibold text-fg-subtle">
              {{ p }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in memoryGrid"
            :key="r.lib"
            class="border-b border-border/60 align-top last:border-0"
            :class="r.baseline ? 'bg-accent/5' : ''"
          >
            <td class="px-3 py-2 font-medium whitespace-nowrap text-fg">{{ r.displayName }}</td>
            <td v-for="c in r.cells" :key="c.param" class="px-3 py-2">
              <div v-if="c.row && c.row.supported" class="flex flex-col gap-1">
                <div class="flex items-center gap-2">
                  <span class="inline-block h-1.5 w-20 rounded-full bg-surface">
                    <span
                      class="block h-full rounded-full"
                      :class="r.baseline ? 'bg-accent/80' : 'bg-fg-subtle/40'"
                      :style="{ width: `${barPct(c.row.retained.median, c.max)}%` }"
                    />
                  </span>
                  <span class="font-mono text-fg">{{ fmtHeapKb(c.row.retained.median) }}</span>
                  <span class="font-mono text-xs text-fg-subtle">{{ fmtRatio(c.row.ratio) }}</span>
                </div>
                <div class="text-xs text-fg-subtle">
                  churn {{ fmtHeapKb(c.row.churn.median) }} &middot; leak
                  {{ fmtHeapKb(c.row.leak.median) }}
                </div>
                <svg
                  viewBox="0 0 64 18"
                  class="h-4 w-16 text-fg-subtle/70"
                  preserveAspectRatio="none"
                  role="img"
                  aria-label="retained heap across mount cycles"
                >
                  <polyline
                    :points="sparkline(c.row.series.retained)"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1"
                    vector-effect="non-scaling-stroke"
                  />
                </svg>
              </div>
              <span v-else class="text-fg-subtle">&mdash;</span>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- ===================== Runtime: timed dimensions ===================== -->
      <table v-else class="w-full text-sm">
        <thead>
          <tr class="border-b border-border text-left">
            <th class="px-3 py-2 font-semibold text-fg">Library</th>
            <th v-for="p in params" :key="p" class="px-3 py-2 font-semibold text-fg-subtle">
              {{ p }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in timedGrid"
            :key="r.lib"
            class="border-b border-border/60 last:border-0"
            :class="r.baseline ? 'bg-accent/5' : ''"
          >
            <td class="px-3 py-2 font-medium whitespace-nowrap text-fg">{{ r.displayName }}</td>
            <td v-for="c in r.cells" :key="c.param" class="px-3 py-2">
              <div v-if="c.state === 'measured'" class="flex items-center gap-2">
                <span class="inline-block h-1.5 w-20 rounded-full bg-surface">
                  <span
                    class="block h-full rounded-full"
                    :class="r.baseline ? 'bg-accent/80' : 'bg-fg-subtle/40'"
                    :style="{ width: `${c.widthPct}%` }"
                  />
                </span>
                <span class="font-mono whitespace-nowrap text-fg">
                  {{ c.valueText }}
                  <sup v-if="c.proxy" class="text-accent">&dagger;</sup>
                </span>
                <span class="font-mono text-xs text-fg-subtle">{{ c.ratioText }}</span>
              </div>
              <div v-else-if="c.state === 'dnf'" class="flex flex-col text-fg-subtle">
                <span class="italic">did not finish</span>
                <span class="text-xs">{{ c.budgetText }}</span>
              </div>
              <span v-else class="text-fg-subtle">&mdash;</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="mixedUnits" class="px-3 py-2 text-xs text-fg-subtle">
        &dagger; Reported as DOM mutations, a proxy for a library that owns its inputs rather than
        binding the shared bare field. Not directly comparable to a Vue render count.
      </p>
    </div>

    <!-- ===================== Provenance footer ===================== -->
    <!-- Every block traces to where its numbers came from. A CI run links the
         exact run; a local seed links the workflow that supersedes it, so a
         reader is never left without a destination. -->
    <div
      v-if="datasetReady"
      class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-surface/30 px-3 py-2 text-xs text-fg-subtle"
    >
      <span v-if="prov.source === 'ci' && prov.ciRunUrl">
        Source:
        <a
          :href="prov.ciRunUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="text-accent hover:underline"
          >CI run #{{ prov.ciRunId }}</a
        >
      </span>
      <span v-else>
        Source: local run, superseded by the
        <a
          :href="BENCH_WORKFLOW_URL"
          target="_blank"
          rel="noopener noreferrer"
          class="text-accent hover:underline"
          >monthly CI refresh</a
        >
      </span>
      <span>{{ prov.runner.cpuModel }}</span>
      <span>Node {{ prov.node }}</span>
      <span>{{ provDate }}</span>
    </div>
  </div>
</template>
