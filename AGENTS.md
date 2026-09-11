## General rules

- Do not design or implement for backwards compatibility unless it is explicitly stated.
- When working with devops, like Kubernetes or cloud projects: always ensure that the right project, cluster or deployment is used for the project. Do not trust CLI defaults, active profiles or the local kube context. Each command needs to explicitly define the context and project to use.
- Global system state may change as work proceeds, always assume that other work is ongoing concurrently on the same machine, by humans and other agents.
- Use worktrees for development in a .worktrees folder that you create in the workspace root. Try to keep non-worktrees (i.e. the local repo) on the default branch, while branches are checked out in worktrees. Use repo + branch naming for worktrees in the format <repo>-<branch> (use _ for filename incompatible characters)
- Cleanup as work proceeds: delete remote branches after pull requests are merged if the branch is no longer used. Also delete worktrees locally when it is merged and no longer needed.
- Use a PR workflow: prefer to create a branch, worktree and PR for changes that are being implemented. Ensure that PR checks pass before merging. Do not require human review for PRs unless explicitly stated, or if the repo requires it.
- Use GitHub issues to track features and work: create an issue when something that needs to be done is discovered. Comment on issues as work proceeds. When a issue-related PR is created, reference the issue in the PR. Close issues as their respective PR is merged.
- Prefer minimal changes and debloat the codebase when applicable. Minimize complexity to achieve the given task.
- Always question design, implementation and architecture choices: do not assume that the current state is the most optimal one long term. Sometimes refactoring or rewriting yields a better result.
- Follow your recommendations, industry standards and best practices. Research industry standards and best practices when in doubt.
- Do not over engineer. Prefer minimal changes. Simplicity is key.
- Do not try to avoid breaking changes, they are encouraged unless otherwise is explicitly stated.
- Work with goals. Try to set a goal for a user-stated task that has a task description and clear acceptance criteria. Only mark a goal as blocked when external blockers require user input or a user action to unblock.
- Fire-and-forget orchestration: when delegating to subagents, provide bounded scope, clear testable acceptance criteria, and explicit self-verification commands (test suite, linters, git diff inspection). Subagents must execute autonomously to completion in their dedicated worktree and self-verify before submitting. Eliminate continuous progress check-ins and babysitting; managers issue a single blocking wait.
- Model routing hierarchy:
  * Tier 0 (Root Manager): Sol (`gpt-5.6-sol`) project manager and orchestration lead. Pure high-level goal decomposition, domain routing, and compact synthesis. Never directly executes code, inspects files, or queries memory.
  * Tier 1 (Tech Leads): Terra (`gpt-5.6-terra`) (`tech_lead_backend`, `tech_lead_devops`, `tech_lead_frontend`, `tech_lead_qa`, `planner`) with `medium` or `high` reasoning. Own domain lanes end-to-end, manage Luna workers, synthesize results, and report back compactly.
  * Tier 2 (Workers / Coders / Reviewers / DevOps): Luna (`gpt-5.6-luna`) with `medium` reasoning (or `low` reasoning for simple exploration, search, and code-path mapping). Narrow implementation in `.worktrees/<repo>-<branch>`.
- Waiting & cache preservation: When waiting for subagents, issue a single blocking `wait_agent` with a long timeout (`timeout_ms = 300000` to `480000`, i.e., 5 to 8 minutes). DO NOT poll in short loops (e.g., 30-second yields) and never call `list_agents` in loops.
- Status & completion contract: Subagents must return compact reports (<= 12 lines / <= 200 tokens) with `lane`, `status`, `worktree`, `changed_files`, `validation`, `blockers`, `next_action`.
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
