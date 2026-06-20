<script setup lang="ts">
  // Live gallery for docs/binding-inputs/third-party-components. Renders real
  // reka-ui (headless) and PrimeVue (themed) components, each bound with the
  // same `v-register="form.register(path)"` you would put on a native input,
  // and shows the resulting value + field state updating live.
  //
  // Docs-only by construction: this lives in components/content/, NOT in
  // docs-demos/, so it never seeds the playground REPL (which cannot resolve
  // third-party libs) or the demo smoke test. Nuxt UI's binding is covered by
  // the cross-library test matrix instead of rendered here.
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import {
    NumberFieldRoot,
    NumberFieldInput,
    NumberFieldIncrement,
    NumberFieldDecrement,
    SwitchRoot,
    SwitchThumb,
    PinInputRoot,
    PinInputInput,
  } from 'reka-ui'
  import InputText from 'primevue/inputtext'
  import Password from 'primevue/password'
  import InputNumber from 'primevue/inputnumber'
  import Rating from 'primevue/rating'

  const schema = z.object({
    username: z.string().min(2),
    password: z.string().min(8),
    age: z.number().int().min(0).max(120),
    rating: z.number().min(0).max(5),
    quantity: z.number().int().min(0),
    notify: z.boolean(),
    pin: z.array(z.string()),
  })

  const form = useForm({
    schema,
    defaultValues: {
      username: '',
      password: '',
      age: 18,
      rating: 3,
      quantity: 1,
      notify: false,
      pin: [],
    },
    key: 'docs-third-party-gallery',
  })

  const rows = [
    { path: 'username', lib: 'PrimeVue' },
    { path: 'password', lib: 'PrimeVue' },
    { path: 'age', lib: 'PrimeVue' },
    { path: 'rating', lib: 'PrimeVue' },
    { path: 'quantity', lib: 'reka-ui' },
    { path: 'notify', lib: 'reka-ui' },
    { path: 'pin', lib: 'reka-ui' },
  ] as const

  type Leaf = { connected?: boolean; focused?: boolean; dirty?: boolean } | undefined

  function state(path: string): { connected: boolean; focused: boolean; dirty: boolean } {
    const f = (form.fields as unknown as Record<string, Leaf>)[path]
    return { connected: !!f?.connected, focused: !!f?.focused, dirty: !!f?.dirty }
  }

  function value(path: string): string {
    const v = (form.values as unknown as Record<string, unknown>)[path]
    if (Array.isArray(v)) return v.length ? `[${v.map(String).join(', ')}]` : '[]'
    if (typeof v === 'boolean') return String(v)
    if (v === '' || v == null) return '(empty)'
    return String(v)
  }
</script>

<template>
  <div class="tp-gallery">
    <div class="tp-grid">
      <section class="tp-card">
        <header><span class="tp-lib tp-lib--prime">PrimeVue</span><h4>Text field</h4></header>
        <InputText v-register="form.register('username')" placeholder="jane.doe" />
      </section>

      <section class="tp-card">
        <header><span class="tp-lib tp-lib--prime">PrimeVue</span><h4>Password</h4></header>
        <Password
          v-register="form.register('password')"
          :feedback="false"
          toggle-mask
          placeholder="at least 8"
        />
      </section>

      <section class="tp-card">
        <header><span class="tp-lib tp-lib--prime">PrimeVue</span><h4>Number</h4></header>
        <InputNumber v-register="form.register('age')" :min="0" :max="120" show-buttons />
      </section>

      <section class="tp-card">
        <header><span class="tp-lib tp-lib--prime">PrimeVue</span><h4>Rating</h4></header>
        <Rating v-register="form.register('rating')" />
      </section>

      <section class="tp-card">
        <header><span class="tp-lib tp-lib--reka">reka-ui</span><h4>Number field</h4></header>
        <NumberFieldRoot v-register="form.register('quantity')" :min="0" class="tp-nf">
          <NumberFieldDecrement class="tp-nf-btn">-</NumberFieldDecrement>
          <NumberFieldInput class="tp-nf-input" />
          <NumberFieldIncrement class="tp-nf-btn">+</NumberFieldIncrement>
        </NumberFieldRoot>
      </section>

      <section class="tp-card">
        <header><span class="tp-lib tp-lib--reka">reka-ui</span><h4>Switch</h4></header>
        <SwitchRoot v-register="form.register('notify')" class="tp-switch">
          <SwitchThumb class="tp-switch-thumb" />
        </SwitchRoot>
      </section>

      <section class="tp-card">
        <header><span class="tp-lib tp-lib--reka">reka-ui</span><h4>PIN input</h4></header>
        <PinInputRoot v-register="form.register('pin')" class="tp-pin">
          <PinInputInput v-for="i in 4" :key="i" :index="i - 1" class="tp-pin-input" />
        </PinInputRoot>
      </section>
    </div>

    <table class="tp-readout">
      <thead>
        <tr>
          <th>Field</th>
          <th>Library</th>
          <th>Value</th>
          <th>connected</th>
          <th>focused</th>
          <th>dirty</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.path">
          <td
            ><code>{{ row.path }}</code></td
          >
          <td>{{ row.lib }}</td>
          <td class="tp-val"
            ><code>{{ value(row.path) }}</code></td
          >
          <td><span class="tp-dot" :class="{ on: state(row.path).connected }" /></td>
          <td><span class="tp-dot" :class="{ on: state(row.path).focused }" /></td>
          <td><span class="tp-dot" :class="{ on: state(row.path).dirty }" /></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style>
  .tp-gallery {
    --tp-border: #e2e8f0;
    --tp-bg: #ffffff;
    --tp-muted: #64748b;
    --tp-accent: #6366f1;
    --tp-on: #22c55e;
    --tp-off: #cbd5e1;
    margin: 1.5rem 0;
    font-size: 0.9rem;
  }
  .dark .tp-gallery {
    --tp-border: #2a3344;
    --tp-bg: #0f1729;
    --tp-muted: #94a3b8;
    --tp-off: #334155;
  }

  .tp-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    gap: 0.75rem;
  }
  .tp-card {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 0.9rem;
    border: 1px solid var(--tp-border);
    border-radius: 0.6rem;
    background: var(--tp-bg);
  }
  .tp-card header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .tp-card h4 {
    margin: 0;
    font-size: 0.85rem;
    font-weight: 600;
  }
  .tp-lib {
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
    color: #fff;
  }
  .tp-lib--prime {
    background: #10b981;
  }
  .tp-lib--reka {
    background: var(--tp-accent);
  }

  /* reka-ui is headless, so the gallery styles its parts. */
  .tp-nf {
    display: inline-flex;
    align-items: stretch;
    border: 1px solid var(--tp-border);
    border-radius: 0.5rem;
    overflow: hidden;
    width: fit-content;
  }
  .tp-nf-input {
    width: 3.5rem;
    border: 0;
    text-align: center;
    background: var(--tp-bg);
    color: inherit;
    font: inherit;
  }
  .tp-nf-input:focus {
    outline: 2px solid var(--tp-accent);
    outline-offset: -2px;
  }
  .tp-nf-btn {
    border: 0;
    background: transparent;
    color: var(--tp-muted);
    padding: 0 0.7rem;
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
  }
  .tp-nf-btn:hover {
    background: color-mix(in srgb, var(--tp-accent) 12%, transparent);
    color: var(--tp-accent);
  }

  .tp-switch {
    width: 2.6rem;
    height: 1.5rem;
    border-radius: 999px;
    border: 0;
    padding: 0.15rem;
    background: var(--tp-off);
    cursor: pointer;
    transition: background 0.15s ease;
  }
  .tp-switch[data-state='checked'] {
    background: var(--tp-accent);
  }
  .tp-switch:focus-visible {
    outline: 2px solid var(--tp-accent);
    outline-offset: 2px;
  }
  .tp-switch-thumb {
    display: block;
    width: 1.2rem;
    height: 1.2rem;
    border-radius: 999px;
    background: #fff;
    transition: transform 0.15s ease;
  }
  .tp-switch-thumb[data-state='checked'] {
    transform: translateX(1.1rem);
  }

  .tp-pin {
    display: flex;
    gap: 0.4rem;
  }
  .tp-pin-input {
    width: 2.2rem;
    height: 2.6rem;
    text-align: center;
    border: 1px solid var(--tp-border);
    border-radius: 0.45rem;
    background: var(--tp-bg);
    color: inherit;
    font: inherit;
  }
  .tp-pin-input:focus {
    outline: 2px solid var(--tp-accent);
    outline-offset: -1px;
  }

  .tp-readout {
    width: 100%;
    margin-top: 1rem;
    border-collapse: collapse;
    font-size: 0.82rem;
  }
  .tp-readout th,
  .tp-readout td {
    text-align: left;
    padding: 0.35rem 0.6rem;
    border-bottom: 1px solid var(--tp-border);
  }
  .tp-readout th {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--tp-muted);
  }
  .tp-readout code {
    font-size: 0.78rem;
  }
  .tp-val code {
    color: var(--tp-accent);
  }
  .tp-dot {
    display: inline-block;
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 999px;
    background: var(--tp-off);
  }
  .tp-dot.on {
    background: var(--tp-on);
  }
</style>
