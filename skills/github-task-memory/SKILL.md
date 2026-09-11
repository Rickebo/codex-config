---
name: github-task-memory
description: Use when working in a GitHub-hosted repo and GitHub Issues plus Projects should act as durable task memory across sessions. Covers picking the next task, recording follow-up work, updating status, blockers, and closing verified issues.
---

# GitHub Task Memory

Use this skill when:
- the current repo is hosted on GitHub
- you want durable task memory across Codex sessions
- the user asks to pick the next task, resume tracked work, record follow-up work, or keep issue/project status up to date

## Local helper

Resolve repo and project configuration first:

`node /home/rickebo/.codex/bin/github-task-memory.mjs current [path]`

This reads:

`/home/rickebo/.codex/github-task-memory.json`

If a project is configured for the repo, use it as the primary queue. Otherwise, fall back to repo-local issues only.

Configured priority labels are part of that same local config. Treat them as a highest-to-lowest ordering.

## Canonical writer

Use `github_operator` as the canonical GitHub writer for:
- creating issues
- adding items to the configured project
- updating project status/fields
- recording blockers
- creating sub-issues or dependencies when appropriate
- adding handoff comments
- closing verified issues

Other agents may discover work, but they should hand the GitHub mutation to `github_operator`.

## Default issue lifecycle

1. Before starting non-trivial work, check for an existing relevant issue.
2. If none exists and the work should outlive the current turn, create a repo issue.
3. Add the issue to the configured product project when available.
4. Ensure the issue has exactly one priority label from the configured priority-label set.
5. When work begins, move the issue/project item to `In Progress`.
6. If blocked, move it to `Blocked`, record the blocker reason and next action, and create/link the blocker issue when needed.
7. If follow-up work is discovered, create a new issue immediately instead of relying on chat memory, and assign a priority label.
8. When implementation is verified, leave a short verification comment and close the issue.

## When to create an issue

Create a durable issue when:
- the work is non-trivial
- the work is discovered during another task and should happen later
- the work spans multiple turns or sessions
- the work has a blocker or dependency
- the work needs review, rollout, or coordination beyond the current edit

Do not create issues for tiny incidental cleanup unless the user asks.

When creating or triaging an issue, assign exactly one priority label:
- highest priority first in the configured order
- default to the configured default priority label if urgency is unclear

## Choosing the next task

If the user asks what to work on next:

1. List `In Progress` items relevant to the current repo first.
2. Then list `Ready` items ordered by priority label from highest to lowest.
3. Avoid `Blocked` unless the user is explicitly asking to unblock them.
4. Prefer repo-local issues tied to the current codebase over unrelated project items.
5. If two items have the same priority, prefer the one easiest to advance now or most tightly coupled to the current repo.

## Handoff comment shape

When leaving a progress comment, keep it short and concrete:
- what was learned
- what changed
- what remains
- exact next step

## Closing rules

Close an issue only after verification, not merely after code was written.

Verification may include:
- targeted tests
- successful rollout
- smoke checks
- issue-specific acceptance criteria
