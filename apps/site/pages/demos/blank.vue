<script setup lang="ts">
  // Lightweight starter seed. The homepage REPL keeps the full shipment
  // demo for its hero showcase; this page hands new visitors a minimal
  // username/password form (~30 lines of script) so the first thing
  // they see is something tractable to start editing.
  import blankStarterSource from '~/repl-demos/blank-starter.vue?raw'

  useHead({ title: 'Blank playground' })
  useSeoMeta({
    description:
      'A blank-slate Attaform playground. Start from a minimal username/password form and edit anything in your browser.',
  })
</script>

<template>
  <div class="relative isolate overflow-hidden">
    <!-- Ambient dot-grid. Custom radial-gradient (rather than the
         `bg-dot-grid` utility) so the dots paint in
         `--color-border-strong` (gray-300) — one step darker than
         the default border color, the difference between "barely
         there" and "actually visible." Top-anchored mask fades the
         texture out before the editor starts. -->
    <div
      class="pointer-events-none absolute inset-0 -z-10"
      style="
        background-image: radial-gradient(
          circle at 0.0625rem 0.0625rem,
          var(--color-border-strong) 0.0625rem,
          transparent 0
        );
        background-size: 1.5rem 1.5rem;
        mask-image: radial-gradient(ellipse 70% 50% at 25% 15%, #000 30%, transparent 80%);
      "
      aria-hidden="true"
    />

    <UiContainer size="xl">
      <div class="py-12">
        <div class="mb-8 max-w-3xl">
          <p class="text-sm font-semibold tracking-wide text-accent uppercase">Live editor</p>
          <h1 class="mt-3 text-display-md font-semibold text-fg">Blank playground</h1>
          <p class="mt-4 text-lg text-fg-muted">
            A real Attaform form, running on the live
            <UiInlineCode>attaform</UiInlineCode> source. Edit the schema, watch the form re-render.
            Errors update synchronously by default.
          </p>
          <p class="mt-3 text-sm text-fg-subtle">
            Looking for a specific demo? See
            <NuxtLink to="/demos" class="text-accent hover:underline">all demos</NuxtLink>.
          </p>
        </div>
        <DemoRepl height="calc(100vh - 20rem)" :initial-source="blankStarterSource" />
      </div>
    </UiContainer>
  </div>
</template>
