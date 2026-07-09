---
title: Agent Skill
description: The installable Attaform skill, a SKILL.md that teaches a coding assistant to build a form the idiomatic way, distilled from real Attaform apps into short recipes and rules.
metaRows:
  - label: Category
    value: AI tooling
  - label: Format
    value: SKILL.md
    kind: code
  - label: Install
    value: npx attaform skill
    kind: code
  - label: Served at
    value: /skill.md
    kind: code
---

# Agent Skill

> Attaform ships an Agent Skill: a `SKILL.md` that teaches a coding assistant how to actually build a form, distilled from real Attaform apps into a short list of recipes and rules. Point an agent at it and the first form it writes reaches for `useForm`, binds with `v-register`, and submits through `handleSubmit`, no correction round needed.

::docs-meta-table
::

Attaform hands your coding assistant the same map the humans get. Three artifacts, all kept honest by the build: this installable skill, a curated [`llms.txt`](/docs/ai-tooling/llms-txt) index, and a full-text [`llms-full.txt`](/docs/ai-tooling/llms-full-txt) dump. Left to guess, a low-context model reaches for whatever it assumes a form library looks like: the wrong import, a hand-rolled `v-model`, a write straight through `values`. The skill replaces that guess with the real shape. Where `llms.txt` is a reference an agent reads, the skill is guidance an agent follows while it writes.

It is built for progressive disclosure. The main file covers the common case end to end: the import surface, the build-a-form shape, the core rules, and short wizard and SSR summaries. It links five reference files an agent loads only when the task reaches their area, served alongside it under `references/`: wizards, errors, custom components, SSR, and validation. The lean main keeps the everyday case cheap, and the depth is one hop away when a form needs it.

::skill-viewer
::

Read or copy it above, or fetch it directly at [attaform.dev/skill.md](/skill.md).

## Install it into your project

`SKILL.md` is the portable skill format, read natively by Claude Code, Cursor, Codex, OpenCode, and more, so one file serves every assistant. The skill travels inside the `attaform` package, so one command copies it into place. From your project root:

```sh
npx attaform skill
```

With no argument it places the skill next to whichever assistants your project already uses, reading `.claude/`, `.cursor/`, `.codex/`, and `.agents/`, and falls back to the vendor-neutral `.agents/skills/` when it finds none. It prints where each copy lands. Aim it at a specific folder with a trailing path, for example `npx attaform skill .cursor/skills`.

Run it again after you upgrade Attaform to refresh the skill in place: because it ships inside the package, running it in a project that has Attaform installed copies that exact version's skill, with no separate download to drift out of sync.

The skill ships under `skills/` in the package, the same layout the ecosystem's skill loaders scan `node_modules` for, so those tools discover it too. You can also place it by hand from `node_modules/attaform/skills/attaform/`:

```sh
cp -r node_modules/attaform/skills/attaform .agents/skills/
```

Assistant folders like `.claude/` and `.cursor/` are often gitignored, so commit the installed skill directory if you want your whole team to share it. Either way, the assistant loads the Attaform skill whenever it works on a form in your repo.

## When to reach for it

Install the skill for an assistant working inside your codebase: every form it touches then follows the idioms without a reminder. For a one-off form in a chat window, the lighter [`llms.txt`](/docs/ai-tooling/llms-txt) index is enough to paste; for a capable agent with room to spare, hand it the whole [`llms-full.txt`](/docs/ai-tooling/llms-full-txt) manual. All three point the same direction: the schema is the form, `v-register` binds it, and `handleSubmit` ships it.
