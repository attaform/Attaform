<script setup lang="ts">
  // Renders the shipped Agent Skill inline, read from the web-served mirror
  // (skills/attaform/SKILL.md, written into public/ by the generator) so it is
  // always the version the package ships. Fetched client-side: a public asset
  // is not reachable through the prerender-time internal fetch, so the static
  // paint shows the raw-file link and the viewer fills in on hydration. No
  // top-level await keeps this a synchronous content component (it renders
  // through ContentRenderer). The copy button hands an agent that exact
  // markdown to drop into a .claude/skills folder.
  const { data: skill } = useAsyncData(
    'attaform-skill-md',
    () => fetch('/skills/attaform/SKILL.md').then((r) => (r.ok ? r.text() : null)),
    { server: false }
  )
</script>

<template>
  <div class="not-prose my-6 overflow-hidden rounded-xl border border-border bg-surface/40">
    <div class="flex items-center justify-between gap-3 border-b border-border bg-bg/50 px-4 py-2">
      <code class="font-mono text-xs text-fg-muted">skills/attaform/SKILL.md</code>
      <UiCopyButton v-if="skill" :text="skill" label="Copy the skill as markdown" />
      <a v-else href="/skill.md" class="text-xs text-accent hover:underline">View raw</a>
    </div>
    <pre
      v-if="skill"
      class="max-h-[28rem] overflow-auto px-4 py-3 font-mono text-xs leading-relaxed text-fg"
      v-text="skill"
    />
    <p v-else class="px-4 py-3 text-sm text-fg-muted">
      Read the skill at
      <a href="/skill.md" class="text-accent hover:underline">attaform.dev/skill.md</a>.
    </p>
  </div>
</template>
