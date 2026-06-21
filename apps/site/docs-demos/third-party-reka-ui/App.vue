<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import {
    NumberFieldRoot,
    NumberFieldDecrement,
    NumberFieldInput,
    NumberFieldIncrement,
    SwitchRoot,
    SwitchThumb,
    PinInputRoot,
    PinInputInput,
  } from 'reka-ui'
  import './styles.css'

  const schema = z.object({
    quantity: z.number().int().min(0),
    notify: z.boolean(),
    pin: z.array(z.string()),
  })

  const form = useForm({
    schema,
    defaultValues: { quantity: 1, notify: false, pin: [] },
    key: 'docs-third-party-reka-ui',
  })
</script>

<template>
  <form class="demo" @submit.prevent>
    <div class="field">
      <small>reka-ui NumberField</small>
      <NumberFieldRoot v-register="form.register('quantity')" :min="0" class="nf">
        <NumberFieldDecrement class="nf-btn">-</NumberFieldDecrement>
        <NumberFieldInput class="nf-input" />
        <NumberFieldIncrement class="nf-btn">+</NumberFieldIncrement>
      </NumberFieldRoot>
      <div class="chips">
        <span class="chip" :class="{ on: form.fields('quantity')?.connected }">connected</span>
        <span class="chip" :class="{ on: form.fields('quantity')?.focused }">focused</span>
        <span class="chip" :class="{ on: form.fields('quantity')?.dirty }">dirty</span>
      </div>
    </div>

    <div class="field">
      <small>reka-ui Switch</small>
      <SwitchRoot v-register="form.register('notify')" class="switch">
        <SwitchThumb class="switch-thumb" />
      </SwitchRoot>
      <div class="chips">
        <span class="chip" :class="{ on: form.fields('notify')?.connected }">connected</span>
        <span class="chip" :class="{ on: form.fields('notify')?.focused }">focused</span>
        <span class="chip" :class="{ on: form.fields('notify')?.dirty }">dirty</span>
      </div>
    </div>

    <div class="field">
      <small>reka-ui PinInput</small>
      <PinInputRoot v-register="form.register('pin')" class="pin">
        <PinInputInput v-for="i in 4" :key="i" :index="i - 1" class="pin-input" />
      </PinInputRoot>
      <div class="chips">
        <span class="chip" :class="{ on: form.fields('pin')?.connected }">connected</span>
        <span class="chip" :class="{ on: form.fields('pin')?.focused }">focused</span>
        <span class="chip" :class="{ on: form.fields('pin')?.dirty }">dirty</span>
      </div>
    </div>

    <pre>{{ JSON.stringify(form.values, null, 2) }}</pre>
  </form>
</template>

<style>
  /* reka-ui ships headless, so the demo styles its parts with the same
     .demo tokens the generated stylesheet defines (so light and dark
     both follow the surrounding page). */
  .demo .field {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .demo .nf {
    display: inline-flex;
    align-items: stretch;
    width: fit-content;
    border: 1px solid var(--color-border-strong);
    border-radius: 0.375rem;
    overflow: hidden;
  }
  .demo .nf-input {
    width: 3.5rem;
    border: 0;
    text-align: center;
    background: var(--color-bg);
    color: var(--color-fg);
    font: inherit;
  }
  .demo .nf-input:focus {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
  }
  .demo .nf-btn {
    border: 0;
    padding: 0 0.75rem;
    background: var(--color-surface-2);
    color: var(--color-fg-muted);
    font-size: 1.1rem;
    line-height: 1;
    cursor: pointer;
  }
  .demo .nf-btn:hover {
    color: var(--color-accent);
  }
  .demo .switch {
    width: 2.6rem;
    height: 1.5rem;
    padding: 0.15rem;
    border: 0;
    border-radius: 999px;
    background: var(--color-border-strong);
    cursor: pointer;
    transition: background 150ms ease;
  }
  .demo .switch[data-state='checked'] {
    background: var(--color-accent);
  }
  .demo .switch-thumb {
    display: block;
    width: 1.2rem;
    height: 1.2rem;
    border-radius: 999px;
    background: #fff;
    transition: transform 150ms ease;
  }
  .demo .switch-thumb[data-state='checked'] {
    transform: translateX(1.1rem);
  }
  .demo .pin {
    display: flex;
    gap: 0.4rem;
  }
  .demo .pin-input {
    width: 2.2rem;
    height: 2.6rem;
    text-align: center;
    border: 1px solid var(--color-border-strong);
    border-radius: 0.375rem;
    background: var(--color-bg);
    color: var(--color-fg);
    font: inherit;
  }
  .demo .pin-input:focus {
    outline: 2px solid var(--color-accent);
    outline-offset: -1px;
  }
</style>
