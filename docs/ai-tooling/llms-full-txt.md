---
title: llms-full.txt
description: The llms-full.txt dump, every Attaform documentation page concatenated in reading order, for handing an assistant the complete manual in a single paste.
metaRows:
  - label: Category
    value: AI tooling
  - label: Served at
    value: /llms-full.txt
    kind: code
  - label: Regenerated
    value: every build
---

# llms-full.txt

> [attaform.dev/llms-full.txt](/llms-full.txt) is every documentation page stitched into one file, in reading order, with the site's markup stripped back to plain prose and code. It is the whole manual in a single paste.

::docs-meta-table
::

Where [`llms.txt`](/docs/ai-tooling/llms-txt) is the curated index, `llms-full.txt` is the unabridged text behind it: every page, concatenated, nothing summarized. Reach for it when a model has the context budget to hold the whole manual at once, or when you want to hand off Attaform's complete documentation in a single paste.

Like the index, it regenerates on every build, stitched from the same pages the site serves, so it is always the current docs. There is no separate copy to fall behind.

## When to reach for it

Hand `llms-full.txt` to a capable agent with room to spare, or paste it when you want one file that carries everything. For a quick task in a chat window, the lighter [`llms.txt`](/docs/ai-tooling/llms-txt) index is usually enough; for an assistant working inside your codebase, install the [Agent Skill](/docs/ai-tooling/agent-skill) so every form it touches follows the idioms without a reminder.
