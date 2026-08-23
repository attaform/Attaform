<script setup lang="ts">
  // Resolves through the exports map (no alias): in dev this lands on
  // the dist/dev flavor while attaform/nuxt registers the runtime plugin
  // by literal path. If the plugin and this import loaded two different
  // module graphs, there would be two registries and this `useForm`
  // would throw `Registry not found` during SSR — the marker below
  // renders only when both sides share one graph.
  import { useForm } from 'attaform/zod-v4'
  import { z } from 'zod'

  const schema = z.object({ probe: z.string().default('dist-flavor-ok') })
  const form = useForm({ schema, key: 'dist-flavor-probe' })
</script>

<template>
  <div>
    <span id="probe">{{ form.values.probe }}</span>
  </div>
</template>
