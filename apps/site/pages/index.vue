<script setup lang="ts">
  import { codeToHtml } from 'shiki'
  import {
    ShieldCheck,
    Zap,
    Layers,
    Server,
    Workflow,
    TerminalSquare,
    Webhook,
    MonitorSmartphone,
    ArrowRight,
    ExternalLink,
  } from 'lucide-vue-next'

  // Feature cards on the homepage. Same single-color icon-chip
  // discipline as the docs landing: every chip on this page uses
  // the brand-soft pair so the page reads as one product surface.
  // Eight cards: types + validation + arrays + persistence (the
  // "first scroll" group), then multistep + devtools + server
  // errors + multi-tab (the "stays nice as the form grows" group).
  const { attaformVersion } = useRuntimeConfig().public

  // Canonical snippet for the "From schema to submit" section.
  // Every `<` is the JS escape `<` so the Vue SFC tokenizer
  // never sees a literal tag inside this script block, while the
  // string Shiki receives reads as actual Vue source. Highlighted
  // at SSR with the same dual-theme pair the docs pipeline uses,
  // so the dark-mode swap stays css-only.
  const LT = '<'
  const signupSnippet = [
    `${LT}script setup lang="ts">`,
    "  import { z } from 'zod'",
    "  import { useForm } from 'attaform/zod'",
    '',
    '  const schema = z.object({',
    '    email: z.string().email(),',
    '    password: z.string().min(8),',
    '  })',
    '',
    "  const form = useForm({ schema, key: 'signup' })",
    '  const onSubmit = form.handleSubmit((values) => api.signup(values))',
    `${LT}/script>`,
    '',
    `${LT}template>`,
    `  ${LT}form @submit.prevent="onSubmit">`,
    `    ${LT}input v-register="form.register('email')" />`,
    `    ${LT}p v-if="form.errors.email">{{ form.errors.email[0].message }}${LT}/p>`,
    '',
    `    ${LT}button :disabled="form.meta.submitting">Sign up${LT}/button>`,
    `  ${LT}/form>`,
    `${LT}/template>`,
  ].join('\n')

  // The v-register showcase one-liners. Same Shiki pipeline as the
  // canonical snippet so all five code blocks share one visual
  // grammar.
  const registerLines = [
    `${LT}input v-register="form.register('email')" />`,
    `${LT}input v-register="form.register('email', { persist: true })" />`,
    `${LT}input v-register="form.register('email', { persist: true, transforms: [lowercase], multiTab: false })" />`,
  ]

  // The wizard callout snippet. Pure TS expressions, so we tell
  // Shiki `lang: 'ts'` rather than 'vue' to get the right token
  // grammar (object keys, string literals, identifiers).
  const wizardSnippet = [
    "const shipping = useForm({ schema: shippingSchema, key: 'shipping' })",
    "const payment  = useForm({ schema: paymentSchema,  key: 'payment'  })",
    '',
    'const wizard = useWizard({',
    "  steps: ['welcome', shipping, payment, 'review'],",
    '})',
  ].join('\n')

  const highlight = (source: string, lang: 'vue' | 'ts') =>
    codeToHtml(source, {
      lang,
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
    })

  const { data: highlightedSnippets } = await useAsyncData('homepage-snippets', async () => {
    const [signup, lineOne, lineTwo, lineThree, wizard] = await Promise.all([
      highlight(signupSnippet, 'vue'),
      highlight(registerLines[0]!, 'vue'),
      highlight(registerLines[1]!, 'vue'),
      highlight(registerLines[2]!, 'vue'),
      highlight(wizardSnippet, 'ts'),
    ])
    return { signup, lineOne, lineTwo, lineThree, wizard }
  })

  const signupSnippetHtml = computed(() => highlightedSnippets.value?.signup ?? '')
  const wizardSnippetHtml = computed(() => highlightedSnippets.value?.wizard ?? '')
  const registerLineHtml = (key: 'lineOne' | 'lineTwo' | 'lineThree') =>
    computed(() => highlightedSnippets.value?.[key] ?? '')

  const registerLineOneHtml = registerLineHtml('lineOne')
  const registerLineTwoHtml = registerLineHtml('lineTwo')
  const registerLineThreeHtml = registerLineHtml('lineThree')

  // Schema.org SoftwareApplication entry — the canonical structured-
  // data shape for a developer library / dev-tool. Eligible for
  // Google's software rich card (the side panel that shows name,
  // category, rating, license, and a screenshot when present). Even
  // without the rich card, this is a strong topical signal: the page
  // is about a piece of software named "Attaform" in the
  // DeveloperApplication category, free, MIT-licensed, by a named
  // author. `defineSoftwareApp` from nuxt-schema-org auto-resolves
  // url + image against `site.url`.
  useSchemaOrg([
    defineSoftwareApp({
      name: 'Attaform',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Cross-platform',
      description:
        'A type-safe, schema-driven form library for Vue 3 and Nuxt with first-class Zod support.',
      url: 'https://www.attaform.com',
      author: { '@type': 'Person', name: 'Oswald Chisala' },
      // MIT-licensed and free — surface the price-zero offer so the
      // SoftwareApplication node validates against Google's required
      // properties (name, description, applicationCategory, offers).
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      softwareVersion: attaformVersion,
    }),
  ])

  const features = [
    {
      icon: ShieldCheck,
      title: 'Schema-driven types',
      body: 'Every path, value, and error is inferred from your Zod schema. No `any`, no manual type plumbing.',
    },
    {
      icon: Zap,
      title: 'Live validation',
      body: 'Per-field validation on change, blur, or submit. Synchronous by default; async refinements await before submit dispatches.',
    },
    {
      icon: Layers,
      title: 'Field arrays + undo/redo',
      body: 'Typed `append` / `insert` / `remove` / `swap`, plus a bounded undo stack you can opt into per-form.',
    },
    {
      icon: Server,
      title: 'SSR + persistence',
      body: 'Nuxt round-trips payload automatically. Per-field opt-in drafts to localStorage / sessionStorage / IndexedDB.',
    },
    {
      icon: Workflow,
      title: 'First-class multistep',
      body: '`useWizard` composes `useForm` instances into a flow. Shared navigation, per-step validation, persistence across steps, deep-link restore.',
    },
    {
      icon: TerminalSquare,
      title: 'DevTools panel',
      body: 'A Nuxt-auto-wired devtools panel. Walk history, edit values live, inspect every form on the page. No probes to install.',
    },
    {
      icon: Webhook,
      title: 'Server-side errors',
      body: '`parseApiErrors(payload, { formKey: form.key })` normalizes any API envelope into the same `ValidationError` shape your template already reads.',
    },
    {
      icon: MonitorSmartphone,
      title: 'Multi-tab sync',
      body: 'Same-keyed forms in same-origin tabs auto-pair over `BroadcastChannel` and mirror every mutation in near real-time. Sensitive paths filtered.',
    },
  ]
</script>

<template>
  <div>
    <!-- ─── Hero ─────────────────────────────────────────────────
         Three layered backgrounds: the dot-grid (faintest), then the
         accent-soft glow that bleeds from the top, then the page
         content. Each layer is masked at the edges so they fade out
         instead of running into the next section. The whole region
         enters via a four-step stagger (eyebrow → heading → lede →
         CTAs); reduced-motion users see it pop instantly. -->
    <section class="relative isolate overflow-hidden border-b border-border">
      <!-- Dot-grid layer — sits beneath the glow. We paint the
           gradient inline (rather than the `bg-dot-grid` utility)
           so the dots use `--color-border-strong` (gray-300, one
           step darker than the utility's `--color-border`); against
           the page bg the default is too pale to read as
           texture. The mask centers the pattern under the heading
           and fades it out at ~80% so it never reaches the CTA row
           or the section seam. -->
      <div
        class="absolute inset-0 -z-20"
        style="
          background-image: radial-gradient(
            circle at 0.0625rem 0.0625rem,
            var(--color-border-strong) 0.0625rem,
            transparent 0
          );
          background-size: 1.5rem 1.5rem;
          mask-image: radial-gradient(ellipse 75% 70% at 50% 30%, #000 30%, transparent 80%);
        "
        aria-hidden="true"
      />
      <!-- Accent-soft glow — top-anchored radial fade. Lighter in dark
           mode where the tint risks reading as muddy. -->
      <div
        class="absolute inset-0 -z-10 bg-glow-hero opacity-90 dark:opacity-70"
        aria-hidden="true"
      />

      <UiContainer size="xl">
        <div class="flex max-w-4xl flex-col items-start gap-8 py-24 md:py-32">
          <a
            href="https://github.com/attaform/attaform/releases"
            target="_blank"
            rel="noopener noreferrer"
            class="reveal-step group inline-flex items-center gap-2 rounded-full border border-warm/30 bg-bg/80 py-1 pr-2 pl-3 text-sm font-medium text-fg-muted shadow-xs backdrop-blur transition-[color,border-color,background-color] duration-(--duration-fast) hover:border-accent/40 hover:text-fg"
            style="--reveal-step-delay: 0ms"
          >
            <span class="relative inline-flex h-1.5 w-1.5">
              <span
                class="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-50"
              />
              <span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
            </span>
            <span>v{{ attaformVersion }} · what's new</span>
            <ArrowRight
              class="h-4 w-4 text-fg-subtle transition-transform duration-(--duration-fast) group-hover:translate-x-0.5"
              :stroke-width="2.25"
            />
          </a>

          <h1
            class="reveal-step text-display-md font-semibold tracking-tight text-balance text-fg sm:text-display-lg md:text-display-xl"
            style="--reveal-step-delay: 60ms"
          >
            A schema is a form's <span class="text-accent">best friend.</span>
          </h1>

          <!-- Keyword-rich sub-headline. The H1 above keeps its voice;
               this H2 gives crawlers (and readers who skim) the plain-
               English value prop in one line, with the high-intent
               phrase "form library for Vue 3 and Nuxt" near the top of
               the document outline. The next section's "Why Attaform"
               H2 is its own heading lower down — having two H2s on the
               page is fine; document-outline tools just thread them
               sequentially. -->
          <h2
            class="reveal-step max-w-3xl text-xl font-medium tracking-tight text-balance text-fg-muted sm:text-2xl"
            style="--reveal-step-delay: 100ms"
          >
            The
            <span class="font-semibold text-fg">type-safe, schema-driven</span> form library for
            Vue&nbsp;3 and Nuxt.
          </h2>

          <p
            class="reveal-step max-w-2xl text-lg text-balance text-fg-muted"
            style="--reveal-step-delay: 140ms"
          >
            Hand a Zod schema to <UiInlineCode>useForm</UiInlineCode> and Attaform turns it into a
            reactive form, typed end-to-end, with live errors and SSR out of the box. It scales from
            the simplest forms to the most comprehensive multistep wizards while keeping the core
            experience clear and focused. Because Vue and Nuxt devs deserve nice things, too.
          </p>

          <div class="reveal-step flex flex-wrap gap-3" style="--reveal-step-delay: 180ms">
            <UiButton to="/docs/getting-started/quick-start" size="xl">
              <span>Quick start</span>
              <ArrowRight class="h-5 w-5" :stroke-width="2.25" />
            </UiButton>
            <UiButton to="/demos" size="xl" variant="secondary">Try it live</UiButton>
            <UiButton href="https://github.com/attaform/attaform" size="xl" variant="ghost">
              <UiBrandGithub class="h-5 w-5" />
              <span>GitHub</span>
            </UiButton>
          </div>

          <!-- Trust strip — small dot-separated facts about runtime
               surface. Shows breadth ("works with multiple Vues, Zods,
               and bundlers") without paragraphs of marketing prose. -->
          <ul
            class="reveal-step mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-fg-subtle"
            style="--reveal-step-delay: 240ms"
            aria-label="Project facts"
          >
            <li>MIT licensed</li>
            <li class="h-1 w-1 rounded-full bg-fg-subtle" aria-hidden="true" />
            <li>Vue 3 · Nuxt 3 / 4</li>
            <li class="h-1 w-1 rounded-full bg-fg-subtle" aria-hidden="true" />
            <li>Zod 3 / 4</li>
            <li class="h-1 w-1 rounded-full bg-fg-subtle" aria-hidden="true" />
            <li>Tree-shakable ESM</li>
          </ul>
        </div>
      </UiContainer>
    </section>

    <!-- ─── Pitch ────────────────────────────────────────────────
         Three principle blocks between the hero and the feature
         grid. No section eyebrow: the hinge wants to read as
         confident assertion, not "here begins another section".
         Schema-first thesis (left), v-register payoff (middle),
         scale story (right). Wraps to 2 + 1 at md so the scale
         block gets a solo row at the tablet breakpoint. -->
    <section class="border-b border-border bg-surface/30 py-20 md:py-24">
      <UiContainer size="xl">
        <div class="grid gap-10 md:grid-cols-2 md:gap-x-12 lg:grid-cols-3">
          <div>
            <h2 class="text-xl font-semibold tracking-tight text-balance text-fg sm:text-2xl">
              Schema in, form out.
            </h2>
            <p class="mt-3 text-base text-fg-muted">
              One Zod schema is the source of truth for types, defaults, validation, errors, and
              metadata. Define it once. Every reactive surface inherits.
            </p>
          </div>
          <div>
            <h2 class="text-xl font-semibold tracking-tight text-balance text-fg sm:text-2xl">
              One directive. The whole binding stack.
            </h2>
            <p class="mt-3 text-base text-fg-muted">
              <UiInlineCode>v-register</UiInlineCode> is a Vue directive, not a wrapper component.
              One line on a native <UiInlineCode>&lt;input&gt;</UiInlineCode> opts that field into
              typed binding, coercion, persistence, multi-tab sync, and the sensitive-name guard.
            </p>
          </div>
          <div>
            <h2 class="text-xl font-semibold tracking-tight text-balance text-fg sm:text-2xl">
              From tiny forms to multistep flows.
            </h2>
            <p class="mt-3 text-base text-fg-muted">
              <UiInlineCode>useForm</UiInlineCode> handles a single-field signup.
              <UiInlineCode>useWizard</UiInlineCode> composes those forms into a flow with shared
              state, validation, and persistence. Same composables, all the way up.
            </p>
          </div>
        </div>
      </UiContainer>
    </section>

    <!-- ─── v-register showcase ──────────────────────────────────
         Progressive disclosure on the directive itself. Three
         single-line snippets stacked vertically; each adds one more
         option to `register()` to demonstrate that the markup never
         changes shape. The caption under each row points at what
         the directive just gained. Concrete payoff: "v-register
         scales by options, not by template surgery." -->
    <section class="border-b border-border py-24">
      <UiContainer size="xl">
        <div class="max-w-2xl">
          <p class="text-sm font-semibold tracking-wide text-accent uppercase">The directive</p>
          <h2 class="mt-3 text-display-md font-semibold tracking-tight text-fg">
            One line on a native input.
          </h2>
          <p class="mt-4 text-lg text-fg-muted">
            <UiInlineCode>v-register</UiInlineCode> stays on the same
            <UiInlineCode>&lt;input&gt;</UiInlineCode>. Every option you add opts into another
            runtime feature without touching the template. The markup never grows.
          </p>
        </div>

        <ol class="mt-12 space-y-8">
          <li>
            <div class="homepage-shiki homepage-shiki--inline" v-html="registerLineOneHtml" />
            <p class="mt-3 max-w-3xl text-base text-fg-muted">
              Typed two-way binding to <UiInlineCode>form.values.email</UiInlineCode>, with
              schema-driven coercion at the directive layer.
            </p>
          </li>
          <li>
            <div class="homepage-shiki homepage-shiki--inline" v-html="registerLineTwoHtml" />
            <p class="mt-3 max-w-3xl text-base text-fg-muted">
              Same line. The field now writes through to the form's persistence backend on every
              keystroke, with the sensitive-name guard catching accidental
              <UiInlineCode>password</UiInlineCode>-style opt-ins before they reach storage.
            </p>
          </li>
          <li>
            <div class="homepage-shiki homepage-shiki--inline" v-html="registerLineThreeHtml" />
            <p class="mt-3 max-w-3xl text-base text-fg-muted">
              Same line. Add a sync DOM-input transform, opt out of multi-tab sync, all without
              touching the markup elsewhere on the page.
            </p>
          </li>
        </ol>

        <div class="mt-10">
          <UiButton to="/docs/binding-inputs/v-register" variant="link">
            <span>Read the v-register reference</span>
            <ArrowRight class="h-4 w-4" :stroke-width="2.25" />
          </UiButton>
        </div>
      </UiContainer>
    </section>

    <!-- ─── Canonical snippet ────────────────────────────────────
         The full schema → form → bindings arc in one screenful.
         Mirrors the README's quick-start example so a reader who
         saw either surface gets the same shape. Rendered as a
         Shiki-highlighted code block (same theme pair the docs
         pipeline uses) so it visually reads as "reference code",
         not a live demo. -->
    <section class="border-b border-border bg-surface/30 py-24">
      <UiContainer size="xl">
        <div class="max-w-2xl">
          <p class="text-sm font-semibold tracking-wide text-accent uppercase">Reference</p>
          <h2 class="mt-3 text-display-md font-semibold tracking-tight text-fg">
            From schema to submit.
          </h2>
          <p class="mt-4 text-lg text-fg-muted">
            One schema, one <UiInlineCode>useForm</UiInlineCode> call, one form handle. Reactive
            values, live errors, and a submit guard, all from the same source of truth.
          </p>
        </div>

        <!-- Shiki injects inline styles for both light and dark
             themes; the `homepage-shiki` wrapper toggles between
             them via the dark-mode class on <html>. -->
        <div class="homepage-shiki mt-10" v-html="signupSnippetHtml" />
      </UiContainer>
    </section>

    <!-- ─── Features ─────────────────────────────────────────────
         Eyebrow + display + lede composition (matches docs landing
         and /demos), then a 2-column feature grid. Each row is icon
         chip + title + body, denser than the homepage's prior flat
         paragraph list, and the icon chips give the eye anchors as
         it scrolls. No on-scroll reveal here: the section renders
         in its final state on first paint. -->
    <section class="border-b border-border py-24">
      <UiContainer size="xl">
        <div class="max-w-2xl">
          <p class="text-sm font-semibold tracking-wide text-accent uppercase">Why Attaform</p>
          <h2 class="mt-3 text-display-md font-semibold tracking-tight text-fg">
            Schema-driven, end to end.
          </h2>
          <p class="mt-4 text-lg text-fg-muted">
            Inferred types. Live validation. Multistep flows. Devtools. Server-side errors,
            multi-tab sync, persistence, undo/redo. Everything you need, nothing you have to wire.
          </p>
        </div>

        <div class="mt-16 grid gap-x-12 gap-y-10 md:grid-cols-2">
          <div v-for="feature in features" :key="feature.title" class="flex gap-4">
            <div
              class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-soft-fg"
            >
              <component :is="feature.icon" class="h-6 w-6" :stroke-width="2" />
            </div>
            <div>
              <h3 class="text-lg font-semibold text-fg">{{ feature.title }}</h3>
              <p class="mt-1.5 text-base text-fg-muted">
                <UiCodedText :text="feature.body" />
              </p>
            </div>
          </div>
        </div>

        <div class="mt-12">
          <UiButton to="/docs/getting-started/why-attaform" variant="link">
            <span>Read the full case for Attaform</span>
            <ArrowRight class="h-4 w-4" :stroke-width="2.25" />
          </UiButton>
        </div>
      </UiContainer>
    </section>

    <!-- ─── Live demo ────────────────────────────────────────────
         The interactive REPL embed. Same eyebrow/display/lede
         pattern plus a "Check out more demos" link button on the
         right of the heading row that's an obvious affordance to
         escape the embedded view. The frame around the embed
         elevates it from "floating widget" to "real artifact":
         a hairline accent-soft strip across the top, a 2xl shadow,
         and a strong border. -->
    <section class="py-24">
      <UiContainer size="xl">
        <div class="mb-10 flex flex-wrap items-end justify-between gap-6">
          <div class="max-w-2xl">
            <p class="text-sm font-semibold tracking-wide text-accent uppercase">Live editor</p>
            <h2 class="mt-3 text-display-md font-semibold tracking-tight text-fg">
              A schema is the form.
            </h2>
            <p class="mt-4 text-lg text-fg-muted">
              Edit the schema, edit the template, watch it run. No backend, no build step, every
              change re-renders live.
            </p>
          </div>
          <UiButton to="/demos" variant="link">
            <span>Check out more demos</span>
            <ArrowRight class="h-4 w-4" :stroke-width="2.25" />
          </UiButton>
        </div>
        <div
          class="relative overflow-hidden rounded-2xl border border-border-strong bg-bg shadow-2xl"
        >
          <!-- Hairline accent strip at the top edge — same depth cue
               as a real card but more "this is the marquee piece" than
               the standard border. -->
          <div
            class="absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-accent to-transparent"
            aria-hidden="true"
          />
          <!-- Demo chrome — mirrors the inline `<DocsDemo>` header on
               docs pages: a tiny label on the left and an "Open in
               playground" affordance on the right, so a reader who
               wants to fork the homepage's seed can do so without
               hunting through the demos index for it. The link points
               at /demos/shipment, the dedicated full-page editor for
               this same hero seed. -->
          <div
            class="relative flex items-center justify-between border-b border-border bg-surface/40 px-3"
          >
            <span class="px-3 py-2 text-xs font-semibold text-fg">Shipment demo</span>
            <NuxtLink
              to="/demos/shipment"
              class="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-fg-subtle transition-colors duration-(--duration-fast) hover:text-fg"
            >
              Open in playground
              <ExternalLink class="h-3.5 w-3.5" :stroke-width="2" />
            </NuxtLink>
          </div>
          <DemoRepl height="37.5rem" />
        </div>
      </UiContainer>
    </section>

    <!-- ─── Multistep callout ───────────────────────────────────
         Half-and-half row: copy on the left, a tight useWizard
         snippet on the right. Acknowledges multistep on the home
         page since most form libraries don't ship a wizard
         primitive at all. The snippet pairs two `useForm` handles
         with two affordance steps (bare string keys) to show that
         affordance positions are first-class. -->
    <section class="border-t border-border bg-surface/30 py-24">
      <UiContainer size="xl">
        <div class="grid items-center gap-12 md:grid-cols-2 md:gap-x-16">
          <div>
            <p class="text-sm font-semibold tracking-wide text-accent uppercase">Multistep</p>
            <h2 class="mt-3 text-display-md font-semibold tracking-tight text-fg">
              A wizard, batteries included.
            </h2>
            <p class="mt-4 text-lg text-fg-muted">
              <UiInlineCode>useWizard</UiInlineCode> takes an ordered list of step slots and
              produces a reactive wizard. Form steps gather data; bare string keys mark affordance
              steps (welcome screens, review surfaces, congrats cards). Universal
              <UiInlineCode>handleSubmit</UiInlineCode>, shared persistence, URL sync, all in one
              composable.
            </p>
            <div class="mt-6">
              <UiButton to="/docs/multistep/use-wizard" variant="link">
                <span>Read the useWizard guide</span>
                <ArrowRight class="h-4 w-4" :stroke-width="2.25" />
              </UiButton>
            </div>
          </div>
          <div class="homepage-shiki" v-html="wizardSnippetHtml" />
        </div>
      </UiContainer>
    </section>

    <!-- ─── Bottom CTA ───────────────────────────────────────────
         Centered close — gives the page a definite "end" rather
         than dribbling into the footer. Leads with the install
         command itself so a reader who scrolled the whole page can
         act in one click without scrolling back to find a docs
         link. -->
    <section class="border-t border-border bg-surface/50 py-24">
      <UiContainer size="lg">
        <div class="flex flex-col items-center gap-6 text-center">
          <h2 class="max-w-2xl text-display-md font-semibold tracking-tight text-fg">
            Get started in 30 seconds.
          </h2>
          <p class="max-w-xl text-lg text-fg-muted">
            One install, one schema, one composable. Read the quick start or jump straight into the
            demos.
          </p>
          <div class="flex flex-wrap justify-center gap-3">
            <UiButton to="/docs/getting-started/quick-start" size="xl">
              <span>Quick start</span>
              <ArrowRight class="h-5 w-5" :stroke-width="2.25" />
            </UiButton>
            <UiButton to="/demos" size="xl" variant="secondary">Try it live</UiButton>
          </div>
        </div>
      </UiContainer>
    </section>
  </div>
</template>

<style scoped>
  /* Hero stagger — every `.reveal-step` runs the same fade-up keyframe
     (defined in `tailwind.css`) and consumes a per-element delay set
     inline as `--reveal-step-delay`. Single curve, four offsets means
     every line eases into the same shape — the cascade reads as
     deliberate composition, not animation-soup. */
  .reveal-step {
    animation: reveal-fade-up var(--duration-deliberate) var(--ease-out-quart) both;
    animation-delay: var(--reveal-step-delay, 0ms);
  }

  /* Shiki-highlighted canonical snippet. Shiki emits inline
     `--shiki-light` / `--shiki-dark` CSS variables on every token
     but doesn't pick a default; the rules below consume them so the
     dark-mode swap stays css-only. `:deep()` is needed because Vue's
     scoped CSS otherwise can't reach Shiki's injected markup. */
  .homepage-shiki :deep(.shiki) {
    border-radius: 0.75rem;
    border: 1px solid var(--color-border);
    padding: 1.5rem;
    font-size: 0.875rem;
    line-height: 1.6;
    overflow-x: auto;
    color: var(--shiki-light);
    background-color: var(--shiki-light-bg);
  }
  /* Compact variant for the single-line `v-register` showcase. The
     1.5rem all-around padding of the canonical snippet reads as
     excessive whitespace around a one-line block; tighten to a
     line-height-balanced inset instead. */
  .homepage-shiki--inline :deep(.shiki) {
    padding: 0.875rem 1.125rem;
    font-size: 0.875rem;
  }
  .homepage-shiki :deep(.shiki span) {
    color: var(--shiki-light);
  }
  :where(html.dark) .homepage-shiki :deep(.shiki) {
    color: var(--shiki-dark);
    background-color: var(--shiki-dark-bg);
  }
  :where(html.dark) .homepage-shiki :deep(.shiki span) {
    color: var(--shiki-dark);
  }
</style>
