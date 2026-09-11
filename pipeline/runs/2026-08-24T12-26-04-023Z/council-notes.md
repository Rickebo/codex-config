# QA Council Notes: Automatic Release Recovery

Run: `2026-08-24T12-26-04-023Z`  
Task: explicit verifier-to-publisher dispatch and automatic recovery of an
unpublished `v0.6.13`.

## Contract snapshot

Reviewed repository contract: `ad52dfcbc45d71eccad1d49fbd905161af7a44b1`
(`v0.6.13`, descendant of Kafka fix `989799cc99a4e9577bfd100dde320a71f7e7fb9f`).

Already covered by the current tests:

- `Automatic Release` is a serialized `workflow_run` coordinator for successful
  `CI` on `main`; it uses create-only tag refs and explicit
  `createWorkflowDispatch` for `Release Verify`.
- `Release Verify` accepts only the dispatch identity and validates the
  coordinator run, authenticated `Automatic Release` check, successful exact
  CI run, tag target, and protected history.
- `Publish Release` accepts only a successful `Release Verify` with
  `workflow_dispatch` provenance. Artifact downloads bind to the verifier run
  ID, run attempt, and source SHA.
- Planner unit tests cover SemVer priority, non-releasable ranges, same-source
  tag/release idempotence, serialized new candidates, and malformed tags/SHA.

## Required deterministic scenarios

Use A for the first candidate source, B for a later `main` descendant, C for a
coordinator rerun, and `CI(A, attempt)` for the exact successful CI identity.

| ID | Setup | Expected result |
| --- | --- | --- |
| QA-01 | `v0.6.12` base; releasable commits through A; no `v0.6.13` state | Plan exactly `v0.6.13` at A; patch wins over non-releasable commits; no `v0.6.14`. |
| QA-02 | Existing immutable `v0.6.13` tag at A, no public release; B is a descendant follow-up | Plan `resume`, retain tag/source A, recover `CI(A, attempt)`, and do not allocate `v0.6.14`. This is the key recovery gate. |
| QA-03 | Existing `v0.6.13` draft at A; rerun C | Reuse the exact tag/draft; no `createRef`, tag move, duplicate shell, or second release candidate. |
| QA-04 | Existing public `v0.6.13` at A; repeated C | No-op; never overwrite or recreate the release. |
| QA-05 | Two successful CI candidates acquire the coordinator lock | Candidates are serialized; each rereads immutable state and cannot select the same new version. |
| QA-06 | Dispatch input has wrong tag/ref/source, CI ID/attempt, coordinator ID/attempt, check ID, check external ID, or manual/`push` identity | Verifier/publisher fail closed before artifact publication. |
| QA-07 | Verifier first attempt fails, then verifier rerun succeeds | Publisher consumes the exact verifier run attempt that completed successfully; no stale artifact attempt is mixed in. |
| QA-08 | Successful verifier dispatch creates a tag with the default token | Only the explicit `workflow_dispatch` verifier run and its `workflow_run` publisher appear; no tag-push recursion run is used. |

For QA-02, planner output must carry the original source A and its exact CI
run identity. A current-source B CI run cannot be substituted: the verifier's
`head_sha`, artifact transport, and provenance must remain bound to A.

## Current finding / code gate

The current `hack/release-plan.py` state does not satisfy QA-02. In a temporary
repository with `v0.6.12` at base, `v0.6.13` at A, and a `chore` follow-up B,
`plan_git(B, state)` returns `no-release`. With a `fix` follow-up B it returns
`create v0.6.14`. `CandidateState` contains only tags/releases, so there is no
pending-candidate source or exact CI(A) lookup to resume.

The implementation must first prioritize an unpublished immutable candidate
reachable from B, retain its tag target A, and resolve the successful CI run
for A (including run attempt). Only after that candidate is published may a
later releasable B change become a new SemVer candidate.

## Live acceptance gates

1. Record A, successful `CI(A, attempt)`, and the existing `v0.6.13` tag target.
2. Induce or observe a failed verifier/publisher attempt without deleting or
   moving the tag or draft shell.
3. Merge follow-up B and wait for successful exact `CI(B, attempt)`.
4. Confirm the coordinator resumes `v0.6.13` at A using `CI(A, attempt)`;
   confirm no `v0.6.14` tag or release exists.
5. Confirm `Release Verify` has event `workflow_dispatch`, tag ref
   `refs/tags/v0.6.13`, source A, and the authenticated coordinator check.
6. Confirm `Publish Release` is triggered only by that successful verifier
   `workflow_run`, downloads the matching verifier run attempt, and publishes
   exactly one immutable release shell.
7. Verify the public manifest and all signed bundles preserve source A,
   verifier/publisher run IDs and attempts, `workflow_dispatch` identity,
   chart OCI digest, image-index digest, and artifact checksums.
8. Inspect Actions history for absence of a tag-push Release Verify run, then
   rerun the coordinator/publisher path and confirm idempotent no-op/resume
   behavior. Clean the merged branch/worktree after proof.

## Local evidence commands

```bash
python3 hack/test-release-plan.py
node hack/test-release-coordinator-policy.js
python3 hack/test-release-graph.py
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
```

Live evidence must additionally capture the Automatic Release, Release Verify,
and Publish Release URLs; exact tag/source and run-attempt JSON; release
manifest; and OCI/chart digest comparisons. No live GitHub mutation was
performed while preparing this council note.
