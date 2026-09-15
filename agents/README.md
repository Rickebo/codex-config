# Codex Agents

This directory defines a small, opinionated custom-agent fleet for your local Codex CLI setup.

## Instruction Scope

- Root orchestration instructions live in `/home/rickebo/.codex/AGENTS.md`.
- Subagent role contracts live in `/home/rickebo/.codex/agents/subagents/AGENTS.md`.
- Shared JavaScript REPL tool instructions live in `/home/rickebo/.codex/agents/shared/javascript-repl.md`.

## MCP Layout

The root Codex session has global `qdrant_memory` and `playwright` MCP entries in
`/home/rickebo/.codex/config.toml`.

Most MCP servers are agent-scoped:

- `qdrant_memory`: configured globally for the root session and on planning, mapping, review, research, GitHub, lead, and implementation agents that benefit from durable memory; the launcher supervises its MCP adapter and terminates it if the owning Codex parent exits
- `playwright`: configured globally with isolated, headless Chrome sessions and transient output under `/tmp/codex-playwright-mcp`; `ui_fixer` repeats the pinned configuration explicitly
- `chrome_devtools`: disabled on `ui_fixer`; Playwright is the browser path
- `context7`: configured on `researcher` and `planner_researcher`
- `homeassistant`: configured on `homeassistant_operator`
- `homelab-obs`: configured on `homelab_devops`
- `codicarium-cluster`: configured on `codicarium_devops`
- `codicarium-telemetry`: configured on `codicarium_devops`
- `github`: configured on `github_operator`
- `perplexity`: configured on `researcher` and `planner_researcher`

## Qdrant Agent Memory

Local persistent memory is backed by Qdrant:

- compose file: `/home/rickebo/.codex/qdrant-memory/compose.yaml`
- data volume: `/home/rickebo/.codex/data/qdrant-memory`
- native binary: `/home/rickebo/.codex/qdrant-memory/bin/qdrant`
- systemd user unit: `codex-qdrant-memory.service`
- MCP launcher: `/home/rickebo/.codex/bin/start-qdrant-memory-mcp`
- server launcher: `/home/rickebo/.codex/bin/start-qdrant-memory-server`
- health check: `/home/rickebo/.codex/bin/qdrant-memory-health`

The MCP server intentionally has no default collection. Agents must pass `collection_name` explicitly:

- `codex-global` for user preferences and cross-project operating conventions
- `codex-workspace-<slug>` for multi-repo parent directories
- `codex-repo-<slug>` for repo-specific memory

## Environment Devops Agents

Each environment devops agent carries:

- `codicarium_devops`
  - `codicarium-cluster` (Kubernetes and Argo CD)
  - `codicarium-telemetry`
- `homelab_devops`
  - `k8s_homelab`
  - `argo_homelab`
  - `homelab-obs`

The Codicarium MetaMCP entries are wired to a local launcher script:

- `/home/rickebo/.codex/bin/start-codicarium-mcp.mjs`

That launcher reads the bearer API key from `~/.codicarium-mcp-api-key` or `CODICARIUM_MCP_API_KEY_FILE`, then proxies the requested MetaMCP endpoint over stdio via `mcp-remote`.

The homelab Argo CD MCP entries are wired to a local launcher script:

- `/home/rickebo/.codex/bin/start-argocd-mcp.mjs`

That launcher reads the current OIDC token from `~/.config/argocd/config` and starts `argocd-mcp` over stdio. No Argo token is stored in the Codex config files.

The homelab Kubernetes MCP entry is wired to the official `ghcr.io/azure/mcp-kubernetes` container in `readonly` mode:

- `homelab_devops` -> `/home/rickebo/.kube/homelab.yaml`

The homelab observability MCP entry is wired to a local launcher script:

- `/home/rickebo/.codex/bin/start-homelab-obs-mcp.mjs`

That launcher reads the bearer token from `HOMELAB_OBSERVABILITY_TOKEN` or `/home/rickebo/.homelab-mcp-api-key`, then proxies the remote MetaMCP observability endpoint over stdio via `mcp-remote`.

## Ownership Model

- `codicarium_devops`: `codicarium-config`, `dev-config`, `app-config`, `infra`, Codicarium Kubernetes/Argo CD, and telemetry operations
- `homelab_devops`: `pve-infra`, homelab Kubernetes/Argo CD operations, and Prometheus/Grafana/Loki diagnosis
- `tech_lead_frontend`: frontend lane ownership, coordination, and delegated frontend execution
- `tech_lead_backend`: backend lane ownership, coordination, and delegated service execution
- `tech_lead_devops`: infra/deploy lane ownership, coordination, and delegated environment operations
- `tech_lead_qa`: verification lane ownership, risk review coordination, and delegated validation
- `planner`: strategic architecture, invariant design, step decomposition, and GitHub work item planning (Astra xhigh reasoning; zero direct code inspection or web search)
- `reviewer`: strategic completion review and issue-closing gatekeeper (Sol xhigh reasoning; zero direct code inspection or web search)
- `planner_researcher`: deep technical lookups, cross-repo code tracing, external web/docs research, and architecture tradeoffs (Terra max reasoning; exclusive to Planner and Reviewer with generous token budget)
- `researcher`: docs lookup, web research, strategy, planning, and current-knowledge synthesis through Perplexity/Context7/OpenAI docs plus live web search
- `homeassistant_operator`: Home Assistant-focused inspection, configuration, and validation through the local Home Assistant MCP surface
- `github_operator`: GitHub-focused issue, PR, workflow, and Projects operations through the GitHub MCP surface
- `code_mapper`: read-only code path mapping (Luna low reasoning)
- `code_reviewer`: adversarial worktree diff auditing and clean-environment test validation (Luna xhigh reasoning)
- `backend_fixer`: backend, CLI, Linux app, and non-UI implementation work
- `ui_fixer`: unified frontend reproduction, browser debugging, visual/layout diagnosis, and implementation work

## Model Routing Policy

Hierarchical routing is strictly enforced across three tiers:
- **Tier 0 (Root Orchestration, Strategic Planning & Review)**:
  * Sol (`gpt-5.6-sol`): Project manager and orchestration lead. Pure high-level goal decomposition, domain routing, and compact synthesis. Never directly executes code, inspects files, or queries memory.
  * Astra (`gpt-6-astra`): Planning specialist (`planner`) with `xhigh` reasoning. Decomposes major initiatives into architecture invariants, anti-patterns, and discrete GitHub work items. Token-Shield Invariant: Astra does ZERO direct file inspection, grep, shell execution, or web search (`web_search = "disabled"`). It delegates discovery to `code_mapper` (Luna low) and deep research/web lookups exclusively to `planner_researcher` (Terra max).
  * Sol (`gpt-5.6-sol`): Strategic completion reviewer and issue-closing gatekeeper (`reviewer`) with `xhigh` reasoning. Token-Shield Invariant: Sol Reviewer does ZERO direct file inspection, grep, shell execution, or web search (`web_search = "disabled"`). It delegates diff auditing to `code_reviewer` (Luna xhigh) and contract checks to `planner_researcher` (Terra max). Gates closing Tier A issues.
- **Tier 1 (Tech Leads & Strategic Research)**:
  * Terra (`gpt-5.6-terra`) (`tech_lead_backend`, `tech_lead_devops`, `tech_lead_frontend`, `tech_lead_qa`) with `xhigh` reasoning by default. Own domain lanes end-to-end, manage Luna workers, synthesize results, and report back compactly.
  * Terra (`gpt-5.6-terra`) (`planner_researcher`) with `max` reasoning. Deep technical research and complex code path mapping; available exclusively to the Planner and Reviewer with a generous synthesis budget (~800–1,500 tokens).
- **Tier 2 (Workers / Coders / Reviewers / Discovery)**:
  * Luna (`gpt-5.6-luna`) (`backend_fixer`, `ui_fixer`, `code_mapper`, `homelab_devops`, `codicarium_devops`, `code_reviewer`) with `xhigh` reasoning by default (or `max` reasoning for difficult cases, `code_reviewer` for worktree diff audits, and `low` reasoning for `code_mapper` exploration and code-path mapping). Narrow implementation in dedicated worktrees under `.worktrees/<repo>-<branch>`.

### Fast-Path Gating Rules
- **Planner Fast-Path**: Tier A tasks (major architecture, cross-repo, migrations, security, high ambiguity) require `planner` (Astra xhigh) before implementation starts. Tier B tasks (single-repo bug fixes, minor bumps, routine chores) fast-path past `planner` directly to Tech Leads.
- **Reviewer Fast-Path**: Tier A issues require `reviewer` (Sol xhigh) approval (`verdict = "pass"`) before the issue can be closed. Tier B issues fast-path directly to closure upon PR merge without invoking Tier 0 `reviewer` (standard Tech Lead + `code_reviewer` checks are sufficient).

## Delegation Policy

Machine-readable routing lives in:

- `/home/rickebo/.codex/agents/delegation-policy.json`

Defaults:

- Root Sol engages Tier 0 Astra Planner (`planner`) for major architectural initiatives, then delegates implementation lanes exclusively to Terra Tech Leads (`tech_lead_*`)
- Terra Tech Leads delegate implementation to Luna workers in dedicated git worktrees
- No direct code writing or command execution in the root manager session
- Blocking wait with 5–8 minute timeout (`timeout_ms = 300000..480000`) to preserve cache warmth and prevent polling loops
- Strict compact completion contract (<= 12 lines / <= 200 tokens)

## Next Wiring Steps

1. Ensure `/home/rickebo/.codicarium-mcp-api-key` contains the Codicarium MCP API key.
2. Refresh Homelab Argo CD login when needed:
   `argocd login argocd.rwy2gjx4hcvxhsvx.rickebo.com --sso --grpc-web --name argocd.rwy2gjx4hcvxhsvx.rickebo.com`
3. If the homelab Argo MCP launcher reports an expired token, rerun the full `argocd login ... --sso --grpc-web --name ...` command for that context. The launcher now checks token expiry before starting the MCP process.
4. Make sure Docker can pull `ghcr.io/azure/mcp-kubernetes` the first time the agent starts.
5. Spawn `codicarium_devops` and `homelab_devops` and verify each only sees the MCP set intended for it.
6. For `researcher`, either export `PERPLEXITY_API_KEY` or place the key in `/home/rickebo/.codex/api-keys/perplexity`. The launcher reads the file directly, so a restart is not required for the file-based path.
7. For Context7, either export `CONTEXT7_API_KEY` or place the key in `/home/rickebo/.codex/api-keys/context7`. The launcher reads the file directly for `researcher`.
8. For Home Assistant, place a Home Assistant long-lived access token in `/home/rickebo/.codex/api-keys/homeassistant` or `/home/rickebo/.codex/api-keys/home-assistant`, or export `HOMEASSISTANT_TOKEN`.
   The launcher uses a local stdio bridge and an SSH tunnel through `has` because `codex mcp login homeassistant` currently fails against Home Assistant with dynamic registration errors.
9. For file-backed Home Assistant config editing, optionally set `HOMEASSISTANT_CONFIG_DIR` to your config root. Otherwise the helper will try the current workspace and common paths like `/config` and `~/.homeassistant`.
10. For homelab observability in `homelab_devops`, either export `HOMELAB_OBSERVABILITY_TOKEN` or place the bearer token in `/home/rickebo/.homelab-mcp-api-key`. Override the remote endpoint with `HOMELAB_OBSERVABILITY_MCP_URL` if the MetaMCP URL changes.
11. For GitHub Projects support in `github_operator`, your current `gh` token needs the `project` scope:
    `gh auth refresh --hostname github.com --scopes project`
    The launcher reuses `gh auth token`, so no separate GitHub PAT file is required.

## GitHub Task Memory

GitHub-backed durable task memory is supported through:

- `github_operator`
- the `plan-execution` skill
- the `github-task-memory` skill at `/home/rickebo/.codex/skills/github-task-memory/SKILL.md`
- the local helper `/home/rickebo/.codex/bin/github-task-memory.mjs`
- the local config `/home/rickebo/.codex/github-task-memory.json`

Recommended model:

- repo issues are the durable task records
- one product-level GitHub Project acts as the cross-repo queue when configured
- `github_operator` is the canonical GitHub writer

Recommended project statuses:

- `Inbox`
- `Ready`
- `In Progress`
- `Blocked`
- `Review`
- `Done`
- `Icebox`

Recommended project fields:

- `Status`
- `Priority`
- `Area`
- `Agent Owner`
- `Blocked Reason`
- `Next Action`
- `Target Environment`

Default issue label from the local config:

- `codex-tracked`

Default priority labels from the local config, highest to lowest:

- `priority:p0`
- `priority:p1`
- `priority:p2`
- `priority:p3`

Default fallback priority label:

- `priority:p2`

Suggested repo-to-project config shape in `/home/rickebo/.codex/github-task-memory.json`:

- fill `repos["OWNER/REPO"].project.owner`
- fill `repos["OWNER/REPO"].project.owner_type`
- fill `repos["OWNER/REPO"].project.number`
- optionally override issue labels, priority labels, or field names per repo

Behavioral rules:

1. Before starting non-trivial work, check for an existing relevant issue.
2. If no issue exists and the work should outlive the current turn, create one.
3. Assign exactly one priority label to the issue.
4. Add it to the configured product project when available.
5. Move active work to `In Progress`.
6. If blocked, move it to `Blocked` and record the blocker and next action.
7. When discovering follow-up work, create new issues immediately instead of relying on chat memory, and assign a priority label.
8. Close an issue only after verification is explicit.

Priority-selection rule when choosing the next task:

1. inspect `In Progress` relevant to the current repo first
2. then inspect `Ready`
3. within each queue, sort by priority label from `priority:p0` to `priority:p3`
4. only then consider `Inbox`

## Plan-Driven Workflow

For plan-heavy work:

- `planner` is the read-only specialist for turning goals or rough plans into executable steps with dependencies, ownership, and validation.
- when decomposing major initiatives into child issues, use GitHub's native sub-issues (`gh issue create --parent <parent-id>` or `gh issue edit <parent-id> --add-sub-issue <child-id>`) with clean Markdown formatting, never embedding raw "Child of #..." strings or literal `\n` escape sequences.
- the `plan-execution` skill is available at `/home/rickebo/.codex/skills/plan-execution/SKILL.md` and is intended for prompts where the user provides a plan and wants Codex to execute against it while keeping progress visible.

Typical split:

1. `planner` tightens the plan when the user goal or draft plan is still messy.
2. the root agent executes the plan, optionally delegating steps to `code_mapper`, `backend_fixer`, `ui_fixer`, `reviewer`, `researcher`, `github_operator`, or the devops agents.
3. the final response maps completed work back to the plan.

## Aggressive Delegation Launcher

The active Codex harness policy only treats explicit user authorization as permission to spawn sub-agents.

For future sessions, use:

- `/home/rickebo/.codex/bin/codex-subagents`
- `/home/rickebo/.codex/bin/codex-subagents "your initial task"`
- `/home/rickebo/.codex/bin/codex-subagents exec "your one-shot task"`
- `/home/rickebo/.codex/bin/codex-fast` for lower-latency general sessions

This launcher prepends a delegation preamble to the initial user prompt so new sessions start with explicit authorization to use sub-agents aggressively.
For cheaper low-risk sessions, prefer `codex-fast`; it disables multi-agent by default and uses compact process guidance.

## Manager-Manager Launcher

For project-manager-style sessions, use:

- `/home/rickebo/.codex/bin/codex-manager`
- `/home/rickebo/.codex/bin/codex-manager-lite`
- `/home/rickebo/.codex/bin/codex-manager "your initial task"`
- `/home/rickebo/.codex/bin/codex-manager exec "your one-shot task"`

This launcher prepends a stronger orchestration preamble so the root session stays manager-first and routes implementation through tech leads.
By default it starts the root session with `-s read-only` so the manager cannot write code directly.
Override only when needed with an explicit sandbox flag, for example `-s workspace-write` or `-s danger-full-access`.

`codex-manager-lite` enforces `agents.max_depth=1` and `agents.max_threads=4`, allows one direct worker for single-domain tasks, and reserves tech leads for multi-domain or integration-risk work.

Local agent capacity is configured in `/home/rickebo/.codex/config.toml` with:

- `features.multi_agent = true`
- `agents.max_threads = 4`
- `agents.max_depth = 2`

## Skill Fast Paths

Broad Superpowers process skills are disabled in `/home/rickebo/.codex/config.toml` through `skills.config` overrides.

Local compact replacements:

- `compact-planning`
- `compact-tdd`
- `compact-debugging`
- `compact-code-review`
- `compact-delegation`
- `compact-verification`

Use full manager mode when the compact skills hit ambiguity, high risk, or repeated validation failure.

## Concurrent Root Coordination

For 2+ concurrent root sessions, claim a task before planning:

- `/home/rickebo/.codex/bin/codex-task-registry claim --task <id> --owner <root-id>`
- `/home/rickebo/.codex/bin/codex-task-registry list`
- `/home/rickebo/.codex/bin/codex-task-registry release --task <id> --owner <root-id>`

The helper stores claims in `/home/rickebo/.codex/runtime/root-task-registry.json`, protects writes with `flock`, and expires stale claims by TTL.

## OpenAI Docs Routing

- `researcher` does not rely on a dedicated OpenAI MCP server.
- Route OpenAI-specific docs questions through the `openai-docs` skill first.
- Use native live web search for OpenAI docs only when the skill path is unavailable or insufficient.

## Home Assistant MCP Notes

- Home Assistant exposes native MCP on `/api/mcp` and `/api/mcp/<api_id>` using Streamable HTTP; the built-in Assist API is available as `/api/mcp/assist`.
- The Home Assistant agent uses a long-lived token plus a local SSH tunnel (`ssh has`, `127.0.0.1:18123 -> has:8123`) because Codex OAuth registration is not reliable with this local installation.
- The native integration can expose tools, prompts, and version-specific resources; the agent must inspect the live MCP surface instead of assuming a fixed capability set.
- Home Assistant access remains limited by the entities exposed in Home Assistant, and this agent is not a replacement for unrestricted dashboard or host-file editing.

## Home Assistant Dev Helper

The Home Assistant agent also uses:

- `/home/rickebo/.codex/bin/ha-dev.mjs`

Useful commands:

- `node /home/rickebo/.codex/bin/ha-dev.mjs detect-config-dir`
- `node /home/rickebo/.codex/bin/ha-dev.mjs get-config`
- `node /home/rickebo/.codex/bin/ha-dev.mjs get-states`
- `node /home/rickebo/.codex/bin/ha-dev.mjs check-config`
- `node /home/rickebo/.codex/bin/ha-dev.mjs backup`
- `node /home/rickebo/.codex/bin/ha-dev.mjs reload automation`
- `node /home/rickebo/.codex/bin/ha-dev.mjs reload template`
- `node /home/rickebo/.codex/bin/ha-dev.mjs reload lovelace_resources`
- `node /home/rickebo/.codex/bin/ha-dev.mjs render-template @/path/to/template.j2`
- `node /home/rickebo/.codex/bin/ha-dev.mjs validate-config @/path/to/validate-config.json`

The intended Home Assistant workflow is:

1. Inspect live state through the Home Assistant MCP.
2. Edit YAML-backed config locally when appropriate.
3. Run `check-config`.
4. Run `backup` before any live apply step.
5. Reload the narrowest scope possible.
6. Verify via the native Home Assistant MCP and the REST/WebSocket helper.

## Argo Guardrails

The Argo CD MCP entries only expose a restricted tool set:

- list and inspect applications
- inspect workload logs and events
- inspect resource trees
- trigger syncs

They do not expose create, update, delete, or arbitrary resource-action tools.

## Kubernetes Guardrails

The Kubernetes MCP entries use `--access-level readonly`, so they can inspect cluster state, logs, and resources but cannot mutate the cluster directly. GitOps changes should still flow through the environment-specific repos and Argo sync.
