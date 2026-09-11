---
name: compact-delegation
description: Use when choosing whether to delegate a task and a compact routing decision is needed for root, worker, tech-lead, manager, or pipeline execution.
---

# Compact Delegation

Choose the cheapest execution shape that preserves correctness.

## Routing

- Trivial read-only lookup: root direct or `code_mapper`.
- Single-file or single-module fix: root direct or one `service_fixer`/`ui_fixer`.
- Single-domain feature: one worker and optional compact review.
- Frontend plus backend: two direct workers, or tech leads if integration risk is high.
- Browser-only uncertainty: `browser_debugger` or `web_debugger`, then one fixer.
- CI/log issue: `github_operator` for evidence, then one fixer.
- Infra/GitOps/security/release-grade work: manager or pipeline mode.

## Limits

Default to depth 1. Use recursive delegation only in explicit manager or pipeline mode. Keep write scopes disjoint.

## Output

Return selected mode, owners, validation, and the one next action.
