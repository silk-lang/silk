---
name: silk-sync
description: Reconcile Silk Linear issues with repository, branch, and GitHub PR reality. Use only when Julia explicitly invokes this skill or asks to sync the Silk queue.
---

# Claude entrypoint for Silk sync

Read `../../../.codex/skills/silk-sync/SKILL.md` completely and follow it as the canonical skill.
Resolve every relative path in that file from its `.codex/skills/silk-sync/` directory, not from this
wrapper. When the canonical workflow requires subagents or a visible plan, use Claude Code's
corresponding agent and task-tracking facilities while preserving the same coordinator boundaries.
