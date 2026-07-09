---
title: llms.txt
description: The curated llms.txt index, Attaform's mental model plus every documentation page as a titled link and a compact API cheat-sheet, sized to drop into a prompt whole.
metaRows:
  - label: Category
    value: AI tooling
  - label: Served at
    value: /llms.txt
    kind: code
  - label: Regenerated
    value: every build
---

# llms.txt

> [attaform.dev/llms.txt](/llms.txt) is the front door for an agent. It opens with the mental model, lists every documentation page as a titled link, and carries a compact API cheat-sheet plus the core idioms. It is small enough to drop into a prompt whole.

::docs-meta-table
::

Large language models are excellent Attaform authors when they can see the surface. `llms.txt` is the curated version of that surface: the shortest thing you can hand a model that still points it the right way. Where the [Agent Skill](/docs/ai-tooling/agent-skill) is guidance an agent follows while it writes, `llms.txt` is a reference an agent reads.

It is a build artifact, regenerated from the live documentation on every deploy. The links come from the site's own navigation and the headline code comes from a type-checked snippet, so the index cannot silently drift from the site it points at. When an agent needs more than the index gives, the links carry it into the full docs.

## When to reach for it

Reach for `llms.txt` for a quick task in a chat window: paste its contents, or link it, and ask for the form. The index is sized to fit. When a model has the context budget to hold the whole manual at once, hand it the full [`llms-full.txt`](/docs/ai-tooling/llms-full-txt) dump instead; when an assistant is working inside your codebase, install the [Agent Skill](/docs/ai-tooling/agent-skill) so every form follows the idioms without a reminder.
