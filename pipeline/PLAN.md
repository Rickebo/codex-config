# Pipeline Orchestration Plan

## Objective
Implement a deterministic, stage-gated delivery pipeline for Codex sessions:

1. `spec`
2. `code`
3. `review`
4. `test`
5. `validation`
6. loop back when needed until pass criteria are met

The key requirement is structural control in code, not prompt-only routing.

## Evidence-Based Design Choices

1. Use code-orchestrated flow for determinism.
Reason: OpenAI Agents SDK documentation distinguishes LLM orchestration from code orchestration and explicitly recommends code orchestration for predictable cost/speed/behavior.
Source: https://openai.github.io/openai-agents-python/multi_agent/

2. Keep model agents as workers and enforce transitions in a state machine.
Reason: AutoGen FSM/selector patterns show explicit transition control is the right abstraction for constrained multi-agent routing.
Sources:
- https://microsoft.github.io/autogen/0.2/blog/2024/02/11/FSM-GroupChat/
- https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html

3. Persist workflow state and reports.
Reason: Durable workflow state and resumability are standard reliability requirements for long-running iterative loops.
Sources:
- https://docs.langchain.com/oss/python/langgraph/durable-execution
- https://docs.langchain.com/oss/javascript/langgraph/persistence

4. Add hard loop controls and escalation.
Reason: Production workflow systems rely on explicit retry/catch thresholds rather than unconstrained autonomous loops.
Sources:
- https://docs.aws.amazon.com/step-functions/latest/dg/state-task.html
- https://docs.aws.amazon.com/step-functions/latest/dg/test-state-isolation.html

5. Use tool-informed critique between iterations.
Reason: Iterative critique + refinement with external signals improves reliability.
Sources:
- https://arxiv.org/abs/2303.17651
- https://arxiv.org/abs/2303.11366
- https://arxiv.org/abs/2305.11738

## Architecture

1. Root session remains manager-only.
2. Root delegates execution to tech leads and workers.
3. Stage transitions are enforced by a local controller script:
   - reads stage reports (JSON)
   - validates allowed transitions
   - updates persistent run state
   - enforces max loop limits
   - signals escalation when limits are exceeded
4. `spec` stage requires a passing feature-spec quality check before `code` can start.

## Phase 1 (Implemented in this change set)

1. Define transition policy file.
2. Define stage report JSON schema.
3. Implement `pipeline-controller.mjs` with:
   - `init`
   - `advance`
   - `status`
4. Add a dedicated launcher prompt (`codex-pipeline`) that requires use of the controller and schema.
5. Update AGENTS policy blocks to include pipeline FSM requirements.

## Phase 2 (Implemented)

1. CI validation for stage reports and transition logs:
   - `/home/rickebo/.codex/bin/pipeline-ci-check.mjs`
2. Aggregated metrics:
   - `/home/rickebo/.codex/bin/pipeline-metrics.mjs`
3. Optional human approval gates for high-risk changes:
   - `/home/rickebo/.codex/pipeline/approval-rules.json`
   - `pipeline-controller.mjs approve`

## Phase 3 (Implemented as Durable Runtime + Ops Scaffolding)

1. Durable runtime adapter templates:
   - `/home/rickebo/.codex/pipeline/adapters/langgraph-workflow.example.py`
   - `/home/rickebo/.codex/pipeline/adapters/temporal-workflow.example.py`
2. Dashboards and alerting scaffolding:
   - `/home/rickebo/.codex/bin/pipeline-alerts.mjs`
   - `/home/rickebo/.codex/pipeline/OPERATIONS.md`
