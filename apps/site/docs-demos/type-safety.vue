<script setup lang="ts">
  import { ref } from 'vue'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const schema = z.object({
    email: z.email('Enter a valid email'),
    transport: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('boat'),
        hullLengthM: z.number().min(2, 'Hulls are 2 m or longer'),
      }),
      z.object({
        kind: z.literal('truck'),
        payloadKg: z.number().min(100, 'Trucks haul 100 kg or more'),
      }),
    ]),
  })

  const form = useForm({
    schema,
    defaultValues: {
      email: '',
      transport: { kind: 'boat', hullLengthM: 0 },
    },
    key: 'docs-demo-type-safety',
  })

  const submitted = ref<z.infer<typeof schema> | null>(null)

  const onSubmit = form.handleSubmit((values) => {
    submitted.value = values
  })
</script>

<template>
  <div class="layout">
    <form @submit.prevent="onSubmit">
      <label>
        Email
        <input v-register="form.register('email')" placeholder="andy@" autocomplete="email" />
        <em v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</em>
      </label>

      <fieldset>
        <legend>Transport</legend>
        <label class="radio">
          <input v-register="form.register('transport.kind')" type="radio" value="boat" />
          Boat
        </label>
        <label class="radio">
          <input v-register="form.register('transport.kind')" type="radio" value="truck" />
          Truck
        </label>
      </fieldset>

      <label v-if="form.values.transport.kind === 'boat'">
        Hull length (m)
        <input v-register="form.register('transport.hullLengthM')" type="number" min="0" />
        <em v-if="form.fields.transport.hullLengthM.showErrors">
          {{ form.fields.transport.hullLengthM.firstError?.message }}
        </em>
      </label>

      <label v-else-if="form.values.transport.kind === 'truck'">
        Payload (kg)
        <input v-register="form.register('transport.payloadKg')" type="number" min="0" />
        <em v-if="form.fields.transport.payloadKg.showErrors">
          {{ form.fields.transport.payloadKg.firstError?.message }}
        </em>
      </label>

      <button type="submit">Submit</button>
    </form>

    <aside class="panels">
      <section>
        <h4>
          Form holds
          <span class="tag tag-wide">in-flight, wide</span>
        </h4>
        <pre>{{ JSON.stringify(form.values, null, 2) }}</pre>
        <p class="caption">
          <code>form.values.email</code> is typed <code>string</code>;
          <code>form.values.transport.kind</code> is also <code>string</code>. The form stores
          whatever the user has typed so far, including <code>"andy@"</code> or a discriminator the
          user has not committed to.
        </p>
      </section>
      <section>
        <h4>
          Submit produces
          <span class="tag tag-tight">validated, tight</span>
        </h4>
        <pre v-if="submitted">{{ JSON.stringify(submitted, null, 2) }}</pre>
        <pre v-else class="placeholder">// Submit the form to see the parsed payload</pre>
        <p class="caption">
          Inside <code>handleSubmit((values) =&gt; ...)</code>, <code>values.email</code> is the
          schema's parsed string and <code>values.transport.kind</code> narrows to
          <code>'boat' | 'truck'</code>. Discriminator narrowing engages, so per-variant access is
          type-safe.
        </p>
      </section>
    </aside>
  </div>
</template>

<style scoped>
  .layout {
    display: grid;
    gap: 1.25rem;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
  }
  @media (max-width: 720px) {
    .layout {
      grid-template-columns: 1fr;
    }
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  fieldset {
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    padding: 0.5rem 0.875rem;
    margin: 0;
    display: flex;
    flex-direction: row;
    gap: 1rem;
    align-items: center;
    flex-wrap: wrap;
  }
  legend {
    padding: 0 0.375rem;
    font-size: 0.8125rem;
    color: #6b7280;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  label.radio {
    flex-direction: row;
    align-items: center;
    gap: 0.375rem;
  }
  input {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
    font-family: inherit;
  }
  input:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  em {
    color: #dc2626;
    font-size: 0.8125rem;
    font-style: normal;
    font-weight: 400;
  }
  button {
    align-self: flex-start;
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    border: 1px solid #2563eb;
    background: #2563eb;
    color: white;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
  }
  button:hover {
    background: #1d4ed8;
  }
  .panels {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .panels section {
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    padding: 0.75rem 0.875rem;
    background: #f9fafb;
  }
  .panels h4 {
    margin: 0 0 0.5rem;
    font-size: 0.875rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .tag {
    font-size: 0.6875rem;
    font-weight: 500;
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
    letter-spacing: 0.01em;
  }
  .tag-wide {
    background: #e5e7eb;
    color: #374151;
  }
  .tag-tight {
    background: #dcfce7;
    color: #166534;
  }
  pre {
    margin: 0;
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.75rem;
    line-height: 1.5;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 0.375rem;
    padding: 0.5rem 0.625rem;
    overflow-x: auto;
  }
  pre.placeholder {
    color: #9ca3af;
  }
  .caption {
    margin: 0.5rem 0 0;
    font-size: 0.75rem;
    color: #4b5563;
  }
  .caption code {
    font-size: 0.6875rem;
    background: #e5e7eb;
    padding: 0.0625rem 0.25rem;
    border-radius: 0.1875rem;
  }
</style>
