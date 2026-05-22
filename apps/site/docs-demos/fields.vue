<script setup lang="ts">
  import { useForm, withMeta } from 'attaform/zod'
  import { z } from 'zod'

  const schema = z.object({
    email: withMeta(
      z.email('Enter a valid email').describe('We only use it to send you a confirmation.'),
      {
        label: 'Email address',
        placeholder: 'you@example.com',
      }
    ),
  })

  const { register, fields, handleSubmit } = useForm({
    schema,
    key: 'docs-demo-fields',
  })

  const onSubmit = handleSubmit(() => {
    /* surfacing meta isn't this demo's job */
  })

  const formatPath = (path: ReadonlyArray<string | number>) => JSON.stringify(path)
  const formatTime = (iso: string | null) =>
    iso === null ? 'null' : new Date(iso).toLocaleTimeString()
</script>

<template>
  <form @submit.prevent="onSubmit">
    <label>
      <span class="heading">{{ fields.email.label }}</span>
      <input
        v-register="register('email')"
        type="email"
        :placeholder="fields.email.placeholder"
        autocomplete="email"
      />
      <small v-if="fields.email.description">{{ fields.email.description }}</small>
      <em v-if="fields.email.showErrors">{{ fields.email.firstError?.message }}</em>
    </label>

    <button type="submit">Submit</button>

    <div class="panel">
      <p class="panel-title">fields.email</p>

      <p class="group-title">State bits</p>
      <table>
        <tbody>
          <tr>
            <th>pristine</th>
            <td>{{ fields.email.pristine }}</td>
            <th>dirty</th>
            <td>{{ fields.email.dirty }}</td>
          </tr>
          <tr>
            <th>focused</th>
            <td>{{ fields.email.focused }}</td>
            <th>blurred</th>
            <td>{{ fields.email.blurred }}</td>
          </tr>
          <tr>
            <th>touched</th>
            <td>{{ fields.email.touched }}</td>
            <th>blank</th>
            <td>{{ fields.email.blank }}</td>
          </tr>
          <tr>
            <th>connected</th>
            <td>{{ fields.email.connected }}</td>
            <th>updatedAt</th>
            <td>{{ formatTime(fields.email.updatedAt) }}</td>
          </tr>
        </tbody>
      </table>

      <p class="group-title">Value reads</p>
      <table>
        <tbody>
          <tr>
            <th>value</th>
            <td>{{ JSON.stringify(fields.email.value) }}</td>
          </tr>
          <tr>
            <th>original</th>
            <td>{{ JSON.stringify(fields.email.original) }}</td>
          </tr>
        </tbody>
      </table>

      <p class="group-title">Validation reads</p>
      <table>
        <tbody>
          <tr>
            <th>valid</th>
            <td>{{ fields.email.valid }}</td>
            <th>validating</th>
            <td>{{ fields.email.validating }}</td>
          </tr>
          <tr>
            <th>showErrors</th>
            <td>{{ fields.email.showErrors }}</td>
            <th>errors.length</th>
            <td>{{ fields.email.errors.length }}</td>
          </tr>
        </tbody>
      </table>

      <p class="group-title">Schema metadata + identity</p>
      <table>
        <tbody>
          <tr>
            <th>label</th>
            <td>{{ JSON.stringify(fields.email.label) }}</td>
          </tr>
          <tr>
            <th>placeholder</th>
            <td>{{ JSON.stringify(fields.email.placeholder) }}</td>
          </tr>
          <tr>
            <th>description</th>
            <td>{{ JSON.stringify(fields.email.description) }}</td>
          </tr>
          <tr>
            <th>path</th>
            <td>{{ formatPath(fields.email.path) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 26rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  input {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
  }
  input:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  small {
    color: #6b7280;
    font-size: 0.75rem;
    font-weight: 400;
  }
  em {
    color: #dc2626;
    font-size: 0.8125rem;
    font-style: normal;
    font-weight: 400;
  }
  button {
    align-self: flex-start;
    padding: 0.4rem 0.85rem;
    border-radius: 0.375rem;
    border: 1px solid #2563eb;
    background: #2563eb;
    color: #fff;
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
  }
  button:hover {
    background: #1d4ed8;
  }
  .panel {
    margin-top: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .panel-title {
    font-size: 0.75rem;
    font-weight: 600;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0;
  }
  .group-title {
    font-size: 0.6875rem;
    font-weight: 500;
    color: #9ca3af;
    margin: 0.25rem 0 0 0;
  }
  table {
    border-collapse: collapse;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    width: 100%;
  }
  table th,
  table td {
    padding: 0.2rem 0.5rem;
    text-align: left;
    border-bottom: 1px solid #e5e7eb;
    vertical-align: top;
  }
  table th {
    color: #6b7280;
    font-weight: 500;
    white-space: nowrap;
    width: 1%;
  }
  table td {
    color: #111827;
    word-break: break-word;
  }
</style>
