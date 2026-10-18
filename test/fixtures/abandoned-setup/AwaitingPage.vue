<script setup lang="ts">
  // A page whose setup awaits before it builds: the compiled top-level
  // `await` resumes the setup in its component's context, the way a Nuxt
  // page awaiting its data does.
  const props = defineProps<{ data: Promise<void>; build: () => void }>()
  await props.data
  props.build()
</script>

<template>
  <form />
</template>
