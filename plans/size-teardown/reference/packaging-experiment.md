# Worktree packaging experiment (fb532ad9, unbuild, no src changes)

| config                                          | packed   | unpacked | files |
| ----------------------------------------------- | -------- | -------- | ----- |
| main today (maps on, emitCJS, declaration:true) | 1.8 MB   | 6.9 MB   | 182   |
| sourcemap:false + emitCJS:false                 | 412.7 kB | 1.5 MB   | 80    |
| + declaration:'node16' (single .d.mts)          | 282.2 kB | 1.1 MB   | 62    |

Notes: exports map must drop ./nuxt require condition (nuxt.cjs). Remaining unpacked:
~557 KB unminified runtime mjs, ~433 KB d.mts (single copy), ~48 KB skills+bin, 2 legacy d.ts
(vue component stubs). Tarball -84% from config only; no consumer-bundle change.
