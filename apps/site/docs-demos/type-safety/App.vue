<script setup lang="ts">
  import { ref } from 'vue'
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

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
  <div class="demo layout split">
    <form class="stack" @submit.prevent="onSubmit">
      <label>
        Email
        <input v-register="form.register('email')" placeholder="andy@" autocomplete="email" />
        <em v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</em>
      </label>

      <fieldset>
        <legend>Transport</legend>
        <label class="row">
          <input v-register="form.register('transport.kind')" type="radio" value="boat" />
          Boat
        </label>
        <label class="row">
          <input v-register="form.register('transport.kind')" type="radio" value="truck" />
          Truck
        </label>
      </fieldset>

      <label v-if="form.values.transport.kind === 'boat'">
        Hull length (m)
        <input v-register="form.register('transport.hullLengthM')" type="number" min="0" />
        <em v-if="form.fields.transport.hullLengthM?.showErrors">
          {{ form.fields.transport.hullLengthM?.firstError?.message }}
        </em>
      </label>

      <label v-else-if="form.values.transport.kind === 'truck'">
        Payload (kg)
        <input v-register="form.register('transport.payloadKg')" type="number" min="0" />
        <em v-if="form.fields.transport.payloadKg?.showErrors">
          {{ form.fields.transport.payloadKg?.firstError?.message }}
        </em>
      </label>

      <button type="submit">Submit</button>
    </form>

    <aside class="panels">
      <section class="card">
        <h4>
          Form holds
          <span class="tag tag-wide">in-flight, wide</span>
        </h4>
        <pre>{{ JSON.stringify(form.values, null, 2) }}</pre>
        <p class="hint">
          <code>form.values.email</code> is typed <code>string</code>;
          <code>form.values.transport.kind</code> is also <code>string</code>. The form stores
          whatever the user has typed so far, including <code>"andy@"</code> or a discriminator the
          user has not committed to.
        </p>
      </section>
      <section class="card">
        <h4>
          Submit produces
          <span class="tag tag-tight">validated, tight</span>
        </h4>
        <pre v-if="submitted">{{ JSON.stringify(submitted, null, 2) }}</pre>
        <pre v-else class="placeholder">// Submit the form to see the parsed payload</pre>
        <p class="hint">
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
  /* Boat | Truck radios sit in a row; overrides the fieldset fragment column. */
  .demo fieldset {
    flex-direction: row;
    align-items: center;
    flex-wrap: wrap;
    gap: 1rem;
  }
  /* Panel heading carries an inline wide/tight type tag. */
  .demo .card h4 {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    font-size: 0.875rem;
    font-weight: 600;
  }
  /* Wide (in-flight, stored) vs tight (validated, parsed) type markers. */
  .demo .tag {
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
    font-size: 0.6875rem;
    font-weight: 500;
    letter-spacing: 0.01em;
  }
  .demo .tag-wide {
    background: var(--color-surface-3);
    color: var(--color-fg-muted);
  }
  .demo .tag-tight {
    background: var(--color-success-soft);
    color: var(--color-success);
  }
</style>
