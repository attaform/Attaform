<script setup lang="ts">
  import { useRegister } from '@runtime/composables/use-register'

  // Recommended styled-field pattern: the parent binds v-register on this
  // component; useRegister re-binds it onto the inner native control. The
  // wrapper's <div> root must not carry autoAria's aria-required (#404).
  const rv = useRegister()
</script>

<template>
  <div id="aria-host-wrapper" class="field-wrapper">
    <input id="aria-host-inner" v-register="rv" />
  </div>
</template>
