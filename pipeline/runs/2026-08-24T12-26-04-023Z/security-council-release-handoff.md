# Security-council specification: automatic release handoff

Status: design artifact only; no repository implementation changes made.

Run: `2026-08-24T12-26-04-023Z`

Repository revision reviewed: `ad52dfcbc45d71eccad1d49fbd905161af7a44b1`

## Scope and current constraint

The coordinator already creates a tag with a create-only GitHub ref call and
explicitly dispatches `Release Verify`. `Publish Release` still listens only
for `workflow_run` from `Release Verify` (`.github/workflows/publish-release.yaml`),
while the verifier currently uploads its artifacts and ends. A default-token
tag push must not be treated as a recursive workflow trigger.

The repair must use an explicit, authenticated verifier-to-publisher dispatch,
retain the verified artifact/provenance stages, and resume an existing
unpublished candidate without moving its immutable tag or allocating a newer
version.

## Trust boundary and permissions

1. **PR/CI code is untrusted for release mutation.** CI, pull-request jobs,
   and the verifier's artifact-building steps receive no `contents: write`,
   `actions: write`, `checks: write`, `packages: write`, or release/tag
   credential. They may retain read access and verifier OIDC signing only.

2. **Automatic Release coordinator is the sole tag allocator.** Its ordinary
   workflow permission is read-only. Its one API-only coordinator job gets
   exactly `contents: write`, `actions: write`, and `checks: write` to validate
   the successful same-repository `CI` push on `main`, create a missing
   `refs/tags/vX.Y.Z` ref once, create the coordinator check, and dispatch
   `Release Verify`. It must checkout only trusted coordinator policy from
   the protected default branch and must never update or delete a ref.

3. **Release Verify is split into read-only verification and a handoff job.**
   The verification job keeps `contents: read`, `actions: read`,
   `checks: read`, and `id-token: write`; it may execute the verified release
   checks and upload artifacts, but cannot dispatch or publish. A separate
   `dispatch-publish` job runs only after verification succeeds and receives
   `actions: write`, `checks: write`, and `contents: read`. That job must be
   API-only (`actions/github-script`), with no repository checkout, shell
   command, artifact download, or candidate-source code execution.

4. **Publish Release is the only publisher.** Its release job alone receives
   `contents: write`, `packages: write`, and `id-token: write`; it retains
   read-only permissions for all other scopes. No PR workflow or source-code
   step may inherit these write permissions.

## Protected-main publisher revision

To preserve the existing publisher provenance contract, dispatch
`Publish Release` at `refs/heads/main`, not at the candidate tag. Immediately
before dispatch, the API-only handoff job reads the protected default-branch
ref and passes its exact SHA as `publisher_revision`.

The publisher must fail closed unless all of the following are true:

- the event is `workflow_dispatch`;
- the actual publisher ref is exactly `refs/heads/main`;
- `github.sha` equals the supplied `publisher_revision`;
- the remote `heads/main` still resolves to that same SHA (a race causes a
  safe failure and a retry, never execution against an unreviewed revision);
- the publisher workflow path is exactly
  `.github/workflows/publish-release.yaml` and the repository is the expected
  same repository; and
- provenance records `refs/heads/main`, that exact publisher SHA, and the
  `workflow_dispatch` trigger separately from the candidate tag/source SHA.

The candidate source remains an immutable `refs/tags/<tag>` checkout used only
as release data. The publisher code must be checked out at `github.sha` with
persisted credentials disabled. Do not use the candidate checkout to supply
privileged publisher helpers.

## Exact handoff identity

The handoff has required inputs for:

`tag`, `source_revision`, `ci_run_id`, `ci_run_attempt`,
`coordinator_run_id`, `coordinator_run_attempt`, `coordinator_check_run_id`,
`release_verify_run_id`, `release_verify_run_attempt`,
`release_verify_check_run_id`, and `publisher_revision`.

All IDs must be positive safe integers; all revisions must be lowercase
40-hex SHAs; `tag` must be a stable SemVer tag. The coordinator external ID
remains canonical and create-only:

```text
automatic-release:<coordinator-run>/<attempt>:<tag>:<source-sha>:<ci-run>/<attempt>
```

After every verifier step succeeds, the handoff job creates exactly one
`Release Verify` check on `source_revision` with `status=completed`,
`conclusion=success`, GitHub Actions app identity, and this external ID:

```text
release-verify:<verify-run>/<attempt>:<tag>:<source-sha>:<ci-run>/<attempt>:<coordinator-run>/<attempt>:<coordinator-check>:<publisher-sha>
```

The check's `head_sha` must equal `source_revision`; its details URL should
identify the exact verifier run. A rerun has a new run attempt and therefore a
new external ID. Duplicate successful checks for the same external ID are a
hard failure, not a selection opportunity.

The handoff job dispatches `Publish Release` with `workflow_id:
publish-release.yaml`, `ref: main`, and all of the inputs above. A manually
submitted publisher dispatch cannot invent a valid handoff: the publisher
must fetch and validate the exact verifier run, verifier check, CI run,
coordinator run, and coordinator check through the GitHub API. A replay of an
authentic handoff is safe only because the tag/release path is create-only and
the publisher is serialized and idempotent.

## Publisher validation order

Before downloading artifacts or performing any privileged operation, Publish
Release must validate, in order:

1. its own event/ref/SHA/repository/workflow identity and `publisher_revision`;
2. the verifier workflow run ID and attempt: exact name/path,
   `workflow_dispatch`, same repository, stable tag branch, source SHA, and
   successful conclusion;
3. the verifier check ID: exact name/app/status/conclusion/head SHA and the
   canonical external ID above;
4. the coordinator run/check and CI run/attempt identities, including exact
   successful `CI` push on `main` and exact source SHA;
5. the tag target, requiring the tag to resolve exactly to `source_revision`
   and that source to be in protected default-branch history; and
6. the existing release shell, rejecting duplicates, target mismatches,
   mutable tags, and incomplete public releases.

Any failure terminates before artifact download, registry login, tag/release
mutation, or package publication.

## Artifact and provenance binding

- Release Verify uploads image/chart artifacts under its own exact run ID,
  attempt, and `source_revision`.
- Publish Release downloads using `release_verify_run_id` and
  `release_verify_run_attempt`, never its own run identity or an untrusted
  event payload field.
- Existing exact file-set, checksum, Cosign identity, source-ref, source-SHA,
  and `workflow_dispatch` verification remains mandatory.
- Publisher provenance binds the publisher workflow to
  `.github/workflows/publish-release.yaml@refs/heads/main`,
  `publisher_revision`, the publisher run/attempt, and the upstream verifier
  run/attempt. The public manifest separately binds the candidate tag/source
  and publisher revision; neither may substitute for the other.
- The release graph, image index, chart digest, all SBOM/provenance bundles,
  durable publisher-subject manifest, and final 14-asset set remain generated
  and validated by the existing stages. A successful existing public release
  with the exact target and complete asset set is a strict no-op.

The provenance helper and static tests must be updated from the current
publisher `workflow_run` assumption to normal publisher `workflow_dispatch`
with protected-main ref/SHA. The recovery workflow's historical publisher
identity remains a separate legacy contract.

## Candidate resumption and SemVer safety

`hack/release-plan.py:plan_git` currently recognizes an existing candidate only
when its tag target equals the current CI source. Thus a follow-up merge can
see an unpublished `v0.6.13` ancestor and incorrectly plan `v0.6.14`.

The planner must first inspect existing stable tags that are ancestors of the
current protected-main source. If the highest candidate has an exact draft
release (or exact tag with no release shell), resume that immutable tag and
its original target SHA. The coordinator must find a successful `CI` run for
that exact target (or fail closed); the current follow-up CI run cannot be
substituted for it. Dispatch Verify/Publish with the candidate target and its
exact CI identity. Never move the old tag or fold follow-up commits into the
old release. Later releasable commits may allocate the next version only
after the old candidate is public.

## Failure, retry, and legacy semantics

- Ref creation, release-shell creation, asset creation, and release
  publication are create-only. No retry may overwrite, move, delete, or
  recreate an existing tag, release, or asset.
- A duplicate dispatch, lost API response, or rerun is acceptable; the
  non-canceling per-tag concurrency group and exact public-release no-op make
  the result idempotent. Draft shells may resume only when tag and target are
  exact; mismatches and duplicate shells fail closed.
- If the handoff check exists but dispatch status is uncertain, a retry may
  reuse that exact check identity. It must not create a second check with the
  same external ID or allocate a new version.
- Normal automatic release accepts only the explicit verifier handoff. No
  tag-push or `workflow_run` recursion fallback may be enabled.
- `--allow-legacy-release-push` is permitted only in the dedicated historical
  recovery workflow, for its pinned release/tag/source/run and explicit
  operator-selected recovery inputs. It must remain absent from normal
  Publish Release. Legacy push provenance cannot authorize a new automatic
  release or bypass the exact publisher/verifier checks.

## Required focused tests

1. Handoff policy tests accept only the canonical coordinator/verifier
   external IDs and exact run/check/source/tag/CI/publisher identities; reject
   wrong app, repository, event, path, branch, attempt, SHA, check status, and
   duplicate IDs.
2. Workflow policy tests prove read-only verifier/source jobs, isolated
   API-only handoff permissions, publisher-only tag/package write permissions,
   explicit `workflow_dispatch`, protected-main ref/SHA checks, and no
   `workflow_run` or tag-recursion dependency in the normal publisher path.
3. Artifact tests prove downloads use the verifier run ID/attempt and that
   source/provenance/checksum/attestation claims remain exact.
4. Planner tests cover an unpublished ancestor `v0.6.13` followed by a
   releasable merge, exact CI lookup for the old target, mismatched/dangling
   tags, concurrent candidates, public-release no-op, and non-releasable-only
   commits.
5. Rerun tests cover a lost dispatch response, duplicate handoff attempt,
   exact draft resume, exact public no-op, and all tag/release immutability
   failures.

## Evidence and limitations

Local focused tests at the reviewed revision passed:

- `python3 hack/test-release-plan.py` (10 tests)
- `node hack/test-release-coordinator-policy.js`
- `python3 hack/test-release-graph.py` (43 tests)

The live `gh` API query timed out in this lane, so current remote workflow-run
and release status is not asserted here. No repository implementation files,
tags, releases, or workflow runs were mutated.
