# Council decision

The Luna planner, security reviewer, and QA lead agree that PR #156 may proceed only after a documentation-only correction names the shared `codicarium-release-mutations` group and every automated ref/release-shell writer remains serialized by it.

The security lane additionally requires current effective GitHub principals and active branch/tag rules to prove the trusted-main boundary before merge. Current evidence shows one organization owner/direct admin/`infra` maintainer (`Rickebo`), five strict required checks, no rule bypass actors, and immutable `v*` tags; this evidence must be refreshed immediately before merge and extended to GitHub App permissions.

The final head requires independent Luna review, fresh protected CI, and exact-head squash merge. Recovery must remain workflow-driven: preserve unpublished immutable `v0.14.0`, obtain and verify the exact signed two-file terminal-failure proof from a failed publisher, then publish only the next immutable version under the unchanged size cap. Deployment and live authorization activation are excluded.
