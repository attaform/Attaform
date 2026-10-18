/** Type surface for the browser-floor gate, consumed by test/scripts/check-browser-floor.test.ts. */

/** MDN browser-compat-data `version_added` per floor browser; `false` is "not supported". */
export interface SupportRow {
  chrome: string | false
  edge: string | false
  firefox: string | false
  safari: string | false
}

/** One construct past the floor, at one place in one chunk. */
export interface FloorFinding {
  file: string
  line: number
  /** What was found: `regex lookbehind`, `Object.hasOwn`, `.findLast()`, ... */
  feature: string
  /** The floor browsers it leaves out, or why it is unclassified. */
  since: string
}

/** How a chunk reads a global: always guarded by `typeof`, or at least once directly. */
export type GlobalUse = 'direct' | 'detected'

/** The declared floor, per browser. */
export declare const FLOOR: { safari: string; chrome: string; firefox: string; edge: string }

/** Globals and statics within the floor, keyed by `Name` or `Name.member`. */
export declare const ALLOWED_GLOBALS: Record<string, SupportRow>

/** Globals and statics past the floor that a report names with their versions. */
export declare const KNOWN_PAST_FLOOR: Record<string, SupportRow>

/** Instance methods newer than the floor, matched by property name. */
export declare const LATE_METHODS: Record<string, SupportRow>

/** Regex syntax no bundler lowers. */
export declare const REGEX_FEATURES: Record<string, SupportRow>

/** Syntax outside regexes that no transpiler lowers. */
export declare const SYNTAX_FEATURES: Record<string, SupportRow>

/** The floor browsers a row leaves out, as `Safari 15.4, Chrome 93`; empty within the floor. */
export declare function pastFloor(support: SupportRow): string

/** Allowlist entries the gate refuses: past the floor, or on both lists. */
export declare function allowlistViolations(): string[]

/** Every past-floor construct in one regex body. */
export declare function regexFeatures(pattern: string, flags: string): string[]

/**
 * Check one chunk's text. Pass `uses` to also collect every global and
 * static it reads.
 */
export declare function checkSource(
  text: string,
  file?: string,
  uses?: Map<string, GlobalUse>
): FloorFinding[]

/** `RUNTIME_ENTRIES` from `build.config.ts`. */
export declare function runtimeEntries(): string[]

/** Every chunk of one flavor reachable from `entries`, as sorted absolute paths. */
export declare function reachableChunks(distDir: string, entries: string[]): string[]

/** Run every check over both flavors of the built dist. */
export declare function checkBrowserFloor(): {
  chunks: string[]
  findings: FloorFinding[]
  uses: Map<string, GlobalUse>
}
