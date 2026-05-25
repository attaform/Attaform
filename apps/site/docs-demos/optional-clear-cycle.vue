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
