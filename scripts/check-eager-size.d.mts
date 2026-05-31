/** Type surface for the eager-size gate, consumed by test/packaging/dev-dce.test.ts. */

export interface EagerMeasurement {
  /** Gzipped bytes of the eager (first-paint) chunk set. */
  eagerGz: number
  /** Gzipped bytes of the lazily-imported chunks. */
  asyncGz: number
  /** Source inputs that compile into the eager chunks. */
  eagerInputs: string[]
  /** Source inputs that compile into the async chunks (includes orphans). */
  asyncInputs: string[]
  /** Source inputs of every chunk a consumer actually loads (excludes orphans). */
  reachableInputs: string[]
  /** Concatenated text of the eager chunks only. */
  eagerText: string
}

/**
 * Build the minimal-`useForm` (zod-v4) scenario with code-splitting and
 * return its eager/async byte split and reachability sets.
 * @param define esbuild `define` map; defaults to a production `NODE_ENV`.
 */
export declare function measureEager(define?: Record<string, string>): Promise<EagerMeasurement>
