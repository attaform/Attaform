<script setup lang="ts">
  import { useForm, withMeta } from 'attaform'
  import { z } from 'zod'
  import { ref, onMounted } from 'vue'
  import './styles.css'

  const schema = z.object({
    email: withMeta(
      z.email('Enter a valid email').describe('We only use it to send you a confirmation.'),
      {
        label: 'Email address',
        placeholder: 'you@example.com',
      }
    ),
  })

  const form = useForm({
    schema,
    key: 'docs-demo-form.fields',
  })

  const onSubmit = form.handleSubmit((values) => {
    toast.success(`Submitted as ${values.email}`, { description: values })
  })

  const mounted = ref(false)
  onMounted(() => {
    mounted.value = true
  })

  const formatPath = (path: ReadonlyArray<string | number>) => JSON.stringify(path)
  const formatTime = (iso: string | null) => {
    if (iso === null) return 'null'
    if (!mounted.value) return '…'
    return new Date(iso).toLocaleTimeString()
  }
</script>

<template>
  <form class="demo" @submit.prevent="onSubmit">
    <label>
      <span>{{ form.fields.email.label }}</span>
      <input
        v-register="form.register('email')"
        :placeholder="form.fields.email.placeholder"
        autocomplete="email"
      />
      <p v-if="form.fields.email.description" class="hint">{{ form.fields.email.description }}</p>
      <em v-if="form.fields.email.showErrors">{{ form.fields.email.firstError?.message }}</em>
    </label>

    <button type="submit">Submit</button>

    <div class="panel">
      <p class="panel-title">form.fields.email</p>

      <p class="group-title">State bits</p>
      <table class="state">
        <tbody>
          <tr>
            <th>pristine</th>
            <td>{{ form.fields.email.pristine }}</td>
            <th>dirty</th>
            <td>{{ form.fields.email.dirty }}</td>
          </tr>
          <tr>
            <th>focused</th>
            <td>{{ form.fields.email.focused }}</td>
            <th>blurred</th>
            <td>{{ form.fields.email.blurred }}</td>
          </tr>
          <tr>
            <th>touched</th>
            <td>{{ form.fields.email.touched }}</td>
            <th>blank</th>
            <td>{{ form.fields.email.blank }}</td>
          </tr>
          <tr>
            <th>connected</th>
            <td>{{ form.fields.email.connected }}</td>
            <th>updatedAt</th>
            <td>{{ formatTime(form.fields.email.updatedAt) }}</td>
          </tr>
        </tbody>
      </table>

      <p class="group-title">Value reads</p>
      <table class="state">
        <tbody>
          <tr>
            <th>value</th>
            <td>{{ JSON.stringify(form.fields.email.value) }}</td>
          </tr>
          <tr>
            <th>original</th>
            <td>{{ JSON.stringify(form.fields.email.original) }}</td>
          </tr>
        </tbody>
      </table>

      <p class="group-title">Validation reads</p>
      <table class="state">
        <tbody>
          <tr>
            <th>valid</th>
            <td>{{ form.fields.email.valid }}</td>
            <th>validating</th>
            <td>{{ form.fields.email.validating }}</td>
          </tr>
          <tr>
            <th>showErrors</th>
            <td>{{ form.fields.email.showErrors }}</td>
            <th>errors.length</th>
            <td>{{ form.fields.email.errors.length }}</td>
          </tr>
        </tbody>
      </table>

      <p class="group-title">Schema metadata + identity</p>
      <table class="state">
        <tbody>
          <tr>
            <th>label</th>
            <td>{{ JSON.stringify(form.fields.email.label) }}</td>
          </tr>
          <tr>
            <th>placeholder</th>
            <td>{{ JSON.stringify(form.fields.email.placeholder) }}</td>
          </tr>
          <tr>
            <th>description</th>
            <td>{{ JSON.stringify(form.fields.email.description) }}</td>
          </tr>
          <tr>
            <th>path</th>
            <td>{{ formatPath(form.fields.email.path) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </form>
</template>
