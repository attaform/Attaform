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
    <!--
      v-register delivery probe: the module's Vite plugin rewrites this
      compiled template's resolveDirective("register") to an
      `attaform/directive` import, which must resolve through the REAL
      exports map (development condition in dev). The SSR-compiled
      output then emits value= through ssrGetDirectiveProps, so the
      rendered HTML carrying the probe value proves the injected import
      resolved AND the directive's SSR path ran.
    -->
    <input id="probe-input" v-register="form.register('probe')" />
  </div>
</template>
