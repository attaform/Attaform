/**
 * Augments `NodeJS.ProcessEnv` with an explicit, optional `NODE_ENV`.
 *
 * `core/dev.ts` reads `process.env.NODE_ENV` via dot-access so consumer
 * bundlers can replace it and dead-code-eliminate the dev branches.
 * tsconfig sets `noPropertyAccessFromIndexSignature`, under which
 * dot-access on `ProcessEnv`'s bare index signature is a compile error.
 * Declaring `NODE_ENV` as a real member makes that one read legal
 * without relaxing the rule for the rest of the codebase.
 *
 * Type-system only; nothing is emitted. The `?` keeps it honest under
 * `exactOptionalPropertyTypes`: the variable may be unset at runtime.
 */
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NODE_ENV?: string
    }
  }
}

export {}
