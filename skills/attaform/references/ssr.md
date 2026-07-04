# SSR

SSR is automatic under the Nuxt module or the Vite plugin. Field values, `checked`, and `selected` are rendered into the first paint and ARIA is emitted, with no extra wiring. You do not opt in and you do not configure it. What follows matters mostly when you are _debugging_ SSR or writing a test that touches it.

## The value injection is a build-time transform

On the compiled template path, `v-register`'s SSR value / `checked` / `selected` injection is a **build-time Vue-compiler transform** (from `attaform/vite`, wired by the `attaform/nuxt` module), not a runtime `getSSRProps`. On that path `getSSRProps` emits only the `aria-*` attributes; the value rides on the compile-time transform. On the runtime render-function path (a hand-written `h()` component), the value instead comes through `getSSRProps`. Both paths reach the same rendered HTML; they differ only in _which_ mechanism carries the value.

One consequence worth knowing: a `<input :type="...">` with a _dynamic_ type bails the input transform, so give an input a static `type` when you want the compile-time SSR value.

## Confirm SSR through the real build

Always confirm an Attaform SSR claim through the **real build**: curl or inspect the server-rendered HTML of a real (or throwaway) page. Never judge SSR behavior from a bare unit render.

The reason is the transform above. A plain Vitest render (bare `vue()`, no Attaform compiler transform) **cannot** see SSR-injected values for a compiled form component, so a check written there fails even when production is correct. A naive isolated Node render experiment false-negatives for the same reason: the transform is not present, so even the correct shape looks broken.

## Test traps

- **Do not hand-wire `attaform/vite` into `vitest.config.ts`** to force a green. That fakes a third compile pipeline that matches neither production nor a clean unit test, and it hides the real reason a bare test cannot see the value.
- A faithful SSR test goes through the real build: a Nuxt-level test with `@nuxt/test-utils`. The one lower-level exception is a test that itself invokes `@vue/compiler-sfc`'s `compileTemplate` with Attaform's real node transforms, which reproduces the compiled path honestly.

## One concern that stays in your app

Attaform handles the SSR-adjacent details itself: the value injection above, and error-focus (which requests `focusVisible: true`, so the ring paints even when focus moves programmatically to a radio or checkbox). One SSR pattern is still the app's responsibility:

- **Seeding a page-owned form from async data races SSR.** If an ancestor lifts a form (so it can be injected downward) and seeds it from an async query through an immediate `watch`, the server's watch runs before the query resolves and does not re-fire, so the server renders empty while the client hydrates filled: a hydration mismatch. Seed **both legs**: a client immediate `watch` and a server `onServerPrefetch` that awaits the query, then seeds. A form created lazily behind a resolved gate never hits this.
