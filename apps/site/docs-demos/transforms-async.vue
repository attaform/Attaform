<script setup lang="ts">
  import { computed } from 'vue'
  import { useForm } from 'attaform/zod'
  import type { RegisterTransform } from 'attaform'
  import { z } from 'zod'

  const sample = [
    '# links.txt: one web address per line. Blank lines and # comments are skipped.',
    'attaform.com',
    'https://Example.com/Docs/Getting-Started',
    'github.com/attaform/attaform',
    '',
    'zod.dev/Guides/Migration',
    'ftp://files.example.com/not-a-web-link',
    'this line is not a link',
    'spaced-out.example',
  ].join('\n')

  const linesToUrls: RegisterTransform = async (value) => {
    if (!(value instanceof File)) return []
    const lines = (await value.text()).split(/\r?\n/)
    await new Promise((resolve) => setTimeout(resolve, 700))
    const urls: string[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      try {
        const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
        if (url.protocol === 'http:' || url.protocol === 'https:') urls.push(url.href)
      } catch {
        continue
      }
    }
    if (urls.length === 0)
      throw new Error('No web links in that file. Each line should be one address.')
    return urls
  }

  const lowercase: RegisterTransform = (value) =>
    Array.isArray(value) ? value.map((url) => String(url).toLowerCase()) : value

  const form = useForm({
    schema: z.object({ links: z.array(z.string()).nullable() }),
    defaultValues: { links: null },
    key: 'docs-demo-transforms-async',
  })

  const busy = computed(() => form.fields('links')?.busy ?? false)
  const transformError = computed(() => form.fields('links')?.transformError ?? null)
  const links = computed(() => form.values.links ?? [])

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
  <form @submit.prevent>
    <div class="lead">
      <p>
        Pick a plain <code>.txt</code> file with one entry per line. Attaform reads it, turns each
        line into a tidy URL, drops anything that is not a web address, then lowercases the
        survivors, all before the value reaches your form.
      </p>
      <p class="get-file">
        <button type="button" @click="downloadSample">Download a sample links.txt</button>
        <span>or write your own and pick it below.</span>
      </p>
    </div>

    <label>
      <span>Links file</span>
      <input
        v-register="form.register('links', { transforms: [linesToUrls, lowercase] })"
        type="file"
        accept=".txt,text/plain"
      />
    </label>

    <p v-if="busy" class="status busy">
      <span class="spinner" aria-hidden="true"></span>
      Reading your file and tidying the links…
    </p>
    <p v-else-if="transformError" class="status error">{{ transformError?.message }}</p>
    <p v-else-if="links.length > 0" class="status done">
      {{ links.length }} link{{ links.length === 1 ? '' : 's' }} ready.
    </p>

    <div v-if="links.length > 0" class="panel">
      <p class="panel-title">form.values.links</p>
      <ul>
        <li v-for="url in links" :key="url">{{ url }}</li>
      </ul>
    </div>
  </form>
</template>

<style scoped>
  form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 30rem;
  }
  .lead {
    font-size: 0.875rem;
    color: #374151;
  }
  .lead p {
    margin: 0 0 0.5rem 0;
    line-height: 1.5;
  }
  .lead code {
    font-family: ui-monospace, monospace;
    font-size: 0.8125rem;
    background: #f3f4f6;
    border-radius: 0.25rem;
    padding: 0.05rem 0.3rem;
  }
  .get-file {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .get-file button {
    appearance: none;
    border: 1px solid #2563eb;
    background: #2563eb;
    color: #fff;
    font-size: 0.8125rem;
    font-weight: 600;
    padding: 0.35rem 0.7rem;
    border-radius: 0.375rem;
    cursor: pointer;
  }
  .get-file button:hover {
    background: #1d4ed8;
  }
  .get-file span {
    color: #6b7280;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  input[type='file'] {
    padding: 0.4rem 0;
    font-size: 0.875rem;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin: 0;
    font-size: 0.8125rem;
    font-weight: 500;
  }
  .status.busy {
    color: #2563eb;
  }
  .status.error {
    color: #b91c1c;
  }
  .status.done {
    color: #047857;
  }
  .spinner {
    width: 0.85rem;
    height: 0.85rem;
    border-radius: 50%;
    border: 2px solid #bfdbfe;
    border-top-color: #2563eb;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .panel {
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 0.375rem;
    padding: 0.6rem 0.75rem;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    color: #111827;
  }
  .panel-title {
    font-size: 0.6875rem;
    font-weight: 600;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0 0 0.3rem 0;
  }
  .panel ul {
    margin: 0;
    padding-left: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .panel li {
    word-break: break-all;
  }
</style>
