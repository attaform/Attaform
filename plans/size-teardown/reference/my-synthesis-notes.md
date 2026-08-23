# Personal pre-synthesis notes (verified by direct reads)

1. Adapter probe-table unification: both adapters already implement SchemaIntrospector
   (walker-introspector.ts x2). ~40 parallel accessors + duplicated recursion (containsAsyncRefine,
   hasContainerOrRootRefine, strip/rebuild/clone, fingerprint, slim-primitives, field-meta,
   assert-supported). Ideal: one engine + per-major probe table. Both-majors ~5-6 kB vs 12.6;
   single-major ~4 kB; dual-entry penalty +5.4 -> ~+1.2 kB. Maybe keep dual default viable.
2. Deeper option: kill schema-RECONSTRUCTION (strip/rebuild/clone, v4 strip.ts 616L, v3
   rebuild-schema+clone-schema+strip-async ~600L) by validating via walk instead of building
   stripped schema instances. Would delete ~3.5-4 kB total. Architects to weigh.
3. Build-plugin aliasing kills the dual-adapter default tax with zero DX loss (vite/nuxt plugins
   already exist; alias 'attaform' -> single-major entry chosen by detecting installed zod).
   Runtime lazy adapter is OFF the table: introspection must be sync at useForm for first paint.
4. Store facts: ~110-member return object; 32 Map/Set allocations per form; setValueAtPath 440
   lines (cognitive 148); reshapeUnionVariant 175L; reset ~200L. Fallow top target.
5. Verbosity archetypes measured: 12x conditional-spread, 68 try/catch, 85 canonicalizePath call
   sites (renormalization at every layer - bytes AND perf), 65 warn() sites, 101 **DEV** gates.
6. History weld: static import in use-abstract-form; only used when merged.history set. Move to
   attaform/history composable (useFormHistory(form)) or lazy module -> 1.1 kB off eager.
7. Directive weld: plugin.ts static vRegister; ensureAttaformInstalled called by every useForm.
   Options: split registry-install from directive-registration; directive registers itself only
   via createAttaform() (plugin entry) or first v-register compile (nuxt/vite transform can
   inject the import). Non-directive consumers shake ~4.6 kB.
8. Packaging measured: 1.8MB -> 282 kB packed via maps-off + emitCJS-off + node16 dts. Exports
   ./nuxt require-condition must drop. Remaining: 433 kB single d.mts, 557 kB unminified mjs.
