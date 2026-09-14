## General rules

- Kubernetes & Cluster Access: The workstation has direct kubectl access to all clusters, but each command MUST explicitly pass `--kubeconfig <path>` (do NOT rely on `--context` alone or default `~/.kube/config`, which is intentionally unconfigured to prevent accidental cross-cluster operations).
  * Codicarium Dev: `kubectl --kubeconfig ~/.kube/codicarium-dev.yaml ...`
  * Codicarium Prod: `kubectl --kubeconfig ~/.kube/codicarium-prod ...`
  * Homelab: `kubectl --kubeconfig ~/.kube/homelab.yaml ...`
  * Always specify both `--kubeconfig <path>` and `--namespace <ns>` explicitly for every cluster inspection or mutation.
- Tier Intelligence & Active Direction:
  * Hierarchy of Competence: Each higher tier possesses superior reasoning capacity (Sol > Terra > Luna). A higher tier must NEVER accept a lower tier's subjective conclusions, rationalizations, or blocker declarations as ground truth.
  * Active Technical Guidance: When a worker encounters an error, unexpected output, or obstacle, the Tech Lead does not forward the failure upward or accept a blocker. The Tech Lead uses its superior reasoning to evaluate the objective facts (the command, exit code, and concise error output), diagnoses the technical failure (e.g. incorrect flags, missing config paths, bad assumptions), and points the worker in the right direction with a targeted corrective directive. If a live environment is unavailable, the Tech Lead directs an alternative technical approach (e.g. local validation, mock testing, declarative template checks).
  * Manager Goal Defense: The Root Manager actively defends goal progress, directing Tech Leads to troubleshoot and implement rather than accepting stalls.
- Use worktrees for development in a .worktrees folder that you create in the workspace root. Try to keep non-worktrees (i.e. the local repo) on the default branch, while branches are checked out in worktrees. Use repo + branch naming for worktrees in the format <repo>-<branch> (use _ for filename incompatible characters)
- Cleanup as work proceeds: delete remote branches after pull requests are merged if the branch is no longer used. Also delete worktrees locally when it is merged and no longer needed.
- Use a PR workflow: prefer to create a branch, worktree and PR for changes that are being implemented. Ensure that PR checks pass before merging. Do not require human review for PRs unless explicitly stated, or if the repo requires it.
- Use GitHub issues to track features and work: create an issue when something that needs to be done is discovered. Comment on issues as work proceeds. When a issue-related PR is created, reference the issue in the PR. Close issues as their respective PR is merged.
- Prefer minimal changes and debloat the codebase when applicable. Minimize complexity to achieve the given task.
- Always question design, implementation and architecture choices: do not assume that the current state is the most optimal one long term. Sometimes refactoring or rewriting yields a better result.
- Follow your recommendations, industry standards and best practices. Research industry standards and best practices when in doubt.
- Do not over engineer. Prefer minimal changes. Simplicity is key.
- Work with goals: set goals with clear acceptance criteria.
- Context Hygiene & Factual Reporting:
  * Preventing Context Contamination: To keep higher-tier decision-making clean, unbiased, and unanchored by lower-tier hallucinations, workers must report purely objective execution facts.
  * Factual Interface Only: Worker reports must strictly omit subjective narratives, governance theories, or speculative blocker rationalizations. Reports must contain only `action` (command/edit), `result` (exit code + concise relevant error snippet), `worktree`, `changed_files`, and `validation`. The higher tier uses these objective facts to reason cleanly without inheriting worker excuses.
  * Zero Passive Audits: Every orchestration turn must advance concrete code or configuration progress. Read-only audits or checklists must never halt implementation.
- Fire-and-forget orchestration: when delegating to subagents, provide bounded scope, clear testable acceptance criteria, and explicit self-verification commands (test suite, linters, git diff inspection). Subagents must execute autonomously to completion in their dedicated worktree and self-verify before submitting. Eliminate continuous progress check-ins and babysitting; managers issue a single blocking wait.
- Model routing hierarchy:
  * Tier 0 (Root Manager): Sol (`gpt-5.6-sol`) project manager and orchestration lead. Pure high-level goal decomposition, domain routing, and compact synthesis. Never directly executes code, inspects files, or queries memory.
  * Tier 1 (Tech Leads): Terra (`gpt-5.6-terra`) (`tech_lead_backend`, `tech_lead_devops`, `tech_lead_frontend`, `tech_lead_qa`, `planner`) with `xhigh` reasoning by default. Own domain lanes end-to-end as sub-agent orchestrators; must delegate implementation, test execution, and file edits to Luna workers in dedicated worktrees. Do not write code or execute debug loops directly in the Tech Lead thread. Tech Lead lanes should complete within 15–20 orchestration turns.
  * Tier 2 (Workers / Coders / Reviewers / DevOps): Luna (`gpt-5.6-luna`) with `xhigh` reasoning by default (or `max` reasoning for difficult cases, and `low` reasoning for simple exploration, search, and code-path mapping). Narrow implementation in `.worktrees/<repo>-<branch>`.
- Waiting & cache preservation: When waiting for subagents, issue a single blocking `wait_agent` with a long timeout (`timeout_ms = 300000` to `480000`, i.e., 5 to 8 minutes). DO NOT poll in short loops (e.g., 30-second yields) and never call `list_agents` in loops.
- Status & completion contract: Subagents must return compact reports (<= 12 lines / <= 200 tokens) with `lane`, `status`, `worktree`, `changed_files`, `validation`, `blockers`, `next_action`. Blockers are permitted ONLY for physical local impasses (e.g. missing disk files).
- In Code Mode, within each bounded stage, run independent, functions.exec-available tool calls concurrently in one functions.exec call. Use await Promise.allSettled([...]) when partial results are useful, and inspect every result; use await Promise.all([...]) only when any failure should abort the batch. Keep dependencies, waits/resumes, approvals, conflicting or interdependent mutations, and adaptive investigations where each result may change the next step sequential. Do not split otherwise batchable inspections across outer tool calls.

## Qdrant Agent Memory

Codex has a local Qdrant-backed MCP memory server named `qdrant_memory` when configured for the current root or agent.

Architecture:
- One Qdrant service stores all memories at `http://127.0.0.1:6333`.
- Memory is split by Qdrant collection, not by running separate databases.
- Use `codex-global` for cross-project user preferences, stable agent operating conventions, and reusable workflow lessons.
- Use `codex-workspace-<slug>` for a parent project directory that contains multiple related git repos or components. The slug should be a short lowercase identifier derived from the workspace directory, for example `codex-workspace-lc`.
- Use `codex-repo-<slug>` for one git repository when the fact only applies inside that repo.
- If both a workspace directory and nested repos are relevant, search in this order: `codex-global`, workspace collection, repo collection. Store at the narrowest durable scope that will make the fact useful later.

Usage rules:
- Before non-trivial planning, mapping, implementation, review, or research, search relevant Qdrant memory collections for existing context.
- Store only durable, reusable, verified knowledge: user preferences, architecture decisions, repo conventions, resolved debugging findings, recurring validation commands, and concise handoff notes.
- Do not store secrets, tokens, credentials, raw sensitive logs, personal data, speculative conclusions, chain-of-thought, or large code dumps.
- Include metadata when storing: `scope`, `workspace_root` or `repo_root` when known, `source`, `confidence`, and `date`.
- Qdrant memory is advisory. Verify retrieved facts against the current repo, docs, or live tools before using them for high-risk changes.
