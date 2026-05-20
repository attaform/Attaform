<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'

  const schema = z.object({
    website: z.url('That URL is malformed.').optional(),
  })

  const form = useForm({
    schema,
    defaultValues: { website: undefined },
    key: 'docs-demo-optional-clear-cycle',
  })

  function fmt(v: unknown): string {
    if (v === undefined) return 'undefined'
    if (v === null) return 'null'
    return JSON.stringify(v)
  }
</script>

<template>
  <form @submit.prevent>
    <label>
      Website (optional)
      <input
        v-register="form.register('website')"
        placeholder="https://attaform.dev"
        autocomplete="off"
        spellcheck="false"
      />
      <em v-if="form.fields.website.showErrors">{{ form.fields.website.firstError?.message }}</em>
    </label>

    <table>
      <tbody>
        <tr>
          <th>Storage</th>
          <td>
            <code :class="form.values.website === undefined ? 'absent' : 'present'">{{
              fmt(form.values.website)
            }}</code>
          </td>
        </tr>
        <tr>
          <th>Validity</th>
          <td>
            <span v-if="form.fields.website.valid" class="valid">valid</span>
            <span v-else class="invalid">invalid</span>
          </td>
        </tr>
      </tbody>
    </table>

    <ol>
      <li
        >Leave it empty. Storage is <code>undefined</code>, the field is valid (the
        <code>.optional()</code> path accepts absence).</li
      >
      <li
        >Type <code>not-a-url</code>. Storage holds the typed string; validation reports the
        malformed URL.</li
      >
      <li
        >Clear the input (select + delete). Storage flips back to <code>undefined</code>; the error
        clears too.</li
      >
      <li
        >Type <code>https://attaform.dev</code>. Storage holds the full string; validation
        passes.</li
      >
    </ol>

    <p class="note"
      >Without the optional-clear contract, step 3 would leave storage at <code>''</code>, which is
      neither <code>undefined</code> (the optional escape) nor a valid URL (the inner check). The
      error would stick around forever, and the only way out would be to refresh or type a valid URL
      over the now-invisible bad input. The contract makes the absent state reachable from the DOM.
    </p>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 32rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: #374151;
  }
  input {
    padding: 0.5rem 0.625rem;
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
    color: #b91c1c;
    font-style: normal;
    font-size: 0.8125rem;
    font-weight: 500;
  }
  table {
    border-collapse: collapse;
    font-size: 0.8125rem;
    width: 100%;
  }
  th {
    text-align: left;
    padding: 0.375rem 0.625rem 0.375rem 0;
    width: 6rem;
    color: #6b7280;
    font-weight: 500;
  }
  td {
    padding: 0.375rem 0.625rem;
  }
  tr + tr th,
  tr + tr td {
    border-top: 1px solid #f3f4f6;
  }
  code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.1rem 0.4rem;
    border-radius: 0.25rem;
    font-size: 0.8125rem;
  }
  code.absent {
    background: #fef3c7;
    color: #92400e;
  }
  code.present {
    background: #dbeafe;
    color: #1e40af;
  }
  .valid {
    color: #047857;
    font-weight: 500;
  }
  .invalid {
    color: #b91c1c;
    font-weight: 500;
  }
  ol {
    margin: 0;
    padding-left: 1.25rem;
    font-size: 0.8125rem;
    color: #374151;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .note {
    margin: 0;
    padding: 0.625rem 0.75rem;
    background: #f9fafb;
    border-left: 3px solid #2563eb;
    font-size: 0.75rem;
    color: #4b5563;
    border-radius: 0.25rem;
  }
</style>
