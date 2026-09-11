# Pipeline Operations

## Purpose
Provide operational controls for the pipeline FSM:

- validation in CI
- metric generation
- stuck-run and approval-wait alerting
- explicit human approvals for gated transitions

## Commands

Bootstrap and launch a session in one command:
`codex-pipeline-run "your task prompt"`

1. Validate runs (CI gate):
`node /home/rickebo/.codex/bin/pipeline-ci-check.mjs --runs-dir /home/rickebo/.codex/pipeline/runs --strict`

0. Validate feature spec before implementation:
`node /home/rickebo/.codex/bin/pipeline-spec-check.mjs --spec <SPEC_JSON> --out <SPEC_CHECK_JSON>`
Template starter: `/home/rickebo/.codex/pipeline/feature-spec.template.json`

2. Generate JSON metrics:
`node /home/rickebo/.codex/bin/pipeline-metrics.mjs --runs-dir /home/rickebo/.codex/pipeline/runs --format json`

3. Generate Markdown metrics report:
`node /home/rickebo/.codex/bin/pipeline-metrics.mjs --runs-dir /home/rickebo/.codex/pipeline/runs --format md --out /tmp/pipeline-metrics.md`

4. Alert scan with non-zero exit on alerts:
`node /home/rickebo/.codex/bin/pipeline-alerts.mjs --runs-dir /home/rickebo/.codex/pipeline/runs --fail-on-alert`

## Approval Workflow

When `advance` returns `approval_required=true`, run:

`node /home/rickebo/.codex/bin/pipeline-controller.mjs approve --run-dir <RUN_DIR> --approver "<NAME>" --note "approved after review"`

Approval policies live in:

`/home/rickebo/.codex/pipeline/approval-rules.json`

## Suggested Schedules

1. Every 10 minutes:
- run `pipeline-alerts.mjs`
- send JSON payload to your notification system

2. Hourly:
- run `pipeline-metrics.mjs --format json`
- store snapshot for trend analysis

3. Per pull request or per release gate:
- run `pipeline-ci-check.mjs --strict`
- ensure spec check artifact exists and is `ok=true`

## Escalation Policy

Escalate to a human when any of these occurs:

1. loop budget exceeded
2. same blocker repeated across multiple loop cycles
3. approval pending beyond SLA
4. run stale beyond SLA

## Recommended Alert Thresholds

1. `stale-minutes`: 120
2. `approval-minutes`: 60
3. `loop-ratio`: 0.8
