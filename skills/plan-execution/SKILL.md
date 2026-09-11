---
name: plan-execution
description: Use when the user provides a plan or asks for a plan-first workflow where Codex should turn a plan into tracked implementation steps, execute them in order, and report progress against the plan.
---

# Plan Execution

Use this skill when the user:
- gives a concrete implementation plan and wants it executed
- asks for a plan first and then wants the work carried out
- wants progress tracked against explicit steps or milestones
- wants GitHub issues/projects to act as durable memory while the plan is executed
- wants strict stage-gated orchestration (`spec -> code -> review -> test -> validation`) with policy-enforced transitions

## Workflow

1. If the user already supplied a plan, normalize it into concrete execution steps.
2. If the task is still vague, create a short plan first before implementation.
3. If the user asks for strict stage-gated flow, switch to manager pipeline mode:
   - initialize a run with `node /home/rickebo/.codex/bin/pipeline-controller.mjs init --task "..."`
   - enforce stage transitions through `pipeline-controller.mjs status/advance/approve`
   - require stage reports to match `/home/rickebo/.codex/pipeline/stage-report.schema.json`
   - require `spec` stage to pass via `pipeline-spec-check.mjs` before any code stage
   - do not choose the next stage ad hoc while in pipeline mode
4. Use the plan tool to track progress while working.
5. Preserve the user's explicit ordering unless a dependency or safety issue requires a change.
6. If the repo is GitHub-hosted and the work is non-trivial, use GitHub as durable task memory:
   - resolve repo and project mapping with `node /home/rickebo/.codex/bin/github-task-memory.mjs current`
   - use `github_operator` to find an existing issue or create one
   - ensure the issue has exactly one configured priority label
   - when work starts, update status to `In Progress`
   - when blocked, update status to `Blocked` and record the blocker
   - when follow-up work is discovered, create a new issue instead of relying on chat memory, and assign a priority label
   - when implementation is verified, leave a verification comment and close the issue
7. Prefer the smallest agent set that fits the plan:
   - `planner` for tightening or critiquing the plan
   - `manager-pipeline` for FSM-enforced pipeline orchestration
   - `code_mapper` for code-path discovery
   - `service_fixer` or `ui_fixer` for implementation
   - matching `*_devops` agent for GitOps, Argo, or Kubernetes work
   - `browser_debugger` for UI reproduction and evidence
   - `github_operator` for PRs, issues, workflows, and projects
   - `researcher` for docs, current guidance, and external research
   - `reviewer` for a final correctness/risk pass
8. Keep the active plan current as steps complete or when scope changes.
9. If execution reveals the plan is wrong, revise it explicitly instead of silently drifting.

## Planning Rules

- Make each step observable and checkable.
- Include validation in the step itself, not only at the end.
- Separate implementation steps from deploy or verification steps.
- Do not create extra planning ceremony for trivial tasks.
- Prefer repo issues for durable tasks and a configured product project for the cross-repo queue.
- If the user asks what to work on next, consult the GitHub task list first: `In Progress`, then `Ready`, then `Inbox`, using priority labels from highest to lowest within each queue.

## Completion

In the final answer:
- map outcomes back to the plan
- note any steps skipped, revised, or still pending
- call out residual risk or follow-up only if it materially matters
- if GitHub task memory was used, state which issue(s) were created, updated, blocked, or closed
