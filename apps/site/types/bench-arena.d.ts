// The benchmark results ship as a single JSON artifact produced by the
// bench-arena orchestrator. Typing the import as `unknown` (rather than letting
// resolveJsonModule deep-infer a ~300 KB literal on every typecheck) keeps
// vue-tsc fast; BenchArena.vue casts it to a hand-written `Results` interface
// and guards `schemaVersion` at runtime, so the shape is validated where it is
// consumed, not inferred from the data.
declare module 'attaform-bench-arena/results.json' {
  const results: unknown
  export default results
}
