import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const runDir = "/home/rickebo/.codex/pipeline/runs/2026-08-24T16-21-43-985Z";
const fixtureDir = path.join(runDir, "fixtures-v1.9");
fs.mkdirSync(fixtureDir, { recursive: true });

const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
const writeJson = (name, value) => fs.writeFileSync(path.join(fixtureDir, name), jsonBytes(value));
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fileRecord = (name) => {
  const bytes = fs.readFileSync(path.join(fixtureDir, name));
  return { path: `fixtures-v1.9/${name}`, byte_length: bytes.length, sha256: sha256(bytes) };
};
const jcs = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`).join(",")}}`;
};
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

const positiveDecimal = { type: "string", pattern: "^[1-9][0-9]*$" };
const sha40 = { type: "string", pattern: "^[0-9a-f]{40}$" };
const sha64 = { type: "string", pattern: "^[0-9a-f]{64}$" };
const hex32 = { type: "string", pattern: "^[0-9a-f]{32}$" };
const rfc3339 = { type: "string", pattern: "^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$" };
const base64url = { type: "string", pattern: "^[A-Za-z0-9_-]+$" };
const compactJws = { type: "string", pattern: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$" };
const closed = (required, properties, extra = {}) => ({ type: "object", required, properties, additionalProperties: false, ...extra });
const runIdentity = closed(
  ["run_id", "run_attempt", "workflow_path", "workflow_sha"],
  { run_id: positiveDecimal, run_attempt: positiveDecimal, workflow_path: { type: "string", minLength: 1 }, workflow_sha: sha40 }
);

const baselines = {
  "codicarium/deployment-controller": "d3565f534b2f64585c3e15e35d8d645449f4f09d",
  "codicarium/codicarium-actions": "9545b5a66498f67667e57d021507ac060fd016b6",
  "codicarium/runner-config": "9625e442a12c721e89250812f3d079b09833ccb0",
  "codicarium/vault-config": "2ddfb54f75cfdbf21529433e105880bec5fc1b1e",
  "codicarium/app-config": "e085a399bedc830b537431e3bcd5e41b677c2812",
  "codicarium/infra": "40073c068a9cf8ff4c1e625b97e09fda31b40637"
};

const workflowContract = {
  schema: "codicarium.issue93-workflow-permissions/v1",
  top_level_default: {},
  workflows: {
    ".github/workflows/automatic-release-v2.yaml": {
      name: "Automatic Release v2",
      jobs: {
        plan: { contents: "read", actions: "read", checks: "read" },
        "tag-reserve": { contents: "write" },
        "tag-receipt": { contents: "read", checks: "write" },
        "verifier-dispatch": { contents: "read", actions: "write" },
        "verifier-observe": { contents: "read", actions: "read", checks: "read" },
        "handoff-and-claim": { contents: "read", actions: "read", checks: "write" },
        "publisher-dispatch": { contents: "read", actions: "write", checks: "read" },
        "publisher-receipt-sign": { contents: "read", actions: "read", checks: "read", "id-token": "write" },
        "publisher-receipt": { contents: "read", actions: "read", checks: "write" }
      }
    },
    ".github/workflows/release-verify-v2.yaml": {
      name: "Release Verify v2",
      jobs: {
        preflight: { contents: "read", actions: "read", checks: "read" },
        prefetch: { contents: "read" },
        "candidate-capability-mint": { contents: "read", "id-token": "write" },
        candidate: {},
        "attester-capability-mint": { contents: "read", "id-token": "write" },
        attester: { contents: "read", actions: "read", checks: "read", "id-token": "write" }
      }
    },
    ".github/workflows/publish-release-v2.yaml": {
      name: "Publish Release v2",
      jobs: {
        admission: { contents: "read", actions: "read", checks: "read" },
        "artifact-capability-mint": { contents: "read", "id-token": "write" },
        "registry-credential-mint": { contents: "read", "id-token": "write" }
      },
      static_expansion: "The generated exact job map contains eighteen serial writer -> receipt-sign -> receipt-write triplets: draft release, image, chart, fourteen assets, and final release. No matrix, parallel publication, or generic loop may replace this fixed chain."
    },
    ".github/workflows/ci.yaml": {
      name: "CI",
      top_level_permissions: { contents: "read" },
      jobs: { test: {}, lint: {}, chart: {}, integration: {}, "supply-chain": {} }
    },
    ".github/workflows/recover-release-v068.yaml": {
      name: "Recover v0.6.8 Publisher Evidence",
      temporary_until_pr_99: true,
      jobs: { recover: { actions: "read", contents: "write", "id-token": "write" } }
    },
    ".github/workflows/recover-release-attestations.yaml": {
      name: "Recover Release Attestations",
      jobs: {
        inspect: { contents: "read", actions: "read" },
        sign: { contents: "read", actions: "read", "id-token": "write" }
      }
    }
  },
  invariants: [
    "Every workflow not carrying an explicit top_level_permissions object has top-level permissions {}.",
    "Unspecified scopes are none.",
    "No job combines id-token:write with actions:write or checks:write.",
    "The candidate job receives no GITHUB_TOKEN and no data-plane credential.",
    "Publisher mutation writers have neither actions:write nor checks:write; receipt writers have no contents:write, packages:write, registry write credential, or id-token:write."
  ]
};

const tokenHeaderSchema = closed(
  ["alg", "kid", "typ"],
  {
    alg: { const: "EdDSA" },
    kid: base64url,
    typ: { const: "codicarium-artifact-capability+jwt" }
  }
);

const tokenClaimsSchema = closed(
  [
    "iss", "aud", "sub", "iat", "nbf", "exp", "jti", "capability_version", "operation", "purpose",
    "object_key", "nonce", "content_type", "max_compressed_bytes", "max_uncompressed_bytes", "owner_id",
    "repository_id", "mint_run_id", "mint_run_attempt", "subject_run_id", "subject_run_attempt", "tag", "source_revision"
  ],
  {
    iss: { const: "https://artifact-capability.artifact-capability.svc.cluster.local:8443" },
    aud: { const: "codicarium-artifact-capability-api" },
    sub: { type: "string", minLength: 1 },
    iat: { type: "integer", minimum: 1 },
    nbf: { type: "integer", minimum: 1 },
    exp: { type: "integer", minimum: 1 },
    jti: hex32,
    capability_version: { const: "1" },
    operation: { enum: ["create", "read", "readback"] },
    purpose: { enum: ["deployment-controller-verified-image", "deployment-controller-verified-chart", "deployment-controller-signed-authorization"] },
    object_key: { type: "string", pattern: "^artifacts/v1/orgs/255540067/repos/1303901324/releases/v0\\.6\\.14/sources/[0-9a-f]{40}/runs/[1-9][0-9]*/attempts/[1-9][0-9]*/(deployment-controller-verified-image|deployment-controller-verified-chart|deployment-controller-signed-authorization)/[0-9a-f]{32}\\.tar\\.zst$" },
    nonce: hex32,
    content_type: { const: "application/zstd" },
    max_compressed_bytes: positiveDecimal,
    max_uncompressed_bytes: positiveDecimal,
    owner_id: { const: "255540067" },
    repository_id: { const: "1303901324" },
    mint_run_id: positiveDecimal,
    mint_run_attempt: positiveDecimal,
    subject_run_id: positiveDecimal,
    subject_run_attempt: positiveDecimal,
    tag: { const: "v0.6.14" },
    source_revision: sha40,
    archive_sha256: sha64,
    byte_length: positiveDecimal
  },
  {
    allOf: [
      {
        if: { properties: { operation: { const: "create" } }, required: ["operation"] },
        then: { not: { anyOf: [{ required: ["archive_sha256"] }, { required: ["byte_length"] }] } },
        else: { required: ["archive_sha256", "byte_length"] }
      }
    ]
  }
);

const artifactCapabilitySchemas = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.codicarium.com/artifact-capability/api-v1.schema.json",
  title: "Codicarium Artifact Capability API v1 schema bundle",
  "$defs": {
    token_header: tokenHeaderSchema,
    token_claims: tokenClaimsSchema,
    mint_request: closed(
      ["schema", "operation", "purpose", "subject_run_id", "subject_run_attempt", "tag", "source_revision"],
      {
        schema: { const: "codicarium.artifact-capability-mint/v1" },
        operation: { enum: ["create", "read", "readback"] },
        purpose: { enum: ["deployment-controller-verified-image", "deployment-controller-verified-chart", "deployment-controller-signed-authorization"] },
        subject_run_id: positiveDecimal,
        subject_run_attempt: positiveDecimal,
        tag: { const: "v0.6.14" },
        source_revision: sha40,
        expected_archive_sha256: sha64,
        expected_byte_length: positiveDecimal
      },
      {
        allOf: [
          {
            if: { properties: { operation: { const: "create" } }, required: ["operation"] },
            then: { not: { anyOf: [{ required: ["expected_archive_sha256"] }, { required: ["expected_byte_length"] }] } },
            else: { required: ["expected_archive_sha256", "expected_byte_length"] }
          }
        ]
      }
    ),
    mint_response: closed(
      ["schema", "access_token", "token_type", "operation", "purpose", "object_key", "nonce", "jti", "expires_at", "max_compressed_bytes", "max_uncompressed_bytes"],
      {
        schema: { const: "codicarium.artifact-capability/v1" }, access_token: compactJws, token_type: { const: "Bearer" },
        operation: { enum: ["create", "read", "readback"] }, purpose: { type: "string", minLength: 1 }, object_key: { type: "string", minLength: 1 },
        nonce: hex32, jti: hex32, expires_at: rfc3339, max_compressed_bytes: positiveDecimal, max_uncompressed_bytes: positiveDecimal
      }
    ),
    upload_response: closed(
      ["schema", "object_key", "archive_sha256", "byte_length", "nonce", "created_at", "verified_at", "expires_at"],
      { schema: { const: "codicarium.artifact-create-receipt/v1" }, object_key: { type: "string", minLength: 1 }, archive_sha256: sha64, byte_length: positiveDecimal, nonce: hex32, created_at: rfc3339, verified_at: rfc3339, expires_at: rfc3339 }
    ),
    readback_response: closed(
      ["schema", "object_key", "archive_sha256", "byte_length", "verified_at"],
      { schema: { const: "codicarium.artifact-readback/v1" }, object_key: { type: "string", minLength: 1 }, archive_sha256: sha64, byte_length: positiveDecimal, verified_at: rfc3339 }
    )
  }
};

const fileEntry = (name) => closed(["path", "size", "sha256"], { path: { const: name }, size: positiveDecimal, sha256: sha64 });
const archiveEntry = (purpose, fileNames) => closed(
  ["object_key", "archive_sha256", "byte_length", "capability_nonce", "capability_expires_at", "files"],
  {
    object_key: { type: "string", pattern: `^artifacts/v1/orgs/255540067/repos/1303901324/releases/v0\\.6\\.14/sources/[0-9a-f]{40}/runs/[1-9][0-9]*/attempts/[1-9][0-9]*/${purpose}/[0-9a-f]{32}\\.tar\\.zst$` },
    archive_sha256: sha64,
    byte_length: positiveDecimal,
    capability_nonce: hex32,
    capability_expires_at: rfc3339,
    files: { type: "array", prefixItems: fileNames.map(fileEntry), items: false, minItems: fileNames.length, maxItems: fileNames.length }
  }
);

const candidateEvidenceSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.codicarium.com/release/candidate-evidence-v1.schema.json",
  title: "Codicarium release candidate evidence v1",
  ...closed(
    ["schema", "repository", "tag", "source_revision", "ci", "verifier", "archives"],
    {
      schema: { const: "codicarium.release-candidate-evidence/v1" },
      repository: { const: "codicarium/deployment-controller" },
      tag: { const: "v0.6.14" },
      source_revision: sha40,
      ci: closed(["run_id", "run_attempt"], { run_id: positiveDecimal, run_attempt: positiveDecimal }),
      verifier: closed(["run_id", "run_attempt"], { run_id: positiveDecimal, run_attempt: positiveDecimal }),
      archives: closed(
        ["deployment-controller-verified-image", "deployment-controller-verified-chart"],
        {
          "deployment-controller-verified-image": archiveEntry("deployment-controller-verified-image", ["deployment-controller-linux-amd64.spdx.json", "deployment-controller-linux-arm64.spdx.json", "deployment-controller.env", "deployment-controller.oci.tar"]),
          "deployment-controller-verified-chart": archiveEntry("deployment-controller-verified-chart", ["deployment-controller-0.6.14.tgz", "deployment-controller-chart.sha256"])
        }
      )
    },
    { unevaluatedProperties: false }
  )
};

const receiptIssuer = closed(
  ["kind", "repository_id", "workflow", "ref", "workflow_sha", "run_id", "run_attempt"],
  {
    kind: { const: "github-actions" }, repository_id: { const: "1303901324" }, workflow: { type: "string", minLength: 1 }, ref: { const: "refs/heads/main" }, workflow_sha: sha40, run_id: positiveDecimal, run_attempt: positiveDecimal
  }
);
const signedReceiptEnvelope = (bodySchema) => closed(
  ["body", "signature"],
  {
    body: bodySchema,
    signature: closed(["format", "kid", "payload_sha256", "signature_base64url"], { format: { const: "ed25519-jcs/v1" }, kid: base64url, payload_sha256: sha64, signature_base64url: base64url })
  }
);

const dispatchReceiptBody = closed(
  ["schema", "kind", "repository", "tag", "source_revision", "authorization_sha256", "handoff_sha256", "dispatch_request_sha256", "claim_check_run_id", "coordinator_run_id", "coordinator_run_attempt", "publisher_workflow", "publisher_ref", "publisher_revision", "publisher_workflow_sha", "publisher_run_id", "publisher_run_attempt", "issued_at", "issuer"],
  {
    schema: { const: "codicarium.publisher-dispatch-receipt/v1" }, kind: { const: "publisher-dispatch-receipt" }, repository: { const: "codicarium/deployment-controller" }, tag: { const: "v0.6.14" }, source_revision: sha40,
    authorization_sha256: sha64, handoff_sha256: sha64, dispatch_request_sha256: sha64, claim_check_run_id: positiveDecimal,
    coordinator_run_id: positiveDecimal, coordinator_run_attempt: positiveDecimal,
    publisher_workflow: { const: "codicarium/deployment-controller/.github/workflows/publish-release-v2.yaml" }, publisher_ref: { const: "refs/heads/main" }, publisher_revision: sha40, publisher_workflow_sha: sha40,
    publisher_run_id: positiveDecimal, publisher_run_attempt: positiveDecimal, issued_at: rfc3339, issuer: receiptIssuer
  }
);
const dispatchReceiptSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.codicarium.com/release/publisher-dispatch-receipt-v1.schema.json",
  title: "Codicarium publisher dispatch receipt v1",
  ...signedReceiptEnvelope(dispatchReceiptBody)
};

const mutationTargets = {
  "release-create": closed(["release_id", "tag", "target_commitish", "draft", "prerelease"], { release_id: positiveDecimal, tag: { const: "v0.6.14" }, target_commitish: sha40, draft: { const: true }, prerelease: { const: false } }),
  "release-asset-create": closed(["release_id", "asset_id", "name", "size", "sha256"], { release_id: positiveDecimal, asset_id: positiveDecimal, name: { type: "string", minLength: 1 }, size: positiveDecimal, sha256: sha64 }),
  "image-publish": closed(["registry", "repository", "reference", "digest"], { registry: { const: "docker-push.nexus.int.codicarium.com" }, repository: { const: "codicarium/deployment-controller" }, reference: { const: "v0.6.14" }, digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" } }),
  "chart-publish": closed(["registry", "repository", "version", "digest"], { registry: { const: "charts.nexus.int.codicarium.com" }, repository: { const: "codicarium/deployment-controller" }, version: { const: "0.6.14" }, digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" } }),
  "release-finalize": closed(["release_id", "tag", "target_commitish", "draft", "prerelease"], { release_id: positiveDecimal, tag: { const: "v0.6.14" }, target_commitish: sha40, draft: { const: false }, prerelease: { const: false } })
};
const mutationReceiptBody = closed(
  ["schema", "kind", "dispatch_receipt_sha256", "sequence", "previous_receipt_sha256", "mutation", "request_sha256", "readback_sha256", "publisher_ref", "publisher_revision", "publisher_run_id", "publisher_run_attempt", "issued_at", "issuer", "target"],
  {
    schema: { const: "codicarium.publisher-mutation-receipt/v1" }, kind: { const: "publisher-mutation-receipt" }, dispatch_receipt_sha256: sha64, sequence: positiveDecimal, previous_receipt_sha256: sha64,
    mutation: { enum: Object.keys(mutationTargets) }, request_sha256: sha64, readback_sha256: sha64, publisher_ref: { const: "refs/heads/main" }, publisher_revision: sha40,
    publisher_run_id: positiveDecimal, publisher_run_attempt: positiveDecimal, issued_at: rfc3339, issuer: receiptIssuer, target: { oneOf: Object.values(mutationTargets) }
  },
  {
    allOf: Object.entries(mutationTargets).map(([mutation, target]) => ({ if: { properties: { mutation: { const: mutation } }, required: ["mutation"] }, then: { properties: { target } } }))
  }
);
const mutationReceiptSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.codicarium.com/release/publisher-mutation-receipt-v1.schema.json",
  title: "Codicarium publisher mutation receipt v1",
  ...signedReceiptEnvelope(mutationReceiptBody)
};

const assetNames = [
  "deployment-controller-0.6.14.tgz",
  "deployment-controller-0.6.14.tgz.sigstore.json",
  "deployment-controller-chart-oci-provenance.sigstore.json",
  "deployment-controller-chart.sha256",
  "deployment-controller-chart.sha256.sigstore.json",
  "deployment-controller-image-provenance.sigstore.json",
  "deployment-controller-linux-amd64-sbom.sigstore.json",
  "deployment-controller-linux-arm64-sbom.sigstore.json",
  "deployment-controller-release-graph.json",
  "deployment-controller-release-graph.json.sigstore.json",
  "deployment-controller-release-manifest.json",
  "deployment-controller-release-manifest.json.sigstore.json",
  "deployment-controller-publisher-subject-manifest.json",
  "deployment-controller-publisher-subject-manifest.json.sigstore.json"
];
const publisherJobs = workflowContract.workflows[".github/workflows/publish-release-v2.yaml"].jobs;
const addPublisherTriplet = (sequence, slug, writerPermissions) => {
  const number = String(sequence).padStart(2, "0");
  publisherJobs[`${number}-${slug}-write`] = writerPermissions;
  publisherJobs[`${number}-${slug}-receipt-sign`] = { contents: "read", actions: "read", checks: "read", "id-token": "write" };
  publisherJobs[`${number}-${slug}-receipt-write`] = { contents: "read", actions: "read", checks: "write" };
};
addPublisherTriplet(1, "release-create", { contents: "write", actions: "read", checks: "read" });
addPublisherTriplet(2, "image-publish", { contents: "read", actions: "read", checks: "read" });
addPublisherTriplet(3, "chart-publish", { contents: "read", actions: "read", checks: "read" });
assetNames.forEach((_, index) => addPublisherTriplet(index + 4, `asset-${String(index + 1).padStart(2, "0")}-create`, { contents: "write", actions: "read", checks: "read" }));
addPublisherTriplet(18, "release-finalize", { contents: "write", actions: "read", checks: "read" });
const protectedChecks = ["chart", "integration", "lint", "supply-chain", "test"];
const checkEvidence = (name) => closed(
  ["name", "app_id", "run_id", "attempt", "check_id", "head_sha", "status", "conclusion"],
  { name: { const: name }, app_id: { const: "15368" }, run_id: positiveDecimal, attempt: positiveDecimal, check_id: positiveDecimal, head_sha: sha40, status: { const: "completed" }, conclusion: { const: "success" } }
);
const releaseActor = closed(
  ["run_id", "attempt", "workflow_path", "workflow_sha", "check_id"],
  { run_id: positiveDecimal, attempt: positiveDecimal, workflow_path: { type: "string", minLength: 1 }, workflow_sha: sha40, check_id: positiveDecimal }
);
const objectEvidence = closed(["object_key", "archive_sha256", "byte_length", "nonce"], { object_key: { type: "string", minLength: 1 }, archive_sha256: sha64, byte_length: positiveDecimal, nonce: hex32 });
const liveEvidenceSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.codicarium.com/release/live-evidence-v1.schema.json",
  title: "Codicarium release live evidence v1",
  ...closed(
    ["schema", "captured_at", "repository", "corrective_pr", "protected_main_sha", "protected_checks", "release_identity", "coordinator", "verifier", "attester", "claim", "receipt", "publisher", "candidate_evidence", "authorization", "handoff", "dispatch", "release", "registries", "assets", "mutation_receipts", "retirement"],
    {
      schema: { const: "codicarium.release-live-evidence/v1" }, captured_at: rfc3339,
      repository: closed(["full_name", "id"], { full_name: { const: "codicarium/deployment-controller" }, id: { const: "1303901324" } }),
      corrective_pr: closed(["number", "head_sha", "merge_sha"], { number: positiveDecimal, head_sha: sha40, merge_sha: sha40 }), protected_main_sha: sha40,
      protected_checks: { type: "array", prefixItems: protectedChecks.map(checkEvidence), items: false, minItems: 5, maxItems: 5 },
      release_identity: closed(["tag", "source_sha"], { tag: { const: "v0.6.14" }, source_sha: sha40 }),
      coordinator: releaseActor, verifier: releaseActor, attester: releaseActor, claim: releaseActor, receipt: releaseActor, publisher: releaseActor,
      candidate_evidence: closed(["evidence_sha256", "image", "chart"], { evidence_sha256: sha64, image: objectEvidence, chart: objectEvidence }),
      authorization: closed(["object_key", "archive_sha256", "predicate_sha256", "byte_length", "nonce"], { object_key: { type: "string", minLength: 1 }, archive_sha256: sha64, predicate_sha256: sha64, byte_length: positiveDecimal, nonce: hex32 }),
      handoff: closed(["check_id", "external_id", "sha256", "digest_base64url", "tuple_base64url"], { check_id: positiveDecimal, external_id: { type: "string", pattern: "^codicarium\\.release-handoff/v1:[0-9a-f]{64}$" }, sha256: sha64, digest_base64url: base64url, tuple_base64url: base64url }),
      dispatch: closed(["claim_check_id", "receipt_check_id", "external_id", "sha256", "digest_base64url", "tuple_base64url"], { claim_check_id: positiveDecimal, receipt_check_id: positiveDecimal, external_id: { type: "string", pattern: "^codicarium\\.publisher-receipt/v1:[0-9a-f]{64}$" }, sha256: sha64, digest_base64url: base64url, tuple_base64url: base64url }),
      release: closed(["id", "tag", "target", "draft", "prerelease"], { id: positiveDecimal, tag: { const: "v0.6.14" }, target: sha40, draft: { const: false }, prerelease: { const: false } }),
      registries: closed(["image", "chart"], {
        image: closed(["registry", "repository", "reference", "digest"], { registry: { const: "docker-pull.nexus.int.codicarium.com" }, repository: { const: "codicarium/deployment-controller" }, reference: { const: "v0.6.14" }, digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" } }),
        chart: closed(["registry", "repository", "version", "digest"], { registry: { const: "charts.nexus.int.codicarium.com" }, repository: { const: "codicarium/deployment-controller" }, version: { const: "0.6.14" }, digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" } })
      }),
      assets: { type: "array", prefixItems: assetNames.map((name) => closed(["id", "name", "size", "sha256"], { id: positiveDecimal, name: { const: name }, size: positiveDecimal, sha256: sha64 })), items: false, minItems: 14, maxItems: 14 },
      mutation_receipts: { type: "array", minItems: 18, maxItems: 18, items: closed(["sequence", "mutation", "check_id", "external_id", "sha256", "previous_receipt_sha256"], { sequence: positiveDecimal, mutation: { enum: Object.keys(mutationTargets) }, check_id: positiveDecimal, external_id: { type: "string", pattern: "^codicarium\\.publisher-mutation/v1:[0-9a-f]{64}:[1-9][0-9]*:[0-9a-f]{64}$" }, sha256: sha64, previous_receipt_sha256: sha64 }) },
      retirement: closed(["old_workflows", "legacy_credentials_removed", "general_runner_access_removed"], {
        old_workflows: { type: "array", prefixItems: [
          closed(["id", "path", "state"], { id: { const: "341194538" }, path: { const: ".github/workflows/automatic-release.yaml" }, state: { const: "disabled_manually" } }),
          closed(["id", "path", "state"], { id: { const: "318365668" }, path: { const: ".github/workflows/release.yaml" }, state: { const: "disabled_manually" } }),
          closed(["id", "path", "state"], { id: { const: "318365667" }, path: { const: ".github/workflows/publish-release.yaml" }, state: { const: "disabled_manually" } })
        ], items: false, minItems: 3, maxItems: 3 },
        legacy_credentials_removed: { const: true }, general_runner_access_removed: { const: true }
      })
    },
    { unevaluatedProperties: false }
  )
};

writeJson("artifact-capability-api-v1.schemas.json", artifactCapabilitySchemas);
writeJson("candidate-evidence-v1.schema.json", candidateEvidenceSchema);
writeJson("publisher-dispatch-receipt-v1.schema.json", dispatchReceiptSchema);
writeJson("publisher-mutation-receipt-v1.schema.json", mutationReceiptSchema);
writeJson("release-live-evidence-v1.schema.json", liveEvidenceSchema);
writeJson("workflow-permissions-v1.json", workflowContract);

const horizonFixture = {
  schema: "codicarium.check-history-horizon-fixture/v1",
  requests: Array.from({ length: 10 }, (_, pageIndex) => ({
    page: String(pageIndex + 1),
    query: `filter=all&per_page=100&page=${pageIndex + 1}`,
    check_suite_ids: Array.from({ length: 100 }, (_, itemIndex) => String(pageIndex * 100 + itemIndex + 1)),
    check_run_ids: Array.from({ length: 100 }, (_, itemIndex) => String(1000000 + pageIndex * 100 + itemIndex + 1)),
    exact_external_id_count: "0"
  })),
  expected: { distinct_check_suite_count: "1000", pagination_exhausted: true, history_termination: "CHECK_SUITE_HORIZON", outcome: "UNKNOWN_MANUAL", mutation_count: "0" }
};
writeJson("history-horizon-1000.json", horizonFixture);

const handoffTuple = "release-verify:9003001/1:v0.6.14:1111111111111111111111111111111111111111:9001001/1:9002001/1:9002003:2222222222222222222222222222222222222222";
const dispatchTuple = "publisher-dispatch:9004001/1:9004003:8abe528bb32aaa47f8fc496c3571d4b91248f3ebfe4c8be29463a25277bd9e88:2222222222222222222222222222222222222222:codicarium/deployment-controller:v0.6.14:1111111111111111111111111111111111111111";
const canonicalIdentityFixture = {
  schema: "codicarium.release-identity-fixtures/v1",
  handoff: {
    json_byte_length: 697,
    json_sha256: "8abe528bb32aaa47f8fc496c3571d4b91248f3ebfe4c8be29463a25277bd9e88",
    digest_base64url: "ir5Si7Mqqkf4_ElsNXHUuRJI8-v-TIvilGOiUne9nog",
    tuple_grammar: "release-verify:<verifier_id>/<attempt>:<tag>:<source>:<ci_id>/<attempt>:<coordinator_id>/<attempt>:<coordinator_check_id>:<publisher_revision>",
    tuple: handoffTuple,
    tuple_base64url: b64url(Buffer.from(handoffTuple, "utf8"))
  },
  dispatch: {
    json_byte_length: 436,
    json_sha256: "b150fa8dad70a207fb7a78f6a41ab1bc1430833ba70b86fdc2f08a13c7c11f3b",
    digest_base64url: "sVD6ja1wogf7enj2pBqxvBQwgzunC4b9wvCKE8fBHzs",
    tuple_grammar: "publisher-dispatch:<authorizer_id>/<attempt>:<handoff_check_id>:<handoff_sha256>:<publisher_revision>:<repository>:<tag>:<source>",
    tuple: dispatchTuple,
    tuple_base64url: b64url(Buffer.from(dispatchTuple, "utf8"))
  }
};
writeJson("canonical-identity-fixtures-v1.json", canonicalIdentityFixture);

const edSeed = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
const edPublic = Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex");
const publicJwk = { crv: "Ed25519", kty: "OKP", x: b64url(edPublic) };
const kid = b64url(crypto.createHash("sha256").update(Buffer.from(jcs(publicJwk))).digest());
const tokenHeader = { alg: "EdDSA", kid, typ: "codicarium-artifact-capability+jwt" };
const tokenClaims = {
  aud: "codicarium-artifact-capability-api", capability_version: "1", content_type: "application/zstd", exp: 1767227400, iat: 1767225600,
  iss: "https://artifact-capability.artifact-capability.svc.cluster.local:8443", jti: "0123456789abcdef0123456789abcdef", max_compressed_bytes: "1073741824", max_uncompressed_bytes: "4294967296",
  mint_run_attempt: "1", mint_run_id: "9002001", nbf: 1767225570, nonce: "0123456789abcdef0123456789abcdef",
  object_key: "artifacts/v1/orgs/255540067/repos/1303901324/releases/v0.6.14/sources/1111111111111111111111111111111111111111/runs/9003001/attempts/1/deployment-controller-verified-image/0123456789abcdef0123456789abcdef.tar.zst",
  operation: "create", owner_id: "255540067", purpose: "deployment-controller-verified-image", repository_id: "1303901324", source_revision: "1111111111111111111111111111111111111111",
  sub: "repo:codicarium/deployment-controller:workflow:.github/workflows/release-verify-v2.yaml:ref:refs/heads/main", subject_run_attempt: "1", subject_run_id: "9003001", tag: "v0.6.14"
};
const encodedHeader = b64url(Buffer.from(jcs(tokenHeader)));
const encodedClaims = b64url(Buffer.from(jcs(tokenClaims)));
const signingInput = Buffer.from(`${encodedHeader}.${encodedClaims}`, "ascii");
const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), edSeed]), format: "der", type: "pkcs8" });
const signature = crypto.sign(null, signingInput, privateKey);
const capabilityJwsFixture = {
  schema: "codicarium.artifact-capability-jws-fixture/v1",
  fixture_only_private_seed_hex: edSeed.toString("hex"),
  public_jwk: publicJwk,
  kid,
  protected_header: tokenHeader,
  claims: tokenClaims,
  protected_header_jcs_base64url: encodedHeader,
  claims_jcs_base64url: encodedClaims,
  signing_input_sha256: sha256(signingInput),
  signature_base64url: b64url(signature),
  compact_jws: `${encodedHeader}.${encodedClaims}.${b64url(signature)}`
};
writeJson("artifact-capability-jws-v1.fixture.json", capabilityJwsFixture);

const candidateEvidenceFixture = {
  schema: "codicarium.release-candidate-evidence/v1",
  repository: "codicarium/deployment-controller",
  tag: "v0.6.14",
  source_revision: "1111111111111111111111111111111111111111",
  ci: { run_id: "9001001", run_attempt: "1" },
  verifier: { run_id: "9003001", run_attempt: "1" },
  archives: {
    "deployment-controller-verified-image": {
      object_key: "artifacts/v1/orgs/255540067/repos/1303901324/releases/v0.6.14/sources/1111111111111111111111111111111111111111/runs/9003001/attempts/1/deployment-controller-verified-image/0123456789abcdef0123456789abcdef.tar.zst",
      archive_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      byte_length: "4096",
      capability_nonce: "0123456789abcdef0123456789abcdef",
      capability_expires_at: "2026-01-01T00:30:00Z",
      files: [
        { path: "deployment-controller-linux-amd64.spdx.json", size: "1", sha256: "1111111111111111111111111111111111111111111111111111111111111111" },
        { path: "deployment-controller-linux-arm64.spdx.json", size: "1", sha256: "2222222222222222222222222222222222222222222222222222222222222222" },
        { path: "deployment-controller.env", size: "1", sha256: "3333333333333333333333333333333333333333333333333333333333333333" },
        { path: "deployment-controller.oci.tar", size: "1", sha256: "4444444444444444444444444444444444444444444444444444444444444444" }
      ]
    },
    "deployment-controller-verified-chart": {
      object_key: "artifacts/v1/orgs/255540067/repos/1303901324/releases/v0.6.14/sources/1111111111111111111111111111111111111111/runs/9003001/attempts/1/deployment-controller-verified-chart/fedcba9876543210fedcba9876543210.tar.zst",
      archive_sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      byte_length: "2048",
      capability_nonce: "fedcba9876543210fedcba9876543210",
      capability_expires_at: "2026-01-01T00:30:00Z",
      files: [
        { path: "deployment-controller-0.6.14.tgz", size: "1", sha256: "5555555555555555555555555555555555555555555555555555555555555555" },
        { path: "deployment-controller-chart.sha256", size: "1", sha256: "6666666666666666666666666666666666666666666666666666666666666666" }
      ]
    }
  }
};
writeJson("candidate-evidence-v1.fixture.json", candidateEvidenceFixture);

const signReceiptBody = (body) => {
  const payload = Buffer.from(jcs(body), "utf8");
  return {
    body,
    signature: {
      format: "ed25519-jcs/v1",
      kid,
      payload_sha256: sha256(payload),
      signature_base64url: b64url(crypto.sign(null, payload, privateKey))
    }
  };
};
const dispatchReceiptFixture = signReceiptBody({
  schema: "codicarium.publisher-dispatch-receipt/v1",
  kind: "publisher-dispatch-receipt",
  repository: "codicarium/deployment-controller",
  tag: "v0.6.14",
  source_revision: "1111111111111111111111111111111111111111",
  authorization_sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  handoff_sha256: "8abe528bb32aaa47f8fc496c3571d4b91248f3ebfe4c8be29463a25277bd9e88",
  dispatch_request_sha256: "b150fa8dad70a207fb7a78f6a41ab1bc1430833ba70b86fdc2f08a13c7c11f3b",
  claim_check_run_id: "9004002",
  coordinator_run_id: "9004001",
  coordinator_run_attempt: "1",
  publisher_workflow: "codicarium/deployment-controller/.github/workflows/publish-release-v2.yaml",
  publisher_ref: "refs/heads/main",
  publisher_revision: "2222222222222222222222222222222222222222",
  publisher_workflow_sha: "2222222222222222222222222222222222222222",
  publisher_run_id: "9005001",
  publisher_run_attempt: "1",
  issued_at: "2026-01-01T00:00:05Z",
  issuer: {
    kind: "github-actions",
    repository_id: "1303901324",
    workflow: "codicarium/deployment-controller/.github/workflows/automatic-release-v2.yaml",
    ref: "refs/heads/main",
    workflow_sha: "2222222222222222222222222222222222222222",
    run_id: "9004001",
    run_attempt: "1"
  }
});
writeJson("publisher-dispatch-receipt-v1.fixture.json", dispatchReceiptFixture);
const dispatchReceiptDigest = sha256(Buffer.from(jcs(dispatchReceiptFixture.body), "utf8"));
const mutationReceiptFixture = signReceiptBody({
  schema: "codicarium.publisher-mutation-receipt/v1",
  kind: "publisher-mutation-receipt",
  dispatch_receipt_sha256: dispatchReceiptDigest,
  sequence: "1",
  previous_receipt_sha256: dispatchReceiptDigest,
  mutation: "release-create",
  request_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  readback_sha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  publisher_ref: "refs/heads/main",
  publisher_revision: "2222222222222222222222222222222222222222",
  publisher_run_id: "9005001",
  publisher_run_attempt: "1",
  issued_at: "2026-01-01T00:01:00Z",
  issuer: {
    kind: "github-actions",
    repository_id: "1303901324",
    workflow: "codicarium/deployment-controller/.github/workflows/publish-release-v2.yaml",
    ref: "refs/heads/main",
    workflow_sha: "2222222222222222222222222222222222222222",
    run_id: "9005001",
    run_attempt: "1"
  },
  target: { release_id: "9006001", tag: "v0.6.14", target_commitish: "1111111111111111111111111111111111111111", draft: true, prerelease: false }
});
writeJson("publisher-mutation-receipt-v1.fixture.json", mutationReceiptFixture);

const mutationKinds = ["release-create", "image-publish", "chart-publish", ...assetNames.map(() => "release-asset-create"), "release-finalize"];
let previousReceipt = dispatchReceiptDigest;
const liveMutationReceipts = mutationKinds.map((mutation, index) => {
  const sequence = String(index + 1);
  const receiptDigest = sha256(Buffer.from(`publisher-mutation-receipt-${sequence}`, "utf8"));
  const row = {
    sequence,
    mutation,
    check_id: String(9200000 + index + 1),
    external_id: `codicarium.publisher-mutation/v1:${dispatchReceiptDigest}:${sequence}:${receiptDigest}`,
    sha256: receiptDigest,
    previous_receipt_sha256: previousReceipt
  };
  previousReceipt = receiptDigest;
  return row;
});
const actor = (runId, attempt, workflowPath, workflowSha, checkId) => ({ run_id: runId, attempt, workflow_path: workflowPath, workflow_sha: workflowSha, check_id: checkId });
const liveEvidenceFixture = {
  schema: "codicarium.release-live-evidence/v1",
  captured_at: "2026-01-01T01:00:00Z",
  repository: { full_name: "codicarium/deployment-controller", id: "1303901324" },
  corrective_pr: { number: "101", head_sha: "2222222222222222222222222222222222222222", merge_sha: "2222222222222222222222222222222222222222" },
  protected_main_sha: "2222222222222222222222222222222222222222",
  protected_checks: protectedChecks.map((name, index) => ({ name, app_id: "15368", run_id: "9000001", attempt: "1", check_id: String(9300000 + index + 1), head_sha: "2222222222222222222222222222222222222222", status: "completed", conclusion: "success" })),
  release_identity: { tag: "v0.6.14", source_sha: "1111111111111111111111111111111111111111" },
  coordinator: actor("9004001", "1", ".github/workflows/automatic-release-v2.yaml", "2222222222222222222222222222222222222222", "9004001"),
  verifier: actor("9003001", "1", ".github/workflows/release-verify-v2.yaml", "2222222222222222222222222222222222222222", "9003001"),
  attester: actor("9003001", "1", ".github/workflows/release-verify-v2.yaml", "2222222222222222222222222222222222222222", "9003002"),
  claim: actor("9004001", "1", ".github/workflows/automatic-release-v2.yaml", "2222222222222222222222222222222222222222", "9004002"),
  receipt: actor("9004001", "1", ".github/workflows/automatic-release-v2.yaml", "2222222222222222222222222222222222222222", "9004003"),
  publisher: actor("9005001", "1", ".github/workflows/publish-release-v2.yaml", "2222222222222222222222222222222222222222", "9005001"),
  candidate_evidence: {
    evidence_sha256: sha256(Buffer.from(jcs(candidateEvidenceFixture), "utf8")),
    image: { object_key: candidateEvidenceFixture.archives["deployment-controller-verified-image"].object_key, archive_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", byte_length: "4096", nonce: "0123456789abcdef0123456789abcdef" },
    chart: { object_key: candidateEvidenceFixture.archives["deployment-controller-verified-chart"].object_key, archive_sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", byte_length: "2048", nonce: "fedcba9876543210fedcba9876543210" }
  },
  authorization: {
    object_key: "artifacts/v1/orgs/255540067/repos/1303901324/releases/v0.6.14/sources/1111111111111111111111111111111111111111/runs/9003001/attempts/1/deployment-controller-signed-authorization/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tar.zst",
    archive_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    predicate_sha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    byte_length: "1024",
    nonce: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  handoff: {
    check_id: "9004003",
    external_id: "codicarium.release-handoff/v1:8abe528bb32aaa47f8fc496c3571d4b91248f3ebfe4c8be29463a25277bd9e88",
    sha256: "8abe528bb32aaa47f8fc496c3571d4b91248f3ebfe4c8be29463a25277bd9e88",
    digest_base64url: canonicalIdentityFixture.handoff.digest_base64url,
    tuple_base64url: canonicalIdentityFixture.handoff.tuple_base64url
  },
  dispatch: {
    claim_check_id: "9004002",
    receipt_check_id: "9004003",
    external_id: `codicarium.publisher-receipt/v1:${dispatchReceiptDigest}`,
    sha256: dispatchReceiptDigest,
    digest_base64url: b64url(Buffer.from(dispatchReceiptDigest, "hex")),
    tuple_base64url: canonicalIdentityFixture.dispatch.tuple_base64url
  },
  release: { id: "9006001", tag: "v0.6.14", target: "1111111111111111111111111111111111111111", draft: false, prerelease: false },
  registries: {
    image: { registry: "docker-pull.nexus.int.codicarium.com", repository: "codicarium/deployment-controller", reference: "v0.6.14", digest: `sha256:${"e".repeat(64)}` },
    chart: { registry: "charts.nexus.int.codicarium.com", repository: "codicarium/deployment-controller", version: "0.6.14", digest: `sha256:${"f".repeat(64)}` }
  },
  assets: assetNames.map((name, index) => ({ id: String(9400000 + index + 1), name, size: "1", sha256: String((index % 9) + 1).repeat(64) })),
  mutation_receipts: liveMutationReceipts,
  retirement: {
    old_workflows: [
      { id: "341194538", path: ".github/workflows/automatic-release.yaml", state: "disabled_manually" },
      { id: "318365668", path: ".github/workflows/release.yaml", state: "disabled_manually" },
      { id: "318365667", path: ".github/workflows/publish-release.yaml", state: "disabled_manually" }
    ],
    legacy_credentials_removed: true,
    general_runner_access_removed: true
  }
};
writeJson("release-live-evidence-v1.fixture.json", liveEvidenceFixture);

const followUpOrder = {
  schema: "codicarium.issue93-follow-up-order/v1",
  total_order: [
    "issue-93-corrective-pr-merged-and-old-workflows-retired",
    "v0.6.14-public-release-and-full-live-evidence-verified",
    "issue-98-v0.6.8-recovery-success-and-eight-assets-read-back",
    "pr-99-rebased-on-current-main",
    "pr-99-five-checks-at-one-head",
    "pr-99-merged",
    "recover-release-v068.yaml-absent-at-pr-99-merge-sha",
    "issue-98-closed",
    "pr-94-rebased-on-resulting-main",
    "pr-94-five-checks-at-one-head",
    "pr-94-merged"
  ],
  forbidden: ["PR #99 triggers or resumes v0.6.13", "PR #94 triggers or resumes v0.6.13", "any v0.6.13 publication authority"]
};
writeJson("follow-up-order-v1.json", followUpOrder);

const manifestFiles = [
  "artifact-capability-api-v1.schemas.json", "candidate-evidence-v1.schema.json", "publisher-dispatch-receipt-v1.schema.json",
  "publisher-mutation-receipt-v1.schema.json", "release-live-evidence-v1.schema.json", "workflow-permissions-v1.json",
  "history-horizon-1000.json", "canonical-identity-fixtures-v1.json", "artifact-capability-jws-v1.fixture.json", "candidate-evidence-v1.fixture.json",
  "publisher-dispatch-receipt-v1.fixture.json", "publisher-mutation-receipt-v1.fixture.json", "release-live-evidence-v1.fixture.json", "follow-up-order-v1.json",
  "canonical-archive-v1.tar", "canonical-archive-v1.tar.zst", "archive-input/alpha.txt", "archive-input/beta.txt"
];
const annex = {
  schema: "codicarium.issue93-spec-annex/v1",
  generated_at: "2026-08-25T05:30:00Z",
  baselines,
  capability_protocol: {
    base_url: "https://artifact-capability.artifact-capability.svc.cluster.local:8443",
    oidc_issuer: "https://token.actions.githubusercontent.com",
    mint_audience: "codicarium-artifact-capability",
    token_audience: "codicarium-artifact-capability-api",
    endpoints: {
      mint: { method: "POST", path: "/v1/capabilities", request_schema: "artifact-capability-api-v1.schemas.json#/$defs/mint_request", response_schema: "artifact-capability-api-v1.schemas.json#/$defs/mint_response" },
      upload: { method: "PUT", path: "/v1/object", operation: "create", required_headers: { "If-None-Match": "*", "Content-Type": "application/zstd", "X-Codicarium-Object-Key": "exact token object_key", "Content-Length": "exact decimal bytes" }, success_status: 201 },
      read: { method: "GET", path: "/v1/object", operation: "read", ranges: false, redirects: false },
      readback: { method: "POST", path: "/v1/object/readback", operation: "readback", response_schema: "artifact-capability-api-v1.schemas.json#/$defs/readback_response" }
    },
    token_ttl_seconds: 1800,
    oidc_max_age_seconds: 300,
    clock_skew_seconds: 30,
    jwks_cache_max_seconds: 60,
    purpose_limits: {
      "deployment-controller-verified-image": { max_compressed_bytes: "1073741824", max_uncompressed_bytes: "4294967296" },
      "deployment-controller-verified-chart": { max_compressed_bytes: "67108864", max_uncompressed_bytes: "268435456" },
      "deployment-controller-signed-authorization": { max_compressed_bytes: "67108864", max_uncompressed_bytes: "268435456" }
    },
    conditional_create: "A durable linearizable jti reservation and backend-native atomic create-if-absent are both required; HEAD followed by unconditional PUT is forbidden.",
    ambiguity: "Any unprovable mint, reserve, create, readback, dispatch, or receipt write is UNKNOWN_MANUAL; no automatic second mint, upload, dispatch, overwrite, delete, retag, or replacement is allowed.",
    key_rotation: "Ed25519 only; kid is RFC 7638 public-JWK thumbprint; one minting key; publish new verification key >=300 seconds before issuance; retain retired verification key until 30 seconds after greatest exp; unknown kid gets one JWKS refresh then fails; emergency revocation stops mint and redemption."
  },
  archive_profile: {
    tar: "Single POSIX ustar stream; root ASCII regular files only; unsigned-byte path sort; mode 0644; uid/gid/mtime 0; empty uname/gname/link/prefix; typeflag 0; canonical octal/checksum; 512-byte zero padding; exactly two zero EOF blocks; no trailing bytes, links, directories, devices, FIFOs, sockets, sparse, PAX/GNU extensions, duplicate, absolute, traversal, backslash, control, or non-ASCII names.",
    zstd: "One zstd frame, level 19, single-threaded, content size and frame checksum present, no dictionary, skippable frame, concatenated frame, or trailing bytes. Shared implementation pins codec source and OCI digest and must reproduce the checked-in byte fixture.",
    fixture_tar: { byte_length: 3072, sha256: "fb7a260f46a361d9b90bf6371824f0b62dcabf99be09ab984a4fb6fcaeebda31" },
    fixture_tar_zst: { byte_length: 102, sha256: "5858457a000d6f7334053b51ba4f1106f1ee1e683ffc6bcf461af0fe9b3dc64b" },
    fixture_generator: { tar: "GNU tar 1.35 canonical flags", zstd: "zstd 1.5.7 -19 -T1 --check --content-size", local_zstd_sha256: "6b799c822798547e33f3d928d04492ca4814d4b45088786b73d700f0cc0d905a" }
  },
  history_contract: {
    terminations: ["EXHAUSTED", "CHECK_SUITE_HORIZON", "MALFORMED"],
    decision: "More than one exact external_id is FAIL_DUPLICATE. One exact valid row is PASS. Zero exact rows plus >=1000 distinct check_suite.id values is UNKNOWN_MANUAL/CHECK_SUITE_HORIZON with zero mutations. Zero exact rows plus <1000 suites and exhausted pagination is PASS_ABSENT.",
    every_request: "filter=all&per_page=100; sequential pagination; repeated IDs or inconsistent duplicate rows are MALFORMED."
  },
  old_workflow_retirement: {
    old_workflows: [
      { id: "341194538", name: "Automatic Release", path: ".github/workflows/automatic-release.yaml" },
      { id: "318365668", name: "Release Verify", path: ".github/workflows/release.yaml" },
      { id: "318365667", name: "Publish Release", path: ".github/workflows/publish-release.yaml" }
    ],
    pre_merge_fence: [
      "Disable all three old workflow IDs.",
      "Remove deployment-controller access to CODICARIUM_PACKAGE_REGISTRY_USERNAME, CODICARIUM_PACKAGE_REGISTRY_PASSWORD, NEXUS_USERNAME, NEXUS_PASSWORD, ACTIONS_STORAGE_OVH_ACCESS_KEY_ID, and ACTIONS_STORAGE_OVH_ACCESS_KEY_SECRET; revoke the underlying old identities.",
      "Remove deployment-controller from the general codicarium runner group and bind new CI/release runner groups to exact new workflow paths.",
      "Restrict all new Vault/OIDC audiences and roles to the v2 workflow paths, refs/heads/main, repository ID 1303901324, and the recorded runner-group IDs."
    ],
    merge_change: "Delete the three old workflow paths from default main and add the three v2 paths; old IDs remain disabled.",
    proof: "GitHub API reports disabled_manually for old IDs, old paths are absent at main, old secrets are unavailable to the repository, old general runner routing is absent, bounded negative dispatch and rerun calls cannot create an executing run, and no old output is accepted."
  },
  platform_ownership: {
    "codicarium/codicarium-actions": ["artifact-capability/openapi.yaml", "artifact-capability/schemas/", "artifact-capability/client/", "artifact-capability/archive/", "tests/artifact-capability-test.sh"],
    "codicarium/vault-config": ["config/jwt-dev-auth.json role codicarium-dev-artifact-capability", "config/policies/codicarium-dev-artifact-capability-read.hcl", "exact paths codicarium/dev/artifact-capability/object-store-access-key-id and object-store-secret-access-key", "non-exportable signing or transit key policy", "new v2 publisher short-lived Nexus role"],
    "codicarium/runner-config": ["deployment-charts/artifact-capability/", "Runner Platform v2 scale set codicarium-v2-artifact-capability", "runner group codicarium-ci-artifact-capability", ".codicarium/dev/deploy.yaml component artifact-capability", "internal ClusterIP/TLS/standard NetworkPolicy/ServiceMonitor/PrometheusRule/PDB/placement"],
    "codicarium/app-config": ["bootstrap Application wiring only if the deployment-controller materializer cannot activate the runner-config component; no workload chart, values, descriptor, or secret ownership"],
    "codicarium/infra": ["centrally owned DeploymentProfile artifact-capability-path-helm", "DeploymentGrant runner-config-dev component artifact-capability for repository ID 1303372884", "exact namespace/application/release/chart-path authorization and admission policy", "at least three eligible schedulable nodes with verified N-1 capacity before broker three-replica rollout"],
    "organization administration": ["dedicated runner-group IDs and exact workflow allowlist", "old workflow disablement", "legacy organization-secret repository visibility removal"],
    "codicarium/deployment-controller": ["v2 workflows and helpers", "exact full-SHA shared-client pin", "candidate evidence semantic validator", "retirement guards", "live-evidence validator"]
  },
  service_runtime: {
    namespace: "artifact-capability",
    application: "artifact-capability-codicarium",
    release: "artifact-capability",
    service: "artifact-capability",
    app_project: "repo-runner-config-dev",
    deployment_profile: "artifact-capability-path-helm",
    deployment_grant: "runner-config-dev",
    component_id: "artifact-capability",
    chart_path: "deployment-charts/artifact-capability",
    endpoint: "https://artifact-capability.artifact-capability.svc.cluster.local:8443",
    exposure_class: "no-ingress",
    service_type: "ClusterIP only; no Ingress, HTTPRoute, LoadBalancer, NodePort, external-DNS, or externally resolvable hostname",
    tls: "cert-manager internal certificate with DNS SAN artifact-capability.artifact-capability.svc.cluster.local; TLS 1.3 preferred and TLS 1.2 minimum; no plaintext listener",
    infrastructure_prerequisite: "Before three replicas, PDB or N-1 validation, infra MUST provide at least three eligible schedulable nodes and prove enough allocatable capacity on the remaining two after loss of any one node; release traffic remains disabled until this passes.",
    replicas: 3,
    placement: "required hostname anti-affinity and topologySpreadConstraints maxSkew=1 DoNotSchedule",
    pdb: "minAvailable=2",
    network: "Standard Kubernetes NetworkPolicy default deny. Candidate namespace arc-runners-v2-untrusted egress allows DNS TCP/UDP 53 only to ipBlock 10.43.0.10/32 and TCP 8443 only through one NetworkPolicy to peer containing both namespaceSelector kubernetes.io/metadata.name=artifact-capability and podSelector app.kubernetes.io/name=artifact-capability. Separate namespace-only or pod-only peers are forbidden because peer entries are ORed. All other candidate egress is denied, including other pods in the artifact-capability namespace, same-labeled pods in other namespaces, Nexus, public Internet, other RFC1918, CGNAT, metadata, link-local, multicast and reserved destinations; no implementation-specific FQDN policy or resolved-IP exception is allowed. Broker egress is separately limited to DNS, Vault, the exact OVH S3 endpoint, GitHub OIDC/JWKS and required Kubernetes API identity only; no general Internet or registry egress.",
    candidate_runner: { namespace: "arc-runners-v2-untrusted", scale_set: "codicarium-v2-artifact-capability", runner_group: "codicarium-ci-artifact-capability", labels: ["self-hosted", "Linux", "X64", "artifact-capability", "codicarium-v2-artifact-capability"], runtime_class: "kata-clh-runtime-rs", min_runners: 0, max_runners: 1 },
    observability: "ServiceMonitor plus alerts for mint/redeem/read errors, UNKNOWN_MANUAL, replay, pending ledger age, storage latency/error, key expiry, JWKS refresh, saturation, replica availability, and certificate expiry; audit log records why without tokens or credentials.",
    availability: "Only after the three-node/capacity prerequisite passes, three replicas use hard node separation and PDB minAvailable=2; node-loss conformance proves two ready replicas, mint/read continuity, no token reuse, no pending-state promotion, and documented RTO/RPO.",
    rollback: "Fail closed: disable v2 workflows and revert Git desired state to the last reviewed runner-config chart. Never re-enable old workflows, restore old credentials, or resume v0.6.13."
  },
  follow_up_order: followUpOrder.total_order,
  files: manifestFiles.map(fileRecord)
};

const annexBytes = jsonBytes(annex);
fs.writeFileSync(path.join(runDir, "feature-spec.v1.9.annex.json"), annexBytes);
const annexSha = sha256(annexBytes);

const requirements = [
  ["REQ-001", "MUST", `Specification and branch baselines MUST begin at exactly ${Object.entries(baselines).map(([repo, sha]) => `${repo}=${sha}`).join(", ")}. Any upstream change before v1.9 exact-hash council freeze requires focused re-audit of that repository and an updated annex; merged prerequisite PRs then become the recorded successor baselines.`, "Exact starting points prevent stale security conclusions while allowing the ordered prerequisite implementation itself to advance main."],
  ["REQ-002", "MUST", "The PR #100 provenance invariant MUST remain base ca55729de7a58bef5b49ebdce8c28773bb7e1b2e to d3565f534b2f64585c3e15e35d8d645449f4f09d with exactly six changed paths: .github/workflows/automatic-release.yaml, .github/workflows/release.yaml, docs/releasing.md, hack/release-handoff-policy.js, hack/test-release-graph.py, hack/test-release-handoff-policy.js. The issue #93 change MUST reconcile all six. Until PR #99 removal, the three PR #97 blobs MUST remain byte-identical: recover-release-v068.yaml=5dfee56b27ccf791c3ab024145b63539ad1d1a3a, publisher-subject-evidence.md=d6c9572818ce2a80ea1cecd7aacd3bc68f91b90e, test-recover-release-v068.py=b6daa1135ffa9a49921cc1d8c677e1e5da451592.", "Preserving known landed behavior avoids accidental recovery regressions during the release repair."],
  ["REQ-003", "MUST", "The corrective PR MUST add protected-main-only .github/workflows/automatic-release-v2.yaml, release-verify-v2.yaml, and publish-release-v2.yaml and delete the corresponding old paths. Dispatch MUST use refs/heads/main, returned runs MUST have exact v2 workflow path/ref and captured protected-main head SHA, and candidate tag/source remain validated data only; no workflow may execute policy selected from a tag or raw candidate SHA.", "New workflow paths create new workflow IDs and eliminate tag-selected privileged policy."],
  ["REQ-004", "MUST", "Candidate source MUST run only in a destroyed-after-use Runner Platform v2 sandbox with no GITHUB_TOKEN, static secret, OIDC, registry or storage credential, signing key, GitHub write or dispatch scope, Docker host socket, service-account token, hostPath, shared runner directory, or general egress. Centrally reviewed code MUST prefetch digest-pinned inputs read-only, pass only two independent exact-object create capabilities, terminate candidate processes, and destroy the pod/PVC before any trusted credentialed step.", "Repository identity does not make candidate code trusted."],
  ["REQ-005", "MUST", `The capability protocol, schemas, client, canonical archive codec, and conformance fixtures MUST be implemented under codicarium-actions paths frozen by annex SHA ${annexSha}; runner-config MUST own the issuer/service and isolated runner. The exact API is POST /v1/capabilities, PUT /v1/object, GET /v1/object, and POST /v1/object/readback at the internal-only endpoint https://artifact-capability.artifact-capability.svc.cluster.local:8443 with the closed schemas and headers in the annex; neither callers nor repository content may choose another endpoint, profile, subject, key prefix, operation, limit, issuer, or group.`, "A reviewed shared protocol is required before credentialless candidate transfer can be implemented safely."],
  ["REQ-006", "MUST", "Mint MUST authenticate a GitHub OIDC token no older than 300 seconds with issuer token.actions.githubusercontent.com, audience codicarium-artifact-capability, organization ID 255540067, repository ID 1303901324, exact allowed v2 workflow path, refs/heads/main, workflow SHA, run ID and attempt. Capabilities MUST be Ed25519 compact JWS with exactly the annex header/claims, 1800-second lifetime, 30-second skew, one operation/object, and the annex JWKS rotation rules; duplicate/unknown claims, another algorithm, padding, bad JCS, stale or ambiguous mint fail closed.", "Machine-exact claims and rotation prevent replay, algorithm confusion, and bearer expansion."],
  ["REQ-007", "MUST", "The service MUST derive keys matching the annex grammar and issue distinct JWS, nonce/jti, object key, ledger entry, and upload call for image and chart. Limits MUST be image 1073741824 compressed/4294967296 decompressed, chart and signed authorization 67108864 compressed/268435456 decompressed. Candidate receives exactly two create capabilities; attester receives two exact reads and one signed-authorization create; publisher receives exactly three exact reads. No token grants list, prefix, range, redirect, overwrite, delete, alternate key, broad presigned URL, backend credential, registry authority, or delegation.", "Separate one-object capabilities make effective authority mechanically bounded."],
  ["REQ-008", "MUST", "Upload MUST require the exact annex headers and durable linearizable jti reservation plus backend-native atomic create-if-absent. HTTP 201 is allowed only after full stored-byte readback, SHA-256/length verification, decompressed-limit verification, and terminal ledger persistence. Exact read MUST spool and verify the full object before returning bytes; readback returns metadata only. Wrong key, expiry, replay, race, oversize, timeout, process loss, backend conflict, mismatched readback, or inability to prove whether state changed is UNKNOWN_MANUAL with no automatic retry, second mint/upload, overwrite, delete, or replacement.", "Ambiguous object writes cannot safely be retried."],
  ["REQ-009", "MUST", "Authoritative candidate evidence MUST validate against fixtures-v1.9/candidate-evidence-v1.schema.json, be at most 32768 RFC 8785 bytes, contain exactly two archive records with independent nonces/expiries/receipts and the fixed path-sorted file sets, and be constructed by protected wrapper code after candidate termination from broker receipts and canonical archive observations. Candidate code cannot author the authoritative object. Schema-valid but cross-field-inconsistent keys, source, runs, nonces, lengths, files, or hashes MUST fail semantic validation.", "A closed, independently derived evidence object prevents forged candidate metadata from becoming authority."],
  ["REQ-010", "MUST", "Every candidate and signed-authorization archive MUST use the annex canonical single-ustar/single-zstd profile and reject all unsafe or noncanonical members/frames. The shared codec MUST reproduce canonical-archive-v1.tar exactly at 3072 bytes/SHA-256 fb7a260f46a361d9b90bf6371824f0b62dcabf99be09ab984a4fb6fcaeebda31 and canonical-archive-v1.tar.zst exactly at 102 bytes/SHA-256 5858457a000d6f7334053b51ba4f1106f1ee1e683ffc6bcf461af0fe9b3dc64b; expected fixtures are immutable and never regenerated in place.", "Byte-exact archive fixtures expose ordering, metadata, codec, and extraction drift."],
  ["REQ-011", "MUST", "A protected-main attester MUST use exact broker reads to verify both candidate archives, safely extract and recompute every size/hash, validate candidate evidence, and create Sigstore attestations plus a signed authorization bound to repository, v0.6.14/source, evidence and archive digests, CI/verifier/coordinator/attester identities, and protected publisher revision. It then uses one exact create capability for the signed bundle. It MUST never check out or execute candidate source, Dockerfile, scripts, binaries, hooks, or generated commands; signing and handoff/dispatch authority stay in disjoint jobs.", "Only reviewed protected code may cross from untrusted bytes into signing and publication authorization."],
  ["REQ-012", "MUST", "All identity, authorization, dispatch, and receipt objects MUST reject duplicate/unknown keys before RFC 8785 JCS over UTF-8 without BOM/whitespace/trailing LF; IDs/attempts are canonical positive decimal strings, SHA values lowercase, and base64url RFC 4648 section 5 unpadded. Handoff, claim, dispatch receipt, and mutation external IDs MUST use their annex prefixes and exact digests.", "All participants must compute the same bytes and identifiers."],
  ["REQ-013", "MUST", "The existing handoff JSON fixture MUST remain 697 bytes with SHA-256 8abe528bb32aaa47f8fc496c3571d4b91248f3ebfe4c8be29463a25277bd9e88 and digest base64url ir5Si7Mqqkf4_ElsNXHUuRJI8-v-TIvilGOiUne9nog; dispatch JSON remains 436 bytes with SHA-256 b150fa8dad70a207fb7a78f6a41ab1bc1430833ba70b86fdc2f08a13c7c11f3b and digest base64url sVD6ja1wogf7enj2pBqxvBQwgzunC4b9wvCKE8fBHzs. Tuple grammars and exact tuple-base64url values MUST equal canonical-identity-fixtures-v1.json.", "Explicit tuple vectors close v1.8's final encoding ambiguity."],
  ["REQ-014", "MUST", "Every handoff, claim, dispatch-receipt, and mutation-receipt Check Run creation MUST omit requested details_url; returned positive check.id and details_url MUST parse exactly as https://github.com/codicarium/deployment-controller/runs/<check.id>, with HTTPS/github.com, no user/password/port/query/fragment/percent-encoding/trailing slash, and exact case. Live check 97655710504 accepts only that canonical URL. A changed server form fails closed for renewed review.", "The observed GitHub canonical URL caused the production failure and is not documented as stable."],
  ["REQ-015", "MUST", "Check selection MUST filter exact external_id before any other field. More than one exact row is duplicate-ambiguous regardless of validity; exactly one is then validated for ID, exact name, GitHub Actions app ID 15368/slug, completed/success, source head, URL and closed output; same-name rows with other external IDs are ignored. Zero rows is absence only after REQ-016 proves EXHAUSTED.", "External-ID-first selection prevents same-name poisoning and unsafe duplicate preference."],
  ["REQ-016", "MUST", "Every check-run and check-suite history request MUST use filter=all, per_page=100, sequentially exhaust pagination, detect repeated/inconsistent IDs, and count distinct check_suite.id without timestamps or server order. Termination is exactly EXHAUSTED, CHECK_SUITE_HORIZON, or MALFORMED: zero exact rows with at least 1000 distinct suites is UNKNOWN_MANUAL/CHECK_SUITE_HORIZON and zero mutations; zero exact rows with fewer than 1000 suites plus exhausted pagination is proven absence. history-horizon-1000.json is the mandatory exact oracle.", "The API's 1000-suite bound makes a full horizon distinguishable from proof of absence."],
  ["REQ-017", "MUST", "Historical proof MUST bind exact repository, tag, source, CI run/attempt, coordinator run/attempt/workflow SHA/check and protected main. Every base...head comparison accepts only identical with zero counters or ahead with ahead_by>=1 and behind_by=0; behind, diverged, inconsistent counters, malformed ref/SHA, API error, or source-to-coordinator-to-main discontinuity fails. Time/recency never selects authority.", "A complete forward ancestry chain is required for replay-safe reuse."],
  ["REQ-018", "MUST", "Dispatch MUST require GitHub API 2026-03-10 HTTP 200 and its direct workflow_run_id; 204, missing details, timeout, connection loss, malformed/5xx, or list-based correlation is UNKNOWN_MANUAL with no redispatch. Immediate direct GET is observation one. Verifier polling uses injected monotonic integer milliseconds, start-inclusive GET, exclusive start+1800000 deadline, 5000 interval, <=360 observations and immediate terminal success. Dispatch-receipt polling uses start+300000, <=60 observations. Identity/attempt drift, clock error, API error, unsupported/non-success state or timeout fails without real sleeps in tests.", "Direct run identity and deterministic polling avoid list-time races."],
  ["REQ-019", "MUST", "Workflow paths, job names, top-level and job permission maps MUST equal workflow-permissions-v1.json exactly. Unspecified scopes are none; no job combines id-token:write with actions:write or checks:write; candidate receives no GITHUB_TOKEN; publisher mutation writers cannot write checks or dispatch; receipt writers cannot publish; recover-release-v068 retains only its byte-identical temporary exception until PR #99 removes it.", "A machine-parsed map prevents privilege accretion and publisher self-authorization."],
  ["REQ-020", "MUST", "After signed authorization settles, the coordinator MUST create/re-read one handoff and one pre-dispatch claim, issue exactly one publisher dispatch, accept only the direct HTTP 200 run ID, immediately validate its path/ref/SHA/run attempt, and only then create a coordinator-signed closed dispatch receipt matching publisher-dispatch-receipt-v1.schema.json. The receipt binds claim/handoff/authorization/dispatch digests and the exact publisher run ID/attempt. Publisher cannot create or update it; a manual, independent or rerun attempt lacking its own exact receipt fails before mutation.", "Binding the server-returned run ID after dispatch closes the manual-dispatch race in v1.8."],
  ["REQ-021", "MUST", "Dispatch receipt is sequence zero. Each publication mutation MUST be followed by exactly one independently read-back, coordinator-signed, append-only receipt matching publisher-mutation-receipt-v1.schema.json before the next mutation. Sequence starts 1, increments by one, previous_receipt_sha256 links exactly, and each receipt contains one closed mutation target. Exact duplicates are read-only idempotent; conflicting sequence/body, gap, reorder, orphan, duplicate identity, missing/mismatched readback, or ambiguous receipt write is UNKNOWN_MANUAL. Publisher writers have no receipt-write authority.", "A hash-linked receipt journal makes partial multi-system publication explainable without self-authorization."],
  ["REQ-022", "MUST", "The state machine is monotonic: UNCLAIMED permits one claim; the same uninterrupted attempt may dispatch once; exact receipt permits reuse; preexisting claim without receipt, receipt without claim, duplicate/conflict, timeout, 5xx, connection loss, process death, or any unprovable mutation becomes UNKNOWN_MANUAL. No automatic code may leave UNKNOWN_MANUAL, redispatch, overwrite/update/delete a claim or receipt, move/delete a tag, replace an object/asset/package, fabricate success, or claim exactly-once delivery.", "Unknown writes cannot be safely inferred or retried."],
  ["REQ-023", "MUST", "Publish Release v2 MUST execute protected-main helper code only and never candidate source. Admission validates exact receipt/run/attempt/ref/SHA and three exact artifact reads. Mutation writers and receipt writers execute the fixed serial chain: draft release, image, chart, fourteen exact assets, final release; before/after every step they revalidate authorization, prior receipts, tag/source/main, archives and actual target. Ambiguity revokes unused capabilities, freezes the digest, emits signed incident evidence, and requires read-only reconciliation plus a new forward release; no destructive rollback is allowed.", "Protected serial publication contains compromised candidate code and non-transactional failure."],
  ["REQ-024", "MUST", "Before the corrective merge, GitHub workflow IDs 341194538, 318365668 and 318365667 MUST be disabled; deployment-controller access to the six legacy Nexus/OVH secret names and underlying identities MUST be removed/revoked; repository routing through the general codicarium runner group MUST be removed; and all new roles must bind only v2 paths/main/repository ID. The PR deletes old paths. Acceptance requires disabled states, absent paths, absent legacy credentials/routing, and bounded negative dispatch/rerun proof that no executing run/publication authority returns. Old workflows or outputs are never re-enabled or accepted.", "Historical reruns otherwise retain old GITHUB_TOKEN, OIDC, registry and storage authority."],
  ["REQ-025", "MUST", "v0.6.13/ad52dfcbc45d71eccad1d49fbd905161af7a44b1 is permanently retired in every automated/manual mutation/recovery/helper entry point and rejected by tag OR source before mutation. After the issue #93 corrective merge at reviewed R descended from d3565f5, release-plan uses v0.6.13 only as version base, reviews v0.6.13..R, and allocates exactly v0.6.14 at R. Any mismatch or v0.6.13 resume fails without moving/deleting/overwriting a tag.", "Only a forward release can execute repaired policy."],
  ["REQ-026", "MUST", "Implementation MUST use linked P0 issues and protected PRs in this dependency order: codicarium-actions protocol/client/fixtures; vault-config exact broker and v2 publisher identities; runner-config broker/service and Runner Platform v2 profiles; infra centrally owned DeploymentGrant/Profile component; optional app-config bootstrap-only wiring; organization runner/OIDC/secret fences; then deployment-controller v2 workflow repair pinned to immutable prerequisite SHAs. Repository content never chooses identities, groups, namespaces, permissions, keys or profiles.", "Explicit ownership preserves .codicarium and DeploymentGrant as the control-plane authority."],
  ["REQ-027", "MUST", "The broker runtime MUST match the annex: runner-config component artifact-capability; Application artifact-capability-codicarium; release/service/ServiceAccount in namespace artifact-capability; AppProject repo-runner-config-dev; centrally owned Profile artifact-capability-path-helm and Grant runner-config-dev; internal-only ClusterIP endpoint https://artifact-capability.artifact-capability.svc.cluster.local:8443; exposure class no-ingress; cert-manager TLS for the exact service DNS SAN; and no Ingress, HTTPRoute, LoadBalancer, NodePort or external-DNS object. Before three replicas, PDB or N-1 testing, infra MUST provide at least three eligible schedulable nodes and prove sufficient remaining-two-node capacity; then required hostname separation, maxSkew=1 DoNotSchedule and PDB minAvailable=2 apply. The scoped Vault role codicarium-dev-artifact-capability reads only the two exact object-store paths. Candidate scale set codicarium-v2-artifact-capability in arc-runners-v2-untrusted uses group codicarium-ci-artifact-capability, exact five labels, kata-clh-runtime-rs, min 0/max 1, and standard NetworkPolicy default-deny with DNS TCP/UDP 53 only to 10.43.0.10/32 plus TCP 8443 only through one peer containing both the exact broker namespaceSelector and podSelector; separate selector peers are forbidden. Broker network, metrics, alerts and audit match the annex; N-1 tests prove continuity and no token reuse or pending-state promotion.", "The shared authorization boundary needs explicit deployability, isolation, availability and central namespace/profile authority grounded in the actual Flannel cluster."],
  ["REQ-028", "MUST", "Rollout MUST first prove at least three eligible schedulable nodes and sufficient N-1 capacity, then render and validate all cross-repo GitOps state, deploy broker/runner at zero release traffic, and prove internal service DNS/TLS, absence of ingress/external exposure, OIDC, conditional-create, readback, concurrency, size/TTL, exact standard-NetworkPolicy positive and negative egress, teardown, alerts and node-loss N-1. Only then may workflow/credential fences be applied and the deployment repair merged. Rollback is fail-closed: disable v2 release workflows and revert Git desired state to last reviewed versions; never restore old credentials/workflows/routing or resume v0.6.13.", "A staged, forward-only rollback avoids lock-in to the insecure historical path and refuses an unavailable topology."],
  ["REQ-029", "MUST", "Protected PR validation MUST retain exactly test, lint, chart, integration, supply-chain from GitHub Actions app ID 15368 at one up-to-date head SHA. New protocol/archive/canonical/selector/horizon/polling/receipt/retirement/permission suites are hermetic under supply-chain; actionlint/validate-repository under lint; existing suites remain. CI supply-chain candidate execution MUST lose all reusable Nexus/storage authority and use only centrally prefetched immutable inputs or the exact credentialless capability boundary before merge.", "The repair is accepted through protected checks, not live experimentation."],
  ["REQ-030", "MUST", "Post-merge acceptance MUST emit one closed object validating release-live-evidence-v1.schema.json and the semantic chain: exact five checks/app ID/head, v0.6.14 tag/source, all coordinator/verifier/attester/claim/receipt/publisher identities, candidate and authorization objects, handoff/dispatch values, eighteen ordered mutation receipts, registry image/chart digests, final non-draft release, exactly fourteen ordered assets, and the old-workflow retirement proof. Missing/mismatched state is FAIL, never GO.", "Verifier success alone did not prove a public release in the failed production run."],
  ["REQ-031", "MUST", "Follow-up MUST obey follow-up-order-v1.json exactly: issue #93 repair/retirement, verified public v0.6.14/full evidence, issue #98 v0.6.8 success/eight-asset readback, rebased five-check PR #99 merge/workflow absence/issue close, then rebased five-check PR #94 merge. Any stale base, mixed check SHA, absent evidence, or #99/#94 v0.6.13 trigger/resume is rejected.", "A single total order removes the v1.8 ambiguity and prevents another unpublished tag."],
  ["REQ-032", "MUST", "Administrator ruleset evidence remains external manual/council evidence only at administrator-ruleset-evidence-v2.json, exactly 4024 bytes/SHA-256 55dbee3772ce06d0af59df8cb21d6862d4d167470065e2580ff9adb3d28efb58 captured for d3565f5. The gate independently verifies active branch/tag rulesets, no bypass, immutable tags and exactly five required checks. Repository CI only proves runtime non-consumption and never opens, imports, fetches, references, or treats the fixture/sidecars as authorization.", "Administrator evidence cannot become a repository-controlled authorization input."],
].map(([id, priority, statement, rationale]) => ({ id, priority, statement, rationale }));

const acceptanceCriteria = [
  ["AC-001", ["REQ-001", "REQ-002"], "Given all live default branches and landed provenance, baseline validation matches every exact SHA/path/blob before implementation; a mismatch returns to focused spec review."],
  ["AC-002", ["REQ-003", "REQ-004"], "Given a v0.6.14 candidate, only v2 protected-main workflows execute policy and candidate code runs in a destroyed credentialless broker-only sandbox."],
  ["AC-003", ["REQ-005", "REQ-006", "REQ-007", "REQ-008"], "Given mint/create/read/readback requests, every closed schema, claim, key, operation, limit, TTL and atomicity rule passes; all expansion/replay/race/ambiguity cases fail without a second write."],
  ["AC-004", ["REQ-009", "REQ-010"], "Given the two candidate archives, protected code produces schema-valid evidence with separate capabilities and exact safe archive bytes; every unsafe/noncanonical/cross-field mutation fails."],
  ["AC-005", ["REQ-011", "REQ-012", "REQ-013"], "Given verified archive bytes, the attester signs only protected-derived evidence and independent canonicalizers reproduce every JSON, digest and tuple vector exactly."],
  ["AC-006", ["REQ-014", "REQ-015", "REQ-016"], "Given live/adversarial Check Runs across paginated history, exact external-ID-first selection accepts the canonical URL once, rejects duplicates/malformed data, proves absence only below the 1000-suite horizon, and otherwise returns UNKNOWN_MANUAL."],
  ["AC-007", ["REQ-017", "REQ-018"], "Given historical ancestry and direct dispatch responses, only a complete forward chain and direct HTTP-200 run identity pass deterministic bounded polling."],
  ["AC-008", ["REQ-019"], "A workflow parser finds exactly the annex path/job/permission map, no unlisted scope, no mixed signing/write job, no candidate token, and no publisher self-authorization."],
  ["AC-009", ["REQ-020", "REQ-021", "REQ-022"], "The coordinator receipt is created only after exact returned publisher identity; manual/rerun publishers fail; crash/duplicate/conflict tests maintain a monotonic hash-linked receipt chain or UNKNOWN_MANUAL with zero redispatch."],
  ["AC-010", ["REQ-023"], "The publisher validates admission and performs the fixed serial write/readback/receipt chain without executing candidate code; any uncertain step stops all later writes and requires forward remediation."],
  ["AC-011", ["REQ-024", "REQ-025"], "All three historical workflow IDs are disabled, paths/credentials/routing are absent, bounded negative tests cannot execute them, v0.6.13 is rejected everywhere, and only v0.6.14 at reviewed R is allocated."],
  ["AC-012", ["REQ-026", "REQ-027", "REQ-028"], "Ordered protected cross-repo PRs first establish three-node N-1 capacity, then deploy the exact internal-only broker/runner/control-plane state; render, no-ingress, standard-NetworkPolicy isolation, live security, observability and node-loss tests pass; rollback remains fail-closed."],
  ["AC-013", ["REQ-029"], "All five protected checks from app ID 15368 succeed on one current head and hermetic CI exposes no reusable release/storage credential to candidate execution."],
  ["AC-014", ["REQ-030"], "The final live evidence validates structurally and semantically against all GitHub, registry and receipt readbacks; any missing or inconsistent field blocks GO."],
  ["AC-015", ["REQ-031"], "Live issue/PR/release events match the exact total order and neither later PR can trigger or resume v0.6.13."],
  ["AC-016", ["REQ-032"], "An external council recomputes administrator evidence and live rulesets while repository CI proves only runtime non-consumption."],
].map(([id, requirement_ids, outcome]) => ({
  id,
  requirement_ids,
  scenario: `Given the frozen v1.9 contract and its exact inputs, When ${id} is evaluated, Then ${outcome}`
}));

const testPlan = [
  ["TST-001", "integration", ["REQ-001", "REQ-002"], "Re-read all six remote heads, PR #100 six-path diff, and PR #97 blobs; fail on any mismatch before branch work."],
  ["TST-002", "integration", ["REQ-003", "REQ-004"], "Parse v2 workflows and run sandbox negative probes for token/env/socket/service-account/host/shared-state/egress access plus success/cancel/node-loss teardown."],
  ["TST-003", "integration", ["REQ-005", "REQ-006", "REQ-007"], "Validate OpenAPI/schema and fixed Ed25519 JWS fixture; mutate every OIDC claim/header/key/operation/limit/expiry/rotation edge and assert exact rejection."],
  ["TST-004", "integration", ["REQ-008"], "Run 100 concurrent redemptions and fault injection at mint, ledger reserve, conditional create, backend response, readback and ledger commit; prove one create maximum and zero automatic retries."],
  ["TST-005", "unit", ["REQ-009", "REQ-010"], "Compare checked-in tar/zstd bytes/hashes with two independent readers; exercise every link/path/header/order/frame/limit/evidence/schema/cross-field negative fixture."],
  ["TST-006", "integration", ["REQ-011", "REQ-012", "REQ-013"], "Prove attester checkout/execution closure and exact capability set; independent JavaScript and Python canonicalizers match raw/JCS bytes, SHA, digest-base64url, tuple-base64url and external IDs."],
  ["TST-007", "unit", ["REQ-014", "REQ-015", "REQ-016"], "Exercise live URL 97655710504, URL mutation matrix, external-ID poison/duplicate cases, three-page 250-run order fixture and exact ten-page 1000-suite horizon fixture."],
  ["TST-008", "unit", ["REQ-017", "REQ-018"], "Test accepted/rejected compare vectors and fake-clock direct-dispatch polling for 200/204/timeout/5xx/lost/malformed/identity drift without run lists or real sleep."],
  ["TST-009", "integration", ["REQ-019"], "Parse every named workflow/job into normalized permission sets and data-plane capabilities; reject any extra/missing path/job/scope or forbidden privilege combination."],
  ["TST-010", "integration", ["REQ-020", "REQ-022"], "Fault-inject claim/dispatch/direct-GET/receipt boundaries and manual/rerun identities; assert receipt only after exact 200 run, zero redispatch and UNKNOWN_MANUAL on ambiguity."],
  ["TST-011", "integration", ["REQ-021", "REQ-023"], "Execute the fixed 18-mutation journal with readback faults, duplicates, conflicts, gaps, reorder, process kills and partial publication; prove strict previous-hash chain and no subsequent write after uncertainty."],
  ["TST-012", "e2e", ["REQ-024", "REQ-025"], "Enumerate old workflow/helper/manual/recovery entry points, prove IDs disabled/paths and credentials/routing absent, perform bounded negative dispatch/rerun checks, and verify v0.6.13 rejection plus v0.6.14 forward allocation."],
  ["TST-013", "e2e", ["REQ-026", "REQ-027", "REQ-028"], "Using the explicit cluster context, first prove at least three eligible nodes and remaining-two-node capacity; validate each cross-repo PR/render/pin; prove the service is ClusterIP/no-ingress; then test internal DNS/TLS/OIDC/Vault/conditional storage and the exact standard-NetworkPolicy positive path. Negative probes MUST deny other pods in the artifact-capability namespace and same-labeled pods in other namespaces, as well as every non-DNS/non-broker destination. Finally prove runner teardown, metrics/alerts and three-node N-1 behavior."],
  ["TST-014", "integration", ["REQ-029"], "Run repository test-release-flow, actionlint, validate-repository, protocol conformance and static credential-flow scans; verify exactly five protected checks/app ID/same current head."],
  ["TST-015", "manual", ["REQ-030", "REQ-031"], "After merge, collect schema-validated live evidence and independently read back all 14 assets, registries, 18 receipts, workflow retirement and strict issue #98/PR #99/PR #94 order."],
  ["TST-016", "manual", ["REQ-032"], "Outside repository CI, recompute the 4024-byte evidence/hash and live branch/tag rulesets; separately scan repository runtime for prohibited consumption without opening the external fixture."],
].map(([id, type, requirement_ids, approach]) => ({ id, type, requirement_ids, approach }));

const mapping = new Map();
for (const req of requirements) mapping.set(req.id, { acceptance_ids: [], test_ids: [] });
for (const ac of acceptanceCriteria) for (const req of ac.requirement_ids) mapping.get(req).acceptance_ids.push(ac.id);
for (const test of testPlan) for (const req of test.requirement_ids) mapping.get(req).test_ids.push(test.id);
const traceability = requirements.map((req) => ({
  requirement_id: req.id,
  acceptance_ids: mapping.get(req.id).acceptance_ids,
  test_ids: mapping.get(req.id).test_ids,
  review_checks: [`Review ${req.id} against exact annex ${annexSha} and its trust-boundary rationale.`],
  validation_checks: [`Execute mapped acceptance and test oracles for ${req.id}; any UNKNOWN_MANUAL remains non-authorizing.`]
}));

const spec = {
  meta: {
    id: "SPEC-deployment-controller-issue-93-release-proof-v1-9",
    title: "Credentialless protected-main release authorization and forward-only issue #93 recovery",
    author: "Codex release manager",
    created_at: "2026-08-25T05:30:00Z",
    version: "1.9.0-exact-candidate"
  },
  feature: {
    problem_statement: "At protected main d3565f534b2f64585c3e15e35d8d645449f4f09d, Automatic Release run 32798160604 dispatched successful Release Verify 32798188729 for immutable unpublished v0.6.13/ad52dfcbc45d71eccad1d49fbd905161af7a44b1 but rejected canonical Check Run URL https://github.com/codicarium/deployment-controller/runs/97655710504. The historic workflows also combine candidate code with reusable storage/registry/OIDC authority and remain rerunnable, so a URL-only fix would preserve a release-boundary vulnerability.",
    goals: [
      "Implement an exact one-object capability boundary and isolated candidate runner before release publication resumes.",
      "Bind protected-main coordinator, attester and publisher to canonical identities, direct run IDs and append-only read-back receipts.",
      "Retire all historical privileged workflow IDs and reusable credentials, then publish only forward v0.6.14 with complete evidence."
    ],
    non_goals: [
      "Move, delete, retag, resume, publish or fabricate success for v0.6.13.",
      "Allow repository content to choose identities, permissions, namespaces, profiles, groups, keys or capability limits.",
      "Use GitHub-hosted artifacts, shared runner directories, administrator evidence or mutable workflow/tag names as authorization."
    ],
    scope_in: [
      "codicarium-actions capability contract/client/codec, vault-config identities, runner-config broker and runners, infra DeploymentGrant/Profile, optional app-config bootstrap, organization runner/secret policy, and deployment-controller v2 release workflows.",
      "Machine-exact schemas and fixtures in feature-spec.v1.9.annex.json at SHA-256 " + annexSha,
      "Forward v0.6.14 acceptance and strict issue #98, PR #99 and PR #94 follow-up ordering."
    ],
    scope_out: [
      "Repository, GitHub, release, registry, DNS, Vault or cluster mutation during the spec/council stage.",
      "Argo authorization Phase 0 changes until issue #93 release safety and blockers #1146/#1192 are resolved."
    ]
  },
  requirements,
  acceptance_criteria: acceptanceCriteria,
  test_plan: testPlan,
  traceability,
  quality_gates: { spec_review_required: true, testability_required: true, traceability_required: true },
  council: {
    perspectives: [
      { role: "planner", summary: "Review exact cross-repository dependency order, ownership, rollback and complete traceability." },
      { role: "security", summary: "Review capability tokens, candidate isolation, publisher non-self-authorization, old-workflow fencing and ambiguity behavior." },
      { role: "tech_lead_qa", summary: "Recompute every schema/fixture/hash/tuple and verify executable failure oracles and live evidence." },
      { role: "tech_lead_devops", summary: "Review deployability, GitOps ownership, Vault/DNS/TLS/network/runner/HA/observability and rollout gates." }
    ],
    consensus_summary: "Draft only. Exact-hash council must return unanimous GO before code. A GO authorizes ordered implementation of the listed prerequisites; it does not assert they already exist or bypass their protected PR, live conformance, release or deployment gates.",
    open_questions: []
  }
};

const specBytes = jsonBytes(spec);
fs.writeFileSync(path.join(runDir, "feature-spec.v1.9.draft.json"), specBytes);
console.log(JSON.stringify({ annex_sha256: annexSha, annex_byte_length: annexBytes.length, spec_sha256: sha256(specBytes), spec_byte_length: specBytes.length, requirements: requirements.length, acceptance_criteria: acceptanceCriteria.length, tests: testPlan.length, traceability: traceability.length }, null, 2));
