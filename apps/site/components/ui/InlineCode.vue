<!--
  Inline-code chip — `<UiInlineCode>useForm</UiInlineCode>`.

  Pairs with the `inline-code` utility in `tailwind.css` (single
  source of truth for the chip's visual styling), which non-slot call
  sites apply directly as `<code class="inline-code">` for tokens
  parsed out of data strings.
-->
<template>
  <code class="inline-code"><slot /></code>
</template>
