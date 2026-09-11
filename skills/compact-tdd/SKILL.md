---
name: compact-tdd
description: Use when implementing a behavior-changing feature or bugfix where a focused test is feasible and a full TDD workflow would be disproportionate.
---

# Compact TDD

Protect behavior with the narrowest useful test loop.

## Fast Path

1. Identify the behavior that can regress.
2. Add or update one focused test before implementation when feasible.
3. Run the test and confirm it fails for the expected reason, unless the existing failing test already proves the bug.
4. Implement the smallest change.
5. Run the focused test, then the nearest relevant suite if risk warrants it.

## Exceptions

Do not create a new test when the change is docs-only, config-only, mechanical formatting, or a throwaway investigation. State that explicitly in validation.

## Output

Report changed files, test command, pass/fail result, and any residual coverage gap.
