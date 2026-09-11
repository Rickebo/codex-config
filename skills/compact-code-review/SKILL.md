---
name: compact-code-review
description: Use when reviewing a small or medium diff for correctness, regressions, security, maintainability, or missing tests without a heavyweight review process.
---

# Compact Code Review

Review like an owner, but keep the report bounded.

## Findings Contract

- Max 5 findings unless a critical issue requires more.
- Order by severity.
- Each finding: severity, file/symbol, issue, minimal fix direction.
- Say `no blocking findings` when clean.
- Do not include praise, broad summaries, or prompt restatement.

## Review Focus

Prioritize:
- correctness and data loss
- security boundaries
- behavior regressions
- concurrency and lifecycle bugs
- missing tests for risky behavior

Ignore style-only comments unless they hide a real risk.
