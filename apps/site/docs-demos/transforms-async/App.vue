<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import type { RegisterTransform } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

  const sample = [
    '# links.txt: one web address per line. Blank lines and # comments are skipped.',
    'attaform.dev',
    'https://Example.com/Docs/Getting-Started',
    'github.com/attaform/Attaform',
    '',
    'zod.dev/Guides/Migration',
    'ftp://files.example.com/not-a-web-link',
    'this line is not a link',
    'spaced-out.example',
  ].join('\n')

  const linesToUrls: RegisterTransform = async (value) => {
    const files = Array.isArray(value) ? (value as File[]) : []
    const urls: string[] = []
    for (const file of files) {
      for (const line of (await file.text()).split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith('#')) continue
        try {
          const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
          if (url.protocol === 'http:' || url.protocol === 'https:') urls.push(url.href)
        } catch {
          continue
        }
      }
    }
    if (urls.length === 0)
      throw new Error('No web links in that file. Each line should be one web address.')
    return urls
  }

  const lowercase: RegisterTransform = (value) =>
    Array.isArray(value) ? value.map((url) => String(url).toLowerCase()) : value

  const schema = z.object({ links: z.array(z.string()).min(1) })

  const form = useForm({ schema, key: 'docs-demo-transforms-async' })

  const onSubmit = form.handleSubmit(
    (data) => {
      toast.success(`${data.links.length} link${data.links.length === 1 ? '' : 's'} submitted`, {
        description: data,
      })
    },
    () => {
      toast.error('Add at least one readable link before submitting.')
    }
  )

  const downloadSample = () => {
    const url = URL.createObjectURL(new Blob([sample], { type: 'text/plain' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'links.txt'
    anchor.click()
    URL.revokeObjectURL(url)
  }
</script>

<template>
  <form class="demo" @submit.prevent="onSubmit">
    <p class="hint">
      Pick one or more plain <code>.txt</code> files with one entry per line. Attaform reads them,
      turns each line into a tidy URL, drops anything that is not a web address, then lowercases the
      survivors, all before the value reaches your form.
    </p>
    <div class="actions">
      <button type="button" @click="downloadSample">Download a sample links.txt</button>
      <span class="muted">or write your own and pick it below.</span>
    </div>

    <label>
      <span>Links files</span>
      <input
        v-register="form.register('links', { transforms: [linesToUrls, lowercase] })"
        type="file"
        accept=".txt,text/plain"
        multiple
      />
    </label>

    <p v-if="form.fields('links').busy" class="status busy">
      <span class="spinner" aria-hidden="true"></span>
      Reading your files and tidying the links…
    </p>
    <p v-else-if="form.fields('links').transformError" class="status error">
      No web links in that file. Each line should be one web address.
    </p>
    <p v-else-if="form.values.links.length > 0" class="status done">
      {{ form.values.links.length }} link{{ form.values.links.length === 1 ? '' : 's' }} ready.
    </p>

    <div v-if="form.values.links.length > 0" class="panel">
      <p class="panel-title">form.values.links</p>
      <pre>{{ form.values.links.join('\n') }}</pre>
    </div>

    <button :disabled="form.meta.submitting" type="submit">
      {{ form.meta.submitting ? 'Submitting…' : 'Submit links' }}
    </button>
  </form>
</template>

<style scoped>
  .status {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 500;
  }
  .status.busy {
    color: var(--color-accent);
  }
  .status.error {
    color: var(--color-danger);
  }
  .status.done {
    color: var(--color-success);
  }
  .spinner {
    width: 0.85rem;
    height: 0.85rem;
    border-radius: 50%;
    border: 2px solid var(--color-surface-3);
    border-top-color: var(--color-accent);
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
