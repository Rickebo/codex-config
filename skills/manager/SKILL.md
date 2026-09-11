---
name: manager
description: Manager/orchestrator skill for delegation-first execution. Supports strict pipeline FSM mode enforced by pipeline-controller.
---

# Manager

Use this skill when the user wants manager-style orchestration, lane ownership, and subagent delegation instead of direct root implementation.

## Default Mode

1. Root acts as manager/orchestrator.
2. Root delegates technical execution to tech leads and workers.
3. Root integrates status, blockers, and next actions.
4. Use `/home/rickebo/.codex/agents/delegation-policy.json` as the routing table when the task shape is unclear.

## Compact Mode

For bounded work, prefer manager-lite:

- one direct worker for single-domain implementation
- tech leads only for multi-domain or integration-risk lanes
- no recursive delegation
- max 8-line reports

Use full manager mode only when there are independent lanes or integration risk that justify tech-lead fan-out.

## Pipeline FSM Mode (When Requested)

When the user asks for strict stage gating, review/test loops, or code-enforced transitions, switch to pipeline FSM mode and enforce transitions with:

- `node /home/rickebo/.codex/bin/pipeline-controller.mjs`

Required workflow:

1. `init` run state with task summary and the right profile:
   - `--profile lite` for compact, low/medium-risk pipeline work
   - `--profile full` for release-grade or high-risk work
   - `--profile emergency` only when explicitly selected
2. `status` before each stage.
3. delegate stage work by owner.
4. start with `spec` stage and pass spec gates before coding.
5. collect one stage report JSON.
6. `advance` using that report.
7. if approval is required, run `approve` before further transitions.
8. stop at `done` or escalate when loop/staleness constraints are hit.

Use these files:

- `/home/rickebo/.codex/pipeline/transitions.json`
- `/home/rickebo/.codex/pipeline/approval-rules.json`
- `/home/rickebo/.codex/pipeline/feature-spec.schema.json`
- `/home/rickebo/.codex/pipeline/stage-report.schema.json`
- `node /home/rickebo/.codex/bin/pipeline-spec-check.mjs`

## Enforcement Rules

- Do not choose next stage ad hoc in pipeline mode.
- Do not bypass the `spec` stage; `code` starts only after a passing spec check.
- Do not let root take broad coding ownership unless explicitly requested by user.
- Keep delegated write scopes disjoint where possible.
- Respect the active pipeline profile's `max_loops` and council policy from `/home/rickebo/.codex/pipeline/transitions.json`.
- Escalate to user instead of unlimited retries when loop budgets or approvals block progress.
