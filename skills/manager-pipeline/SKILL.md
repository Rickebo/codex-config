---
name: manager-pipeline
description: Use when the user wants manager-led orchestration with enforced pipeline FSM transitions (spec -> code -> review -> test -> validation) using the local pipeline controller.
---

# Manager Pipeline

Use this skill when the user wants the manager/root agent to orchestrate work through a strict stage-gated workflow instead of free-form delegation.

## Required Enforcement

Always enforce transitions via:

- `node /home/rickebo/.codex/bin/pipeline-controller.mjs`

Never pick the next stage ad hoc when this skill is active.

## Pipeline Assets

- Transition policy: `/home/rickebo/.codex/pipeline/transitions.json`
- Approval policy: `/home/rickebo/.codex/pipeline/approval-rules.json`
- Feature spec schema: `/home/rickebo/.codex/pipeline/feature-spec.schema.json`
- Stage report schema: `/home/rickebo/.codex/pipeline/stage-report.schema.json`
- Operations guide: `/home/rickebo/.codex/pipeline/OPERATIONS.md`
- Spec checker: `node /home/rickebo/.codex/bin/pipeline-spec-check.mjs`

## Execution Contract

1. Initialize run state once at start:
   - lite: `node /home/rickebo/.codex/bin/pipeline-controller.mjs init --profile lite --task "<TASK>"`
   - full: `node /home/rickebo/.codex/bin/pipeline-controller.mjs init --profile full --task "<TASK>"`
   - emergency/debug: `node /home/rickebo/.codex/bin/pipeline-controller.mjs init --profile emergency --task "<TASK>"`
   - capture `run_dir`
2. Before each stage action, check current state:
   - `node /home/rickebo/.codex/bin/pipeline-controller.mjs status --run-dir <RUN_DIR>`
3. Stage `spec` gate (required before any coding):
   - obey the profile's council policy from `/home/rickebo/.codex/pipeline/transitions.json`
   - full profile requires a `council_file` for passing specs
   - lite profile requires `council_file` only when risk or independent lane count requires it
   - when council is required, use at least 3 perspectives (for example `planner`, `reviewer`, `tech_lead_qa`, and optionally `researcher`)
   - synthesize a single feature spec JSON
   - validate spec with:
     - `node /home/rickebo/.codex/bin/pipeline-spec-check.mjs --spec <SPEC_JSON> --out <SPEC_CHECK_JSON>`
   - include `spec_file` and `spec_check_file` in the spec stage report
4. Delegate stage work by owner:
   - `code`: `tech_lead_backend`, `tech_lead_frontend`, `tech_lead_devops` as applicable
   - `review`: `reviewer` plus targeted lead follow-up when needed
   - `test`: `tech_lead_qa`
   - `validation`: `tech_lead_qa` and/or `planner` for requirement trace checks
5. For each completed stage, write one JSON report that follows:
   - `/home/rickebo/.codex/pipeline/stage-report.schema.json`
6. Advance only through controller:
   - `node /home/rickebo/.codex/bin/pipeline-controller.mjs advance --run-dir <RUN_DIR> --report <REPORT_JSON>`
7. If `approval_required=true`, pause progression and run:
   - `node /home/rickebo/.codex/bin/pipeline-controller.mjs approve --run-dir <RUN_DIR> --approver "<NAME>" --note "<NOTE>"`
8. Stop when state reaches `done` or when escalation is required.

## Stage Report Minimum Fields

- `stage`
- `status`
- `summary`
- `changed_files`
- `validation`
- `blockers`
- `next_action`
- `route_to` when required by stage/status
- `risk_level` when known (`low|medium|high|critical`)
- `independent_lanes` when the spec/code path has separable lanes
- `requires_council` when a council pass is materially needed
- `spec_file` and `spec_check_file` when `stage=spec` and `status=pass`
- `council_file` when required by the active pipeline profile

## Manager Role Rules

- Stay manager-only by default; do not take direct coding ownership unless user explicitly requests root-level implementation.
- Keep delegated write scopes disjoint.
- Preserve explicit audit trail:
  - report file path
  - controller output (`next_stage`, `approval_required`, `loop_count`)
  - blockers and follow-up actions
- If loop budget is exceeded or the run is stuck, escalate to user instead of continuing autonomous retries.
- Profile loop budgets are controller-enforced: lite `3`, full `6`, emergency `12`.

## Completion

Final response must include:

1. `run_dir`
2. final `state.current_stage` and `done` status
3. stage-by-stage outcomes
4. any approvals required/granted
5. unresolved blockers or residual risks
