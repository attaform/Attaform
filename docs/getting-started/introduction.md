---
title: Introduction
description: Attaform is a type-safe, schema-driven form library for Vue 3 and Nuxt — your Zod schema becomes the form, the validator, and the API contract in one move.
---

# Introduction

> One Zod schema, one typed reactive surface, one source of truth.

Attaform reads a Zod schema and hands back the form, ready to play — drillable `values`, per-field `errors`, a `meta` aggregate, and a `v-register` directive that binds every native input shape. **Your schema is the form.** The schema is the validator. The schema is the API contract.

Type-safe end to end. Errors surface at compile time, and the runtime keeps every value matched to what you declared. Server errors flow back through the same reactive surface, persistence opts in per field, SSR hydrates without flashes, and the DevTools panel shows the full picture right inside Nuxt DevTools.

## How these docs read

The sidebar walks top to bottom as a learning narrative — install, schema, bind, validate, submit, persist. Drop in anywhere — every concept is its own URL, its own definition, its own demo.

If you're new, start with the [Quick start](/docs/getting-started/quick-start). If you want our philosophy first, read [Why Attaform](/docs/getting-started/why-attaform). If you're hunting a specific surface, the sidebar's last category — **Reference** — is alphabetical and indexed.
