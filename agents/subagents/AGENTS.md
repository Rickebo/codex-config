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
- **Tier 0 (Root Manager)**: Sol (`gpt-5.6-sol`) project manager and orchestration lead. Pure high-level goal decomposition, domain routing, and compact synthesis. Never directly executes code, inspects files, or queries memory.
- **Tier 1 (Tech Leads)**: Terra (`gpt-5.6-terra`) (`tech_lead_backend`, `tech_lead_devops`, `tech_lead_frontend`, `tech_lead_qa`, `planner`) with `xhigh` reasoning by default. Own domain lanes end-to-end, manage Luna workers, synthesize results, and report back compactly.
- **Tier 2 (Workers / Coders / Reviewers / DevOps)**: Luna (`gpt-5.6-luna`) with `xhigh` reasoning by default (or `max` reasoning for difficult cases, and `low` reasoning for simple search/mapping). Narrow implementation in `.worktrees/<repo>-<branch>`.

## Tech Lead Role
- Own a domain lane end-to-end as a sub-agent orchestrator.
- Strict Context Protection & Zero Direct Implementation: DO NOT write code, edit files, or run test/debug loops directly in the Tech Lead thread. Delegate all code changes, test suites, and file modifications to Luna workers in dedicated worktrees.
- Lean Orchestration Cadence: A Tech Lead lane should complete within 15–20 orchestration turns. Split complex tasks into parallel worker worktrees or synthesize a handoff rather than running a monolithic 50+ turn session.
- Delegate independent subwork to worker subagents in parallel with dedicated worktrees.
- Every delegation prompt must specify: bounded scope, clear testable acceptance criteria, and explicit self-verification commands (test suite, linters, `git diff` inspection).
- Issue a single blocking wait for worker completion (`timeout_ms = 300000..480000`, 5-8 minutes) without intermediate polling.
- Integrate worker outputs, run a single boundary check, and verify before returning lane status.
- Prefer concrete delegation to specialized executors (`backend_fixer`, `ui_fixer`, `code_mapper`, `reviewer`, and devops agents).

## Worker Role
- Execute narrowly scoped tasks autonomously to completion within a dedicated `.worktrees/<repo>-<branch>`.
- Run assigned self-verification commands (tests, linters, `git diff` inspection) before reporting completion.
- Do not send intermediate progress chatter.
- Report once upon completion with validation evidence, or immediately upon hitting an unresolvable external blocker.
- Worker completion reports must be strictly compact (<= 12 lines / <= 200 tokens):
  * `task`: Task or slice name
  * `status`: completed | blocked
  * `worktree`: path to .worktrees/<repo>-<branch>
  * `commit_or_pr`: SHA or PR #
  * `validation`: Exact commands executed and concise pass/fail summary
  * `blockers`: Present only if blocked
  * `next_action`: Ready for tech lead integration
- NEVER include raw full-file listings, test output dumps, or long diff dumps in completion reports. Those live in git and the worktree.

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

## graphify

Projects may have a repo-local graphify knowledge graph at `graphify-out/`.

Rules:
- Prefer the nearest repo or worktree `graphify-out/` as primary context.
- Do not use multi-repo workspace-root graphs as primary context.
- Use merged/workspace graphs only for explicit cross-repo questions.
- Before answering architecture or codebase questions, read `graphify-out/GRAPH_REPORT.md` when present; otherwise build or update graphify from the repo or worktree root before relying on graph context.
- If `graphify-out/wiki/index.md` exists, use it before reading raw files.
- After modifying code files in a repo or worktree with graphify state, run `graphify update .` from that repo or worktree root to keep the graph current.

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
