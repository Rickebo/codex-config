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
- Mandatory Post-Merge Cleanup: delete remote branches after PRs are merged. The delegating Tech Lead is strictly responsible for tearing down worktrees (both implementation and reviewer worktrees) immediately post-merge: run `git -C <repo> worktree remove --force <path>` and delete the local branch (`git -C <repo> branch -d <branch>`). Scheduled/on-demand maintenance runs `/home/rickebo/.codex/bin/prune-worktrees.py --prune-all-safe`.
- Use a PR workflow: prefer to create a branch, worktree and PR for changes that are being implemented. Ensure that PR checks pass before merging. Do not require human review for PRs unless explicitly stated, or if the repo requires it.
- Use GitHub issues to track features and work: create an issue when something that needs to be done is discovered. Comment on issues as work proceeds. When a issue-related PR is created, reference the issue in the PR. Close issues as their respective PR is merged.
  * Hierarchical Tracking & Native Sub-Issues: When major initiatives, migrations, or epics are decomposed into discrete child tasks, always use GitHub's native sub-issues (`gh issue create --parent <parent-id>` or `gh issue edit <parent-id> --add-sub-issue <child-id>`). Never encode parent-child relationships as manual "Child of #..." text strings.
  * Clean Issue Formatting: Always format issue descriptions with proper Markdown headings and clean paragraph breaks (e.g. passing multiline content via `--body-file -` / stdin). Never pass double-escaped `\n\n` string literals that render as raw escape characters in GitHub's UI.
- Prefer minimal changes and debloat the codebase when applicable. Minimize complexity to achieve the given task.
- Always question design, implementation and architecture choices: do not assume that the current state is the most optimal one long term. Sometimes refactoring or rewriting yields a better result.
- Follow your recommendations, industry standards and best practices. Research industry standards and best practices when in doubt.
- Do not over engineer. Prefer minimal changes. Simplicity is key.
- Work with goals: set goals with clear acceptance criteria.
- Enforced Strict Inter-Agent Schema & Epistemic Tagging:
  * Schema Enforcement: All reports back to Tech Leads and Sol MUST conform to `/home/rickebo/.codex/bin/validate-inter-agent-schema.mjs` (`lane`, `status`, `worktree`, `commit_or_pr`, `changed_files`, `validation`, `epistemic_claims`, `blockers`, `next_action`).
  * Epistemic Tagging: Every statement and validation finding must be explicitly tagged: `[FACT]` (empirically verified via tool execution), `[INFERENCE]` (logical deduction from facts), `[HYPOTHESIS]` (unverified theory requiring test), `[UNKNOWN]` (missing external info).
  * Blocker Rule: Blockers can ONLY be formed from `[FACT]`s. Blockers based on `[INFERENCE]`, `[HYPOTHESIS]`, or `[UNKNOWN]` are strictly forbidden.
  * Context Hygiene: Conversational chatter, raw diffs, and verbose logs are rejected at the schema boundary.
- Required Reviews from Fresh Perspective & Asymmetric Evaluation:
  * Worktree PR Review: Before any worktree change is merged, it MUST be evaluated by a fresh `code_reviewer` subagent (`fork_turns = "none"`, zero memory of author history). `code_reviewer` performs asymmetric evaluation: adversarial falsification, probing edge cases, and independently executing tests in a clean environment.
  * Issue Closure Gate:
    - Tier A (Major Work / Architectural Issues): Mandatory `reviewer` (Sol xhigh) evaluation and passing verdict before an issue can be closed. Sol Reviewer verifies acceptance criteria, architecture invariants, and anti-patterns against the original plan.
    - Tier B (Routine / Scoped Work): Fast-path directly to issue closure upon PR merge without invoking Tier 0 Reviewer (standard Tech Lead + `code_reviewer` check is sufficient).
- Multi-Path Consensus for High-Stakes Decisions:
  * High-stakes decisions (declaring physical blockers, production mutations, security/auth policy changes, core breaking architecture) require launching two independent evaluators (`path_a` and `path_b`) with fresh contexts.
  * Consensus Requirement: Both paths must concur with verified `[FACT]` evidence before the decision is adopted. Divergence triggers active synthesis, not abandonment.
- Fire-and-forget orchestration: when delegating to subagents, provide bounded scope, clear testable acceptance criteria, and explicit self-verification commands (test suite, linters, git diff inspection). Subagents must execute autonomously to completion in their dedicated worktree and self-verify before submitting. Eliminate continuous progress check-ins and babysitting; managers issue a single blocking wait.
- Model routing hierarchy:
  * Tier 0 (Root Orchestration, Planning & Review):
    - Sol (`gpt-5.6-sol`): Project manager and orchestration lead. Pure high-level goal decomposition, domain routing, and compact synthesis. Never directly executes code, inspects files, or queries memory.
    - Astra (`gpt-6-astra`): Planning specialist (`planner`) with `xhigh` reasoning. Decomposes major initiatives into architecture invariants, anti-patterns, and discrete GitHub work items. Token-Shield Invariant: Astra does ZERO direct file inspection, grep, shell execution, or web search (`web_search = "disabled"`). It delegates discovery to `code_mapper` (Luna low) and deep research/web lookups exclusively to `planner_researcher` (Terra max).
    - Sol (`gpt-5.6-sol`): Strategic completion reviewer and issue-closing gatekeeper (`reviewer`) with `xhigh` reasoning. Token-Shield Invariant: Sol Reviewer does ZERO direct file inspection, grep, shell execution, or web search (`web_search = "disabled"`). It delegates worktree diff auditing to `code_reviewer` (Luna xhigh) and contract checks to `planner_researcher` (Terra max). Gates closing Tier A issues.
  * Tier 1 (Tech Leads & Strategic Research):
    - Terra (`gpt-5.6-terra`) (`tech_lead_backend`, `tech_lead_devops`, `tech_lead_frontend`, `tech_lead_qa`) with `xhigh` reasoning by default. Own domain lanes end-to-end, manage Luna workers, synthesize results, and report back compactly.
    - Terra (`gpt-5.6-terra`) (`planner_researcher`) with `max` reasoning. Deep technical research and complex code path mapping; available exclusively to the Planner and Reviewer with a generous synthesis budget (~800–1,500 tokens).
  * Tier 2 (Workers / Coders / Reviewers / Discovery):
    - Luna (`gpt-5.6-luna`) with `xhigh` reasoning by default (or `max` reasoning for difficult cases, `code_reviewer` for worktree diff audits, and `low` reasoning for `code_mapper` exploration and code-path mapping). Narrow implementation in dedicated worktrees under `.worktrees/<repo>-<branch>`.
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
