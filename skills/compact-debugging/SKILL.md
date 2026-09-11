---
name: compact-debugging
description: Use when a bug, failing test, build failure, or unexpected behavior needs root-cause work without loading a full debugging playbook.
---

# Compact Debugging

Find the cause before changing behavior.

## Fast Path

1. Capture the exact failure command, route, or symptom.
2. Reproduce once if practical.
3. Read the smallest relevant error/log snippet.
4. Check recent local changes and nearby known-good patterns.
5. State one root-cause hypothesis.
6. Make one targeted fix.
7. Re-run the failing command or closest validation.

## Escalate

Use a full systematic debug flow when the failure is flaky, cross-service, security-sensitive, deployment-related, or still unexplained after one focused loop.

## Output

Report cause, fix, validation, and next action. Do not paste full logs.
