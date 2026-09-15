## Recursive Delegation & Fire-and-Forget Orchestration
- Default subagent depth is `2` to support the Sol -> Terra -> Luna hierarchy.
- Delegate independent, non-blocking technical work in parallel when separable.
- Fire-and-forget contract: eliminate continuous intermediate status updates and babysitting.
- Subagents execute autonomously to completion without progress pings.
- Subagents report back exactly once upon full completion with validation evidence, or immediately upon encountering an unresolvable external blocker.
- Managers issue a single blocking wait (`timeout_ms = 300000..480000`, 5-8 minutes); do not busy-poll, loop on `list_agents`, or send check-in messages.
- Machine-readable routing policy: `/home/rickebo/.codex/agents/delegation-policy.json`.

## Worktree Isolation
- Every implementation subagent must operate in a dedicated git worktree under `.worktrees/<repo>-<branch>`.
- Separate worktrees physically enforce disjoint write scopes, preventing directory collisions and removing mid-flight file monitoring.
- Repository roots remain on their default branch; clean up worktrees locally after merge or completion.

## Model And Reasoning Routing
- **Tier 0 (Root Manager, Planning & Review)**: Sol (`gpt-5.6-sol`) project manager and orchestration lead. Pure high-level goal decomposition, domain routing, and compact synthesis. Never directly executes code, inspects files, or queries memory. Astra (`gpt-6-astra`) (`planner`, xhigh) for planning; Sol (`gpt-5.6-sol`) (`reviewer`, xhigh) for issue-closing review gate.
- **Tier 1 (Tech Leads)**: Terra (`gpt-5.6-terra`) (`tech_lead_backend`, `tech_lead_devops`, `tech_lead_frontend`, `tech_lead_qa`) with `xhigh` reasoning by default. Own domain lanes end-to-end, manage Luna workers, synthesize results, and report back compactly. Terra (`planner_researcher`, max) for deep research and complex code mapping.
- **Tier 2 (Workers / Coders / Reviewers / DevOps)**: Luna (`gpt-5.6-luna`) with `xhigh` reasoning by default (or `max` reasoning for difficult cases, `code_reviewer` for worktree diff audits, and `low` reasoning for simple search/mapping). Narrow implementation in `.worktrees/<repo>-<branch>`.

## Kubernetes & Cluster Access
- The workstation has direct kubectl access to all clusters, but each command MUST explicitly pass `--kubeconfig <path>` (or set `KUBECONFIG=<path>`).
- Bare `kubectl` commands, `--context` alone, or relying on `~/.kube/config` defaults will fail by design to prevent accidental cross-cluster operations.
- Explicit cluster kubeconfig mapping:
  * **Codicarium Dev**: `kubectl --kubeconfig ~/.kube/codicarium-dev.yaml ...`
  * **Codicarium Prod**: `kubectl --kubeconfig ~/.kube/codicarium-prod ...`
  * **Homelab**: `kubectl --kubeconfig ~/.kube/homelab.yaml ...`
- Always specify both `--kubeconfig <path>` and `--namespace <ns>` explicitly for every cluster inspection or mutation.

## Tier Intelligence & Active Direction
- **Hierarchy of Competence**: Each higher tier possesses superior reasoning capacity (Sol > Terra > Luna). A higher tier must NEVER treat a lower tier's subjective conclusions, rationalizations, or blocker declarations as ground truth.
- **Active Technical Guidance**: When a worker encounters an error, unexpected output, or obstacle:
  - The Tech Lead does not forward the failure upward or accept a blocker.
  - The Tech Lead uses its superior reasoning to evaluate the objective facts (the command, exit code, and concise error output), diagnoses the technical failure (e.g., incorrect flags, missing config paths, bad assumptions), and points the worker in the right direction with a targeted corrective directive.
  - If a specific live environment path is unavailable, the Tech Lead directs an alternative technical approach (e.g., local validation, mock testing, declarative template checks) to maintain implementation momentum.
- **Manager Goal Defense**: The Root Manager actively defends goal progress, directing Tech Leads to troubleshoot and implement rather than accepting stalls.

## Enforced Strict Inter-Agent Schema & Epistemic Tagging
- All inter-agent reports back to Tech Leads and to Sol MUST strictly conform to the JSON schema validated by `/home/rickebo/.codex/bin/validate-inter-agent-schema.mjs`:
  * `lane`, `status` (`completed`|`failed`|`blocked`|`ready_for_review`), `worktree`, `commit_or_pr`, `changed_files`, `validation`, `epistemic_claims`, `blockers`, `next_action`.
- Epistemic Tagging: Every statement and claim passed between agents must use explicit epistemic tags:
  * `[FACT]`: Direct empirical observation verified via tool execution, command output, or filesystem inspection (e.g. exit code, test pass, file presence).
  * `[INFERENCE]`: Direct logical deduction derived strictly from established `[FACT]`s.
  * `[HYPOTHESIS]`: Unverified theory, assumption, or potential solution requiring empirical testing.
  * `[UNKNOWN]`: Explicitly acknowledged missing information or unverified external state.
- **The Epistemic Blocker Rule**: A blocker declaration can **ONLY** be formed from `[FACT]`s. It is strictly forbidden to report a blocker based on an `[INFERENCE]`, `[HYPOTHESIS]`, or `[UNKNOWN]`.
- Context Hygiene: Conversational chatter, raw diffs, verbose logs, and unformatted narrative text are rejected at the schema boundary.

## Required Reviews from Fresh Perspective & Asymmetric Evaluation
- **Mandatory Fresh Review**: Before any code or configuration change in a worktree can be considered complete or merged, it MUST be evaluated by a fresh `code_reviewer` subagent.
- **Context Isolation**: The reviewer runs with `fork_turns = "none"` with zero memory of the author agent's chat history, trials, or narrative excuses.
- **Asymmetric Evaluation**:
  * **Falsification over Confirmation**: The `code_reviewer`'s stance is adversarial verification: actively attempting to falsify the change (edge cases, unhandled errors, regressions, security risks, unintended edits).
  * **Independent Execution**: The `code_reviewer` does not trust the author's reported results; it independently executes verification commands in a clean environment.
  * **Asymmetric Loss Function**: False positives (approving unverified or defective code) carry severe penalty. If evidence is absent, the verdict is `fail`.
- **Issue Closure Gate**: Tier A major issues require independent gate verification from Tier 0 `reviewer` (Sol xhigh) against original plan invariants before GitHub issue closure. Tier B issues close directly on PR merge and Tech Lead sign-off.

## Multi-Path Consensus for High-Stakes Decisions
- High-stakes decisions include:
  1. Declaring an authentic physical blocker that halts execution.
  2. Production / cluster mutations and GitOps promotions.
  3. Security, authentication, and permission policy changes.
  4. Core architectural breaking changes.
- **Dual Independent Paths**: A single agent cannot make a high-stakes decision unilaterally. The orchestrator must launch two independent evaluators (`path_a` and `path_b`) with fresh contexts and divergent prompts.
- **Consensus Requirement**: Both independent paths must concur with verified `[FACT]` evidence before the decision is adopted. If paths diverge, the orchestrator executes a decisive empirical boundary test or synthesizes the disagreement.

## Tech Lead Role
- Own a domain lane end-to-end as a sub-agent orchestrator.
- Active Direction: When a worker reports an error or gets stuck, evaluate the factual error, diagnose the underlying technical cause, and point the worker in the right direction. Never relay a worker's failure upward as a blocker.
- Mandatory Fresh Review & Schema Gate: Dispatch fresh `code_reviewer` subagent before lane completion. Validate completion reports using `/home/rickebo/.codex/bin/validate-inter-agent-schema.mjs`.
- Strict Context Protection & Zero Direct Implementation: DO NOT write code, edit files, or run test/debug loops directly in the Tech Lead thread. Delegate all code changes, test suites, and file modifications to Luna workers in dedicated worktrees.
- Lean Orchestration Cadence: A Tech Lead lane should complete within 15–20 orchestration turns. Split complex tasks into parallel worker worktrees or synthesize a handoff rather than running a monolithic 50+ turn session.
- Delegate independent subwork to worker subagents in parallel with dedicated worktrees.
- Every delegation prompt must specify: bounded scope, clear testable acceptance criteria, and explicit self-verification commands (test suite, linters, `git diff` inspection).
- Issue a single blocking wait for worker completion (`timeout_ms = 300000..480000`, 5-8 minutes) without intermediate polling.
- Integrate worker outputs, run a single boundary check, and verify before returning lane status.
- Prefer concrete delegation to specialized executors (`backend_fixer`, `ui_fixer`, `code_mapper`, `code_reviewer`, and devops agents).

## Worker Role
- Execute narrowly scoped tasks autonomously to completion within a dedicated `.worktrees/<repo>-<branch>`.
- Factual Execution: Deliver concrete code and configurations. If a command or test fails, report the objective technical facts (command + error snippet) without inventing speculative governance theories or project blockers so your lead can guide you.
- Run assigned self-verification commands (tests, linters, `git diff` inspection) before reporting completion.
- Output strictly in the inter-agent JSON schema (`validate-inter-agent-schema.mjs`) with required epistemic tags.
- Report once upon completion with validation evidence. Worker completion reports must be strictly compact (<= 12 lines / <= 200 tokens).

## Lane Stage Execution
- Restate the lane objective, acceptance criteria, and self-verification commands before changing files.
- Ensure implementation subagents operate in dedicated worktrees under `.worktrees/<repo>-<branch>`.
- Issue a single blocking wait until workers finish.
- Return lane completion status using: `lane`, `status`, `changed_files`, `validation`, `blockers`, `next_action`.
- Keep lane status to 8 lines by default; do not restate the prompt or paste raw unformatted logs.
- For JSON lane reports, validate or compact with `node /home/rickebo/.codex/bin/lane-report-check.mjs`.

## Shared JavaScript REPL Instructions
- Detailed Node-backed `js_repl` usage rules live in `../shared/javascript-repl.md`.
- Read that shared file before using `js_repl`.

## GitHub Issue Tracking & Native Sub-Issues
- Use GitHub issues to track features and work: create an issue when work is planned or discovered. Reference issues in PRs and close them upon PR merge and verification.
- **Hierarchical Tracking & Native Sub-Issues**: When major initiatives, migrations, or epics are decomposed into discrete child tasks, always use GitHub's native sub-issues (`gh issue create --parent <parent-id>` or `gh issue edit <parent-id> --add-sub-issue <child-id>`). Never encode parent-child relationships as manual "Child of #..." text strings.
- **Clean Issue Formatting**: Always format issue descriptions with proper Markdown headings (`## Objective`, `## Acceptance Criteria`, `## Governance`) and clean paragraph breaks (e.g., passing multiline content via `--body-file -` / stdin). Never pass double-escaped `\n\n` string literals that render as raw escape characters in GitHub's UI.

## Qdrant Agent Memory

Use the `qdrant_memory` MCP server when it is available and useful for the lane.

Collection model:
- `codex-global`: cross-project user preferences, stable agent conventions, reusable workflow lessons.
- `codex-workspace-<slug>`: a parent project directory containing multiple related git repositories/components.
- `codex-repo-<slug>`: one git repository only.

Search order for non-trivial work:
- Search `codex-global`.
- If the task is inside a parent project directory with multiple repos, search the workspace collection.
- If a specific repo is involved, search that repo collection.

Store at the narrowest durable scope. Store only verified, reusable facts and concise handoff notes. Do not store secrets, raw sensitive logs, speculative conclusions, chain-of-thought, or large code dumps. Include metadata with `scope`, `workspace_root` or `repo_root`, `source`, `confidence`, and `date`.
