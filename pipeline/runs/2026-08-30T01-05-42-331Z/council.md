# Council decision: infra PR #1155 refresh

Planner: rebase the six-commit Phase 0 series onto exact canonical main `4096b5da32b4e734e05552a8ede7dc58dd01deaf` (advanced by one non-overlapping kubeconfig-validation commit during the first guarded attempt), preserve current-main topology/publication checks, add exact parser coverage, and update the remote only with an exact lease against `b6bed30712e85bf9885211ceb35e739ac72e273f`.

Reviewer: the indexed production templates at the authoritative GitHub head are valid. The missing live protected environment, environment-scoped secret proof, dedicated trusted runner, Authentik session evidence, and local-admin break-glass proof remain hard merge/deploy blockers and must not be bypassed in code.

QA: add parser-level tests that evaluate the exact production account/token templates through real kubectl for present and absent keys, while retaining fake-cluster transaction, RBAC, workflow, shell, Python, and repository checks. Require independent exact-head Luna review and fresh PR checks.

Consensus: code scope is rebase plus parser-test hardening only. No merge, dispatch, deployment, credential access, GitHub environment change, or live authorization mutation is permitted. If canonical main or the remote PR head changes, stop and re-plan rather than overwriting concurrent work.
