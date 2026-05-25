<script setup lang="ts">
  import { useRegister } from 'attaform'

  defineProps<{ label: string }>()

  const rv = useRegister()
</script>

<template>
  <label class="child-scope">
    <span class="scope-tag scope-tag--child">FieldRow.vue · child</span>

    <span class="field-label">{{ label }}</span>
    <input v-register="rv" class="field-input" />
    <small class="field-tag">
      <span class="field-tag-arrow">↳</span>
      <code>useRegister().path = {{ rv?.path != null ? `'${rv.path}'` : '(unbound)' }}</code>
    </small>
  </label>
</template>
