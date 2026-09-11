---
name: compact-planning
description: Use when a bounded task needs an execution plan, dependency check, or tracked steps, but does not require strict pipeline orchestration or a heavyweight design process.
---

# Compact Planning

Use the smallest plan that can prevent rework.

## Fast Path

For low-risk work, produce 3-6 checkable steps:
- goal
- files or areas likely affected
- owner path: root direct, one worker, or named lead
- validation command or manual check
- blocker or escalation condition

Skip product discovery unless requirements are ambiguous. Skip multi-agent decomposition unless there are 2+ independent lanes.

## Escalate

Use full manager or pipeline mode when:
- frontend, backend, infra, or QA lanes must coordinate
- the task touches CI, security, deployment, or data migration paths
- validation failed twice
- the user explicitly asks for manager, pipeline, or exhaustive planning

## Output

Keep the plan concise. Do not restate the prompt. End with the immediate next action.
