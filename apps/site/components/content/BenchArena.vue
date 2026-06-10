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
    median: number
    p95: number
    unit: string
    supported: boolean
    ratio: number | null
    slope: number
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
  if (results.schemaVersion !== 1) {
    throw new Error(
      `[BenchArena] results.json schemaVersion ${results.schemaVersion} is unsupported ` +
        `(this component renders schemaVersion 1). Update BenchArena.vue to the new shape ` +
        `or re-run the bench-arena orchestrator to emit a compatible results.json.`
    )
  }

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

  // Per-column bar scale, over supported rows only.
  const colMax = (param: string) => {
    const rows = block.value?.byParam[param] ?? []
    const vals = rows
      .filter((r) => r.supported)
      .map((r) => ('retained' in r ? r.retained.median : r.median))
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
        return {
          param,
          row,
          max: colMax(param),
          proxy: !!row && row.unit !== b.unit,
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
  const mixedUnits = computed(() => timedGrid.value.some((r) => r.cells.some((c) => c.proxy)))

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

  // --- provenance ---------------------------------------------------------
  const prov = results.provenance
  const provDate = computed(() => shortDate(prov.timestamp))
</script>

<template>
  <div class="not-prose my-6 overflow-hidden rounded-xl border border-border bg-bg shadow-sm">
    <!-- ===================== Capability matrix ===================== -->
    <div v-if="mode === 'capabilities'" class="overflow-x-auto">
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
              <div v-if="c.row && c.row.supported" class="flex items-center gap-2">
                <span class="inline-block h-1.5 w-20 rounded-full bg-surface">
                  <span
                    class="block h-full rounded-full"
                    :class="r.baseline ? 'bg-accent/80' : 'bg-fg-subtle/40'"
                    :style="{ width: `${barPct(c.row.median, c.max)}%` }"
                  />
                </span>
                <span class="font-mono whitespace-nowrap text-fg">
                  {{ fmtTimed(c.row.median, c.row.unit) }}
                  <sup v-if="c.proxy" class="text-accent">&dagger;</sup>
                </span>
                <span class="font-mono text-xs text-fg-subtle">{{ fmtRatio(c.row.ratio) }}</span>
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
    <div
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
      <span v-else>Source: local run (illustrative shape data; superseded by CI)</span>
      <span>{{ prov.runner.cpuModel }}</span>
      <span>Node {{ prov.node }}</span>
      <span>{{ provDate }}</span>
    </div>
  </div>
</template>
