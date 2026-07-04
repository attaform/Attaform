---
title: AI agents
description: The tooling Attaform ships for AI coding assistants. A generated llms.txt index, a full-text llms-full.txt dump, and an installable Attaform skill, so an agent builds a form the idiomatic way the first time.
metaRows:
  - label: Category
    value: Reference
  - label: Index
    value: /llms.txt
    kind: code
  - label: Full text
    value: /llms-full.txt
    kind: code
  - label: Skill
    value: /skill.md
    kind: code
---

# AI agents

> Attaform hands your coding assistant the same map the humans get. Three artifacts, all kept honest by the build: a curated `llms.txt` index, a full-text `llms-full.txt` dump, and an installable Attaform skill. Point an agent at them and the first form it writes reaches for `useForm`, binds with `v-register`, and submits through `handleSubmit`, no correction round needed.

::docs-meta-table
::

Large language models are excellent Attaform authors when they can see the surface. Left to guess, a low-context model reaches for whatever it assumes a form library looks like: the wrong import, a hand-rolled `v-model`, a write straight through `values`. Every artifact on this page exists to replace that guess with the real shape.

## `llms.txt`: the curated index

[attaform.dev/llms.txt](/llms.txt) is the front door for an agent. It opens with the mental model, lists every documentation page as a titled link, and carries a compact API cheat-sheet plus the core idioms. It is small enough to drop into a prompt whole.

It is a build artifact, regenerated from the live documentation on every deploy. The links come from the site's own navigation and the headline code comes from a type-checked snippet, so the index cannot silently drift from the site it points at. When an agent needs more than the index gives, the links carry it into the full docs.

## `llms-full.txt`: every page, concatenated

[attaform.dev/llms-full.txt](/llms-full.txt) is every documentation page stitched into one file, in reading order, with the site's markup stripped back to plain prose and code. Reach for it when a model has the context budget to hold the whole manual at once, or when you want to hand off Attaform's complete documentation in a single paste. Like the index, it regenerates on every build, so it is always the current docs.

## The Attaform skill

Attaform ships an Agent Skill: a `SKILL.md` that teaches an assistant how to actually build a form, distilled from real Attaform apps into a short list of recipes and rules. Where `llms.txt` is a reference an agent reads, the skill is guidance an agent follows while it writes.

It is built for progressive disclosure. The main file covers the common case end to end: the import surface, the build-a-form shape, the core rules, and short wizard and SSR summaries. It links five reference files an agent loads only when the task reaches their area, served alongside it under `references/`: wizards, errors, custom components, SSR, and validation. The lean main keeps the everyday case cheap, and the depth is one hop away when a form needs it.

::skill-viewer
::

Read or copy it above, or fetch it directly at [attaform.dev/skill.md](/skill.md).

### Install it into your project

The skill travels inside the package. After installing Attaform, it sits at:

```
node_modules/attaform/skills/attaform/SKILL.md
```

Copy the whole skill folder, the main file and its `references/`, into your project's skills directory:

```sh
cp -r node_modules/attaform/skills/attaform .claude/skills/
```

The assistant then loads the Attaform skill whenever it works on a form in your repo. Because the skill ships with the package, it moves in lockstep with the version you have installed.

## Pointing an agent at Attaform

- **A quick task in a chat.** Paste the contents of `llms.txt`, or link it, and ask for the form. The index is sized to fit.
- **A capable agent with room to spare.** Hand it `llms-full.txt` for the complete documentation in one file.
- **An assistant working in your codebase.** Install the skill so every form it touches follows the idioms without a reminder.

All three point the same direction: the schema is the form, `v-register` binds it, and `handleSubmit` ships it. Give an agent that map and it builds Attaform forms the way you would.
