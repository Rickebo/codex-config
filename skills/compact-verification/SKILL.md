---
name: compact-verification
description: Use before claiming a change is complete when focused validation evidence is needed without a broad completion workflow.
---

# Compact Verification

Make completion claims evidence-based.

## Fast Path

1. Identify the behavior or file type changed.
2. Run the narrowest meaningful validation command.
3. If no command is available, perform a concrete static or manual check and say why.
4. Confirm generated wrappers/config parse if shell, TOML, JSON, or schema files changed.

## Output

Report:
- commands run
- result
- anything not run
- residual risk if material

Do not claim tests passed unless the relevant command completed successfully.
