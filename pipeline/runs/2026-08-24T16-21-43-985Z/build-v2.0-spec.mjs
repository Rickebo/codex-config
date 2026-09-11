import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import zlib from "node:zlib";

const runDir = "/home/rickebo/.codex/pipeline/runs/2026-08-24T16-21-43-985Z";
const fixtureDir = path.join(runDir, "fixtures-v2.0");
const immutableFixtureDir = path.join(runDir, "fixtures-v1.9");
fs.mkdirSync(fixtureDir, { recursive: true });

const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
const writeJson = (name, value) => fs.writeFileSync(path.join(fixtureDir, name), jsonBytes(value));
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fileRecord = (name) => {
  const bytes = fs.readFileSync(path.join(fixtureDir, name));
  return { path: `fixtures-v2.0/${name}`, byte_length: bytes.length, sha256: sha256(bytes) };
};
// RFC 8785 serialization. Number rendering and UTF-16 property ordering are
// deliberately delegated to the ECMAScript operations required by the RFC.
// This is adapted from canonicalize 4.0.0 (Apache-2.0), with JSON-only input
// enforcement so fixtures cannot silently omit undefined or symbolic values.
const hasLoneSurrogate = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
};
const jcs = (value, seen = new Set()) => {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JCS number must be finite");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) throw new Error("JCS string contains a lone surrogate");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined || typeof value === "symbol") {
    throw new Error("unsupported JCS fixture type");
  }
  if (seen.has(value)) throw new Error("JCS fixture contains a circular reference");
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new Error("JCS array contains a sparse element");
    }
    result = `[${value.map((item) => {
      if (item === undefined || typeof item === "symbol") throw new Error("JCS array contains a non-JSON value");
      return jcs(item, seen);
    }).join(",")}]`;
  } else {
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      if (hasLoneSurrogate(key)) throw new Error("JCS property name contains a lone surrogate");
      const item = value[key];
      if (item === undefined || typeof item === "symbol") throw new Error("JCS object contains a non-JSON value");
      parts.push(`${JSON.stringify(key)}:${jcs(item, seen)}`);
    }
    result = `{${parts.join(",")}}`;
  }
  seen.delete(value);
  return result;
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
  "codicarium/deployment-controller": "74defd205658b8db4b90a80cc7f8aa05dfe8a193",
  "codicarium/codicarium-actions": "9545b5a66498f67667e57d021507ac060fd016b6",
  "codicarium/runner-config": "9625e442a12c721e89250812f3d079b09833ccb0",
  "codicarium/vault-config": "59b06ef256b5f3a5956f630240e95f00b22a9d07",
  "codicarium/app-config": "e085a399bedc830b537431e3bcd5e41b677c2812",
  "codicarium/infra": "40073c068a9cf8ff4c1e625b97e09fda31b40637",
  "codicarium/postgres-config": "d5ccccfcfc5bae4d099f1848b68e07dcaa679d62"
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
      archive_sha256: sha256(Buffer.from("candidate-image-archive-fixture", "utf8")),
      byte_length: "4096",
      capability_nonce: "0123456789abcdef0123456789abcdef",
      capability_expires_at: "2026-01-01T00:30:00Z",
      files: [
        { path: "deployment-controller-linux-amd64.spdx.json", size: "1", sha256: sha256(Buffer.from("image-amd64-sbom-fixture", "utf8")) },
        { path: "deployment-controller-linux-arm64.spdx.json", size: "1", sha256: sha256(Buffer.from("image-arm64-sbom-fixture", "utf8")) },
        { path: "deployment-controller.env", size: "1", sha256: sha256(Buffer.from("image-environment-fixture", "utf8")) },
        { path: "deployment-controller.oci.tar", size: "1", sha256: sha256(Buffer.from("image-oci-archive-fixture", "utf8")) }
      ]
    },
    "deployment-controller-verified-chart": {
      object_key: "artifacts/v1/orgs/255540067/repos/1303901324/releases/v0.6.14/sources/1111111111111111111111111111111111111111/runs/9003001/attempts/1/deployment-controller-verified-chart/fedcba9876543210fedcba9876543210.tar.zst",
      archive_sha256: sha256(Buffer.from("candidate-chart-archive-fixture", "utf8")),
      byte_length: "2048",
      capability_nonce: "fedcba9876543210fedcba9876543210",
      capability_expires_at: "2026-01-01T00:30:00Z",
      files: [
        { path: "deployment-controller-0.6.14.tgz", size: "1", sha256: sha256(Buffer.from("chart-package-fixture", "utf8")) },
        { path: "deployment-controller-chart.sha256", size: "1", sha256: sha256(Buffer.from("chart-digest-file-fixture", "utf8")) }
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
    image: { object_key: candidateEvidenceFixture.archives["deployment-controller-verified-image"].object_key, archive_sha256: candidateEvidenceFixture.archives["deployment-controller-verified-image"].archive_sha256, byte_length: "4096", nonce: "0123456789abcdef0123456789abcdef" },
    chart: { object_key: candidateEvidenceFixture.archives["deployment-controller-verified-chart"].object_key, archive_sha256: candidateEvidenceFixture.archives["deployment-controller-verified-chart"].archive_sha256, byte_length: "2048", nonce: "fedcba9876543210fedcba9876543210" }
  },
  authorization: {
    object_key: "artifacts/v1/orgs/255540067/repos/1303901324/releases/v0.6.14/sources/1111111111111111111111111111111111111111/runs/9003001/attempts/1/deployment-controller-signed-authorization/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.tar.zst",
    archive_sha256: sha256(Buffer.from("signed-authorization-archive-fixture", "utf8")),
    predicate_sha256: sha256(Buffer.from("signed-authorization-predicate-fixture", "utf8")),
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
    image: { registry: "docker-pull.nexus.int.codicarium.com", repository: "codicarium/deployment-controller", reference: "v0.6.14", digest: `sha256:${sha256(Buffer.from("published-image-fixture", "utf8"))}` },
    chart: { registry: "charts.nexus.int.codicarium.com", repository: "codicarium/deployment-controller", version: "0.6.14", digest: `sha256:${sha256(Buffer.from("published-chart-fixture", "utf8"))}` }
  },
  assets: assetNames.map((name, index) => ({ id: String(9400000 + index + 1), name, size: "1", sha256: sha256(Buffer.from(`legacy-asset-fixture-${index + 1}`, "utf8")) })),
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

// The canonical archive fixtures are immutable byte oracles carried forward
// from v1.9. The v2 generator copies and verifies them; it never regenerates
// or mutates the source oracles.
const copyImmutableFixture = (relative, expectedLength, expectedSha256) => {
  const source = path.join(immutableFixtureDir, relative);
  const destination = path.join(fixtureDir, relative);
  const bytes = fs.readFileSync(source);
  if (bytes.length !== expectedLength || sha256(bytes) !== expectedSha256) {
    throw new Error("immutable fixture mismatch: " + relative);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
};
copyImmutableFixture("canonical-archive-v1.tar", 3072, "fb7a260f46a361d9b90bf6371824f0b62dcabf99be09ab984a4fb6fcaeebda31");
copyImmutableFixture("canonical-archive-v1.tar.zst", 102, "5858457a000d6f7334053b51ba4f1106f1ee1e683ffc6bcf461af0fe9b3dc64b");
copyImmutableFixture("archive-input/alpha.txt", 6, "b6a98d9ce9a2d9149288fa3df42d377c3e42737afdcdaf714e33c0a100b51060");
copyImmutableFixture("archive-input/beta.txt", 5, "f2c82decdd7181cf98945929a62598db7e6b477e11f6e0eb0ae97020eff151ad");

// Retain the copied v1.9 prose only as an inert audit reference. It must not
// generate v2 files or hashes; the exact contract starts below.
if (false) {
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
fs.writeFileSync(path.join(runDir, "feature-spec.v2.0.annex.json"), annexBytes);
const annexSha = sha256(annexBytes);

const requirements = [
  ["REQ-001", "MUST", `Specification and branch baselines MUST begin at exactly ${Object.entries(baselines).map(([repo, sha]) => `${repo}=${sha}`).join(", ")}. Any upstream change before v2.0 exact-hash council freeze requires focused re-audit of that repository and an updated annex; merged prerequisite PRs then become the recorded successor baselines.`, "Exact starting points prevent stale security conclusions while allowing the ordered prerequisite implementation itself to advance main."],
  ["REQ-002", "MUST", "The PR #100 provenance invariant MUST remain base ca55729de7a58bef5b49ebdce8c28773bb7e1b2e to d3565f534b2f64585c3e15e35d8d645449f4f09d with exactly six changed paths: .github/workflows/automatic-release.yaml, .github/workflows/release.yaml, docs/releasing.md, hack/release-handoff-policy.js, hack/test-release-graph.py, hack/test-release-handoff-policy.js. The issue #93 change MUST reconcile all six. Until PR #99 removal, the three PR #97 blobs MUST remain byte-identical: recover-release-v068.yaml=5dfee56b27ccf791c3ab024145b63539ad1d1a3a, publisher-subject-evidence.md=d6c9572818ce2a80ea1cecd7aacd3bc68f91b90e, test-recover-release-v068.py=b6daa1135ffa9a49921cc1d8c677e1e5da451592.", "Preserving known landed behavior avoids accidental recovery regressions during the release repair."],
  ["REQ-003", "MUST", "The corrective PR MUST add protected-main-only .github/workflows/automatic-release-v2.yaml, release-verify-v2.yaml, and publish-release-v2.yaml and delete the corresponding old paths. Dispatch MUST use refs/heads/main, returned runs MUST have exact v2 workflow path/ref and captured protected-main head SHA, and candidate tag/source remain validated data only; no workflow may execute policy selected from a tag or raw candidate SHA.", "New workflow paths create new workflow IDs and eliminate tag-selected privileged policy."],
  ["REQ-004", "MUST", "Candidate source MUST run only in a destroyed-after-use Runner Platform v2 sandbox with no GITHUB_TOKEN, static secret, OIDC, registry or storage credential, signing key, GitHub write or dispatch scope, Docker host socket, service-account token, hostPath, shared runner directory, or general egress. Centrally reviewed code MUST prefetch digest-pinned inputs read-only, pass only two independent exact-object create capabilities, terminate candidate processes, and destroy the pod/PVC before any trusted credentialed step.", "Repository identity does not make candidate code trusted."],
  ["REQ-005", "MUST", `The capability protocol, schemas, client, canonical archive codec, and conformance fixtures MUST be implemented under codicarium-actions paths frozen by annex SHA ${annexSha}; runner-config MUST own the issuer/service and isolated runner. The exact API is POST /v1/capabilities, PUT /v1/object, GET /v1/object, and POST /v1/object/readback at the internal-only endpoint https://artifact-capability.artifact-capability.svc.cluster.local:8443 with the closed schemas and headers in the annex; neither callers nor repository content may choose another endpoint, profile, subject, key prefix, operation, limit, issuer, or group.`, "A reviewed shared protocol is required before credentialless candidate transfer can be implemented safely."],
  ["REQ-006", "MUST", "Mint MUST authenticate a GitHub OIDC token no older than 300 seconds with issuer token.actions.githubusercontent.com, audience codicarium-artifact-capability, organization ID 255540067, repository ID 1303901324, exact allowed v2 workflow path, refs/heads/main, workflow SHA, run ID and attempt. Capabilities MUST be Ed25519 compact JWS with exactly the annex header/claims, 1800-second lifetime, 30-second skew, one operation/object, and the annex JWKS rotation rules; duplicate/unknown claims, another algorithm, padding, bad JCS, stale or ambiguous mint fail closed.", "Machine-exact claims and rotation prevent replay, algorithm confusion, and bearer expansion."],
  ["REQ-007", "MUST", "The service MUST derive keys matching the annex grammar and issue distinct JWS, nonce/jti, object key, ledger entry, and upload call for image and chart. Limits MUST be image 1073741824 compressed/4294967296 decompressed, chart and signed authorization 67108864 compressed/268435456 decompressed. Candidate receives exactly two create capabilities; attester receives two exact reads and one signed-authorization create; publisher receives exactly three exact reads. No token grants list, prefix, range, redirect, overwrite, delete, alternate key, broad presigned URL, backend credential, registry authority, or delegation.", "Separate one-object capabilities make effective authority mechanically bounded."],
  ["REQ-008", "MUST", "Upload MUST require the exact annex headers and durable linearizable jti reservation plus backend-native atomic create-if-absent. HTTP 201 is allowed only after full stored-byte readback, SHA-256/length verification, decompressed-limit verification, and terminal ledger persistence. Exact read MUST spool and verify the full object before returning bytes; readback returns metadata only. Wrong key, expiry, replay, race, oversize, timeout, process loss, backend conflict, mismatched readback, or inability to prove whether state changed is UNKNOWN_MANUAL with no automatic retry, second mint/upload, overwrite, delete, or replacement.", "Ambiguous object writes cannot safely be retried."],
  ["REQ-009", "MUST", "Authoritative candidate evidence MUST validate against fixtures-v2.0/candidate-evidence-v1.schema.json, be at most 32768 RFC 8785 bytes, contain exactly two archive records with independent nonces/expiries/receipts and the fixed path-sorted file sets, and be constructed by protected wrapper code after candidate termination from broker receipts and canonical archive observations. Candidate code cannot author the authoritative object. Schema-valid but cross-field-inconsistent keys, source, runs, nonces, lengths, files, or hashes MUST fail semantic validation.", "A closed, independently derived evidence object prevents forged candidate metadata from becoming authority."],
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
  scenario: `Given the frozen v2.0 contract and its exact inputs, When ${id} is evaluated, Then ${outcome}`
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
    id: "SPEC-deployment-controller-issue-93-release-proof-v2-0",
    title: "Credentialless protected-main release authorization and forward-only issue #93 recovery",
    author: "Codex release manager",
    created_at: "2026-08-25T05:30:00Z",
    version: "2.0.0-exact-candidate"
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
      "Machine-exact schemas and fixtures in feature-spec.v2.0.annex.json at SHA-256 " + annexSha,
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
fs.writeFileSync(path.join(runDir, "feature-spec.v2.0.draft.json"), specBytes);
}

// v2.0 exact override. The copied v1.9 generator above preserves the previous
// byte oracles; this section replaces every authority-bearing v2 output.
const nullableV20 = (schema) => ({ oneOf: [schema, { type: "null" }] });
const zeroSha256V20 = "0".repeat(64);
const nonnegativeDecimalV20 = { type: "string", pattern: "^(0|[1-9][0-9]*)$" };
const sequenceV20 = { type: "string", pattern: "^(0|[1-9]|1[0-9])$" };
const writeRawV20 = (name, value) => fs.writeFileSync(path.join(fixtureDir, name), Buffer.from(value, "utf8"));
const digestJcsV20 = (value) => sha256(Buffer.from(jcs(value), "utf8"));

const jcsConformanceFixtureV20 = {
  schema: "codicarium.rfc8785-conformance/v1",
  source: "RFC 8785 sections 3.2.2-3.2.3 and Appendix B boundary cases",
  positive_vectors: [
    { name: "rounded-binary64", input_json: "333333333.33333329", expected_jcs: "333333333.3333333" },
    { name: "positive-exponent", input_json: "1E30", expected_jcs: "1e+30" },
    { name: "strip-trailing-zero", input_json: "4.50", expected_jcs: "4.5" },
    { name: "plain-small-number", input_json: "2e-3", expected_jcs: "0.002" },
    { name: "negative-exponent", input_json: "0.000000000000000000000000001", expected_jcs: "1e-27" },
    { name: "negative-zero", input_json: "-0", expected_jcs: "0" },
    { name: "smallest-positive-binary64", input_json: "5e-324", expected_jcs: "5e-324" },
    { name: "largest-finite-binary64", input_json: "1.7976931348623157e308", expected_jcs: "1.7976931348623157e+308" },
    { name: "decimal-exponent-lower-bound", input_json: "1e-6", expected_jcs: "0.000001" },
    { name: "exponent-below-lower-bound", input_json: "1e-7", expected_jcs: "1e-7" },
    { name: "decimal-exponent-upper-bound", input_json: "1e20", expected_jcs: "100000000000000000000" },
    { name: "exponent-at-upper-bound", input_json: "1e21", expected_jcs: "1e+21" },
    {
      name: "utf16-property-order",
      input_json: String.raw`{"\u20ac":"Euro Sign","\r":"Carriage Return","\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One","\ud83d\ude00":"Emoji","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis"}`,
      expected_jcs: "{\"\\r\":\"Carriage Return\",\"1\":\"One\",\"\":\"Control\",\"ö\":\"Latin Small Letter O With Diaeresis\",\"€\":\"Euro Sign\",\"😀\":\"Emoji\",\"דּ\":\"Hebrew Letter Dalet With Dagesh\"}"
    },
    {
      name: "valid-non-bmp-value",
      input_json: String.raw`{"emoji":"\ud83d\ude00"}`,
      expected_jcs: "{\"emoji\":\"😀\"}"
    },
    {
      name: "utf16-not-unicode-scalar-order",
      input_json: String.raw`{"\ue000":"bmp","\ud83d\ude00":"non-bmp"}`,
      expected_jcs: "{\"😀\":\"non-bmp\",\"\":\"bmp\"}"
    },
    {
      name: "unicode-normalization-is-preserved",
      input_json: String.raw`{"A\u030a":"decomposed","\u00c5":"composed"}`,
      expected_jcs: "{\"Å\":\"decomposed\",\"Å\":\"composed\"}"
    }
  ],
  negative_vectors: [
    { name: "lone-high-surrogate", position: "value", utf16_code_units: ["d800"], outcome: "REJECT_INVALID_UNICODE" },
    { name: "lone-low-surrogate", position: "value", utf16_code_units: ["dc00"], outcome: "REJECT_INVALID_UNICODE" },
    { name: "high-surrogate-not-followed-by-low", position: "value", utf16_code_units: ["d800", "0061"], outcome: "REJECT_INVALID_UNICODE" },
    { name: "lone-high-surrogate-property", position: "key", utf16_code_units: ["d800"], outcome: "REJECT_INVALID_UNICODE" },
    { name: "nan", input_json: "NaN", outcome: "REJECT_NON_FINITE_NUMBER" },
    { name: "positive-infinity", input_json: "Infinity", outcome: "REJECT_NON_FINITE_NUMBER" },
    { name: "negative-infinity", input_json: "-Infinity", outcome: "REJECT_NON_FINITE_NUMBER" },
    { name: "overflow-to-infinity", input_json: "1e400", outcome: "REJECT_NON_FINITE_NUMBER" }
  ]
};
for (const vector of jcsConformanceFixtureV20.positive_vectors) {
  const actual = jcs(JSON.parse(vector.input_json));
  if (actual !== vector.expected_jcs) throw new Error(`RFC 8785 positive vector failed: ${vector.name}: ${actual}`);
}
for (const vector of jcsConformanceFixtureV20.negative_vectors) {
  let rejected = false;
  try {
    if (vector.input_json !== undefined) {
      jcs(JSON.parse(vector.input_json));
    } else {
      const invalid = String.fromCharCode(...vector.utf16_code_units.map((unit) => Number.parseInt(unit, 16)));
      jcs(vector.position === "key" ? { [invalid]: true } : invalid);
    }
  } catch { rejected = true; }
  if (!rejected) throw new Error(`RFC 8785 negative vector accepted: ${vector.name}`);
}
writeJson("jcs-rfc8785-conformance-v1.fixture.json", jcsConformanceFixtureV20);

const workflowContractV20 = {
  schema: "codicarium.issue93-workflow-permissions/v2",
  top_level_default: {},
  check_runs: {
    authority: false,
    use: "observation-only",
    permitted_scopes: ["checks:read"],
    forbidden_scopes: ["checks:write"]
  },
  workflows: {
    ".github/workflows/automatic-release-v2.yaml": {
      name: "Automatic Release v2",
      jobs: {
        plan: { contents: "read", actions: "read", checks: "read" },
        "claim-cas": { contents: "read", actions: "read", checks: "read" },
        "verifier-dispatch-reserve": { contents: "read", actions: "read" },
        "verifier-dispatch-write": { contents: "read", actions: "write" },
        "verifier-dispatch-commit": { contents: "read", actions: "read" },
        "verification-observe": { contents: "read", actions: "read", checks: "read" },
        "verification-authorize": { contents: "read", actions: "read", checks: "read", "id-token": "write" },
        "publisher-dispatch-reserve": { contents: "read", actions: "read" },
        "publisher-dispatch-write": { contents: "read", actions: "write" },
        "publisher-dispatch-commit": { contents: "read", actions: "read" }
      }
    },
    ".github/workflows/release-verify-v2.yaml": {
      name: "Release Verify v2",
      jobs: {
        preflight: { contents: "read", actions: "read", checks: "read" },
        prefetch: { contents: "read" },
        "candidate-capability-mint": { contents: "read", "id-token": "write" },
        "candidate-kata-job": {},
        "attester-capability-mint": { contents: "read", "id-token": "write" },
        attester: { contents: "read", actions: "read", checks: "read", "id-token": "write" }
      }
    },
    ".github/workflows/publish-release-v2.yaml": {
      name: "Publish Release v2",
      jobs: {
        admission: { contents: "read", actions: "read", checks: "read" }
      },
      static_expansion: "Exactly nineteen serial reserve -> target-write -> independently signed journal-commit triplets. Sequence 1 creates the tag; 2 creates the draft release; 3 publishes the image; 4 publishes the chart; 5..18 create the fourteen ordered assets; 19 finalizes the release."
    },
    ".github/workflows/ci.yaml": {
      name: "CI",
      top_level_permissions: { contents: "read" },
      jobs: { test: {}, lint: {}, chart: {}, integration: {}, "supply-chain": {} }
    }
  },
  invariants: [
    "All non-CI top-level permissions are {} and unspecified scopes are none.",
    "Check Runs are observation only; no v2 job has checks:write.",
    "A target writer cannot reserve, sign, or commit a journal entry.",
    "A signer or journal committer cannot mutate GitHub, Nexus, OCI, S3, or any release target.",
    "The candidate Kata Job receives no GITHUB_TOKEN, service-account token, proxy, public egress, reusable secret, registry authority, object-store authority, or signing key.",
    "All five retired privileged workflow paths are absent and have no entry in this active map."
  ]
};
const addPublisherTripletV20 = (sequence, slug, writerPermissions) => {
  const number = String(sequence).padStart(2, "0");
  const jobs = workflowContractV20.workflows[".github/workflows/publish-release-v2.yaml"].jobs;
  jobs[number + "-" + slug + "-reserve"] = { contents: "read", actions: "read" };
  jobs[number + "-" + slug + "-target-write"] = writerPermissions;
  jobs[number + "-" + slug + "-journal-commit"] = { contents: "read", actions: "read" };
};
addPublisherTripletV20(1, "tag-create", { contents: "write", actions: "read" });
addPublisherTripletV20(2, "draft-release-create", { contents: "write", actions: "read" });
addPublisherTripletV20(3, "image-publish", { contents: "read", actions: "read" });
addPublisherTripletV20(4, "chart-publish", { contents: "read", actions: "read" });
assetNames.forEach((unused, index) => addPublisherTripletV20(index + 5, "asset-" + String(index + 1).padStart(2, "0") + "-create", { contents: "write", actions: "read" }));
addPublisherTripletV20(19, "release-finalize", { contents: "write", actions: "read" });
writeJson("workflow-permissions-v1.json", workflowContractV20);

// Synthetic identities in the executable fixture are derived from immutable
// bytes instead of visually convenient repeated-character placeholders. The
// raw 697/436-byte v1 identity oracles below remain intentionally unchanged.
const concreteCandidateArchivesV20 = {};
for (const [purpose, archive] of Object.entries(candidateEvidenceFixture.archives)) {
  for (const file of archive.files) {
    const body = Buffer.from(`codicarium.issue93/v2 fixture body\n${purpose}\n${file.path}\n`, "utf8");
    file.size = String(body.length);
    file.sha256 = sha256(body);
  }
  const archiveObject = {
    schema: "codicarium.candidate-archive-object/v1",
    purpose,
    files: archive.files
  };
  const archiveBytes = Buffer.from(jcs(archiveObject), "utf8");
  archive.byte_length = String(archiveBytes.length);
  archive.archive_sha256 = sha256(archiveBytes);
  concreteCandidateArchivesV20[purpose] = {
    canonical_object_jcs_sha256: archive.archive_sha256,
    canonical_object_byte_length: archive.byte_length
  };
}
const candidateSourceRevisionV20 = sha256(Buffer.from(jcs({
  schema: "codicarium.candidate-source-revision-fixture/v1",
  repository: "codicarium/deployment-controller",
  tag: "v0.6.14",
  archives: concreteCandidateArchivesV20
}), "utf8")).slice(0, 40);
candidateEvidenceFixture.source_revision = candidateSourceRevisionV20;
for (const archive of Object.values(candidateEvidenceFixture.archives)) {
  archive.object_key = archive.object_key.replace(/\/sources\/[0-9a-f]{40}\//, `/sources/${candidateSourceRevisionV20}/`);
}
writeJson("candidate-evidence-v1.fixture.json", candidateEvidenceFixture);

tokenClaims.source_revision = candidateSourceRevisionV20;
tokenClaims.object_key = tokenClaims.object_key.replace(/\/sources\/[0-9a-f]{40}\//, `/sources/${candidateSourceRevisionV20}/`);
const capabilityClaimsJcsV20 = b64url(Buffer.from(jcs(tokenClaims), "utf8"));
const capabilitySigningInputV20 = Buffer.from(`${encodedHeader}.${capabilityClaimsJcsV20}`, "ascii");
const capabilitySignatureV20 = crypto.sign(null, capabilitySigningInputV20, privateKey);
capabilityJwsFixture.claims = tokenClaims;
capabilityJwsFixture.claims_jcs_base64url = capabilityClaimsJcsV20;
capabilityJwsFixture.signing_input_sha256 = sha256(capabilitySigningInputV20);
capabilityJwsFixture.signature_base64url = b64url(capabilitySignatureV20);
capabilityJwsFixture.compact_jws = `${encodedHeader}.${capabilityClaimsJcsV20}.${b64url(capabilitySignatureV20)}`;
writeJson("artifact-capability-jws-v1.fixture.json", capabilityJwsFixture);

const coordinatorWorkflowPathV20 = ".github/workflows/automatic-release-v2.yaml";
const verifierWorkflowPathV20 = ".github/workflows/release-verify-v2.yaml";
const publisherWorkflowPathV20 = ".github/workflows/publish-release-v2.yaml";
const reviewedWorkflowRevisionV20 = sha256(Buffer.from(jcs({
  schema: "codicarium.issue93-reviewed-workflow-fixture/v1",
  repository: "codicarium/deployment-controller",
  workflows: {
    [coordinatorWorkflowPathV20]: workflowContractV20.workflows[coordinatorWorkflowPathV20],
    [verifierWorkflowPathV20]: workflowContractV20.workflows[verifierWorkflowPathV20],
    [publisherWorkflowPathV20]: workflowContractV20.workflows[publisherWorkflowPathV20]
  }
}), "utf8")).slice(0, 40);

const releaseHandoffRawV20 = "{\"authorization_sha256\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"authorizer_run_attempt\":\"1\",\"authorizer_run_id\":\"9004001\",\"candidate_evidence_sha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"ci_run_attempt\":\"1\",\"ci_run_id\":\"9001001\",\"coordinator_check_run_id\":\"9002003\",\"coordinator_run_attempt\":\"1\",\"coordinator_run_id\":\"9002001\",\"kind\":\"publish-handoff\",\"publisher_revision\":\"2222222222222222222222222222222222222222\",\"repository\":\"codicarium/deployment-controller\",\"schema\":\"codicarium.release-identity/v1\",\"source_revision\":\"1111111111111111111111111111111111111111\",\"tag\":\"v0.6.14\",\"verifier_run_attempt\":\"1\",\"verifier_run_id\":\"9003001\"}";
const publisherDispatchRawV20 = "{\"authorizer_run_attempt\":\"1\",\"authorizer_run_id\":\"9004001\",\"handoff_check_run_id\":\"9004003\",\"handoff_sha256\":\"8abe528bb32aaa47f8fc496c3571d4b91248f3ebfe4c8be29463a25277bd9e88\",\"kind\":\"publisher-dispatch\",\"publisher_revision\":\"2222222222222222222222222222222222222222\",\"repository\":\"codicarium/deployment-controller\",\"schema\":\"codicarium.release-identity/v1\",\"source_revision\":\"1111111111111111111111111111111111111111\",\"tag\":\"v0.6.14\"}";
const releaseHandoffBytesV20 = Buffer.from(releaseHandoffRawV20, "utf8");
const publisherDispatchBytesV20 = Buffer.from(publisherDispatchRawV20, "utf8");
if (releaseHandoffBytesV20.length !== 697 || sha256(releaseHandoffBytesV20) !== "8abe528bb32aaa47f8fc496c3571d4b91248f3ebfe4c8be29463a25277bd9e88") throw new Error("release handoff raw oracle mismatch");
if (publisherDispatchBytesV20.length !== 436 || sha256(publisherDispatchBytesV20) !== "b150fa8dad70a207fb7a78f6a41ab1bc1430833ba70b86fdc2f08a13c7c11f3b") throw new Error("publisher dispatch raw oracle mismatch");
writeRawV20("release-handoff-v1.json", releaseHandoffRawV20);
writeRawV20("publisher-dispatch-v1.json", publisherDispatchRawV20);

const handoffIdentityBodySchemaV20 = closed(
  ["authorization_sha256", "authorizer_run_attempt", "authorizer_run_id", "candidate_evidence_sha256", "ci_run_attempt", "ci_run_id", "coordinator_check_run_id", "coordinator_run_attempt", "coordinator_run_id", "kind", "publisher_revision", "repository", "schema", "source_revision", "tag", "verifier_run_attempt", "verifier_run_id"],
  {
    authorization_sha256: sha64,
    authorizer_run_attempt: positiveDecimal,
    authorizer_run_id: positiveDecimal,
    candidate_evidence_sha256: sha64,
    ci_run_attempt: positiveDecimal,
    ci_run_id: positiveDecimal,
    coordinator_check_run_id: positiveDecimal,
    coordinator_run_attempt: positiveDecimal,
    coordinator_run_id: positiveDecimal,
    kind: { const: "publish-handoff" },
    publisher_revision: sha40,
    repository: { const: "codicarium/deployment-controller" },
    schema: { const: "codicarium.release-identity/v1" },
    source_revision: sha40,
    tag: { const: "v0.6.14" },
    verifier_run_attempt: positiveDecimal,
    verifier_run_id: positiveDecimal
  }
);
const publisherDispatchBodySchemaV20 = closed(
  ["authorizer_run_attempt", "authorizer_run_id", "handoff_check_run_id", "handoff_sha256", "kind", "publisher_revision", "repository", "schema", "source_revision", "tag"],
  {
    authorizer_run_attempt: positiveDecimal,
    authorizer_run_id: positiveDecimal,
    handoff_check_run_id: positiveDecimal,
    handoff_sha256: sha64,
    kind: { const: "publisher-dispatch" },
    publisher_revision: sha40,
    repository: { const: "codicarium/deployment-controller" },
    schema: { const: "codicarium.release-identity/v1" },
    source_revision: sha40,
    tag: { const: "v0.6.14" }
  }
);
const releaseIdentitySchemaV20 = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.codicarium.com/release/release-identity-v1.schema.json",
  title: "Closed raw release identity bodies",
  oneOf: [handoffIdentityBodySchemaV20, publisherDispatchBodySchemaV20]
};
writeJson("release-identity-v1.schema.json", releaseIdentitySchemaV20);

const canonicalIdentityFixtureV20 = {
  schema: "codicarium.release-identity-fixtures/v2",
  authority: false,
  purpose: "byte-regression-only",
  handoff: {
    raw_path: "fixtures-v2.0/release-handoff-v1.json",
    json_byte_length: 697,
    json_sha256: sha256(releaseHandoffBytesV20),
    digest_base64url: b64url(Buffer.from(sha256(releaseHandoffBytesV20), "hex")),
    coordinator_check_run_id: "9002003",
    tuple_grammar: "release-verify:<verifier_id>/<attempt>:<tag>:<source>:<ci_id>/<attempt>:<coordinator_id>/<attempt>:<coordinator_check_id>:<publisher_revision>",
    tuple: handoffTuple,
    tuple_base64url: b64url(Buffer.from(handoffTuple, "utf8"))
  },
  dispatch: {
    raw_path: "fixtures-v2.0/publisher-dispatch-v1.json",
    json_byte_length: 436,
    json_sha256: sha256(publisherDispatchBytesV20),
    digest_base64url: b64url(Buffer.from(sha256(publisherDispatchBytesV20), "hex")),
    handoff_check_run_id: "9004003",
    tuple_grammar: "publisher-dispatch:<authorizer_id>/<attempt>:<handoff_check_id>:<handoff_sha256>:<publisher_revision>:<repository>:<tag>:<source>",
    tuple: dispatchTuple,
    tuple_base64url: b64url(Buffer.from(dispatchTuple, "utf8"))
  },
  check_id_semantics: "coordinator_check_run_id 9002003 belongs only to the handoff body/tuple; handoff_check_run_id 9004003 belongs only to the dispatch body/tuple. They are distinct observation identifiers and neither authorizes journal mutation."
};
writeJson("canonical-identity-fixtures-v1.json", canonicalIdentityFixtureV20);
const identityNegativeVectorsV20 = {
  schema: "codicarium.release-identity-negative-vectors/v1",
  positive_fixture_count: 2,
  negative_fixture_count: 6,
  vectors: [
    { name: "handoff-duplicate-key", identity: "handoff", failure: "DUPLICATE_KEY", raw: releaseHandoffRawV20.slice(0, -1) + ",\"tag\":\"v0.6.14\"}" },
    { name: "handoff-unknown-key", identity: "handoff", failure: "UNKNOWN_KEY", raw: releaseHandoffRawV20.slice(0, -1) + ",\"unknown\":true}" },
    { name: "handoff-mutated-byte", identity: "handoff", failure: "DIGEST_MISMATCH", raw: releaseHandoffRawV20.replace("\"9003001\"", "\"9003002\"") },
    { name: "dispatch-duplicate-key", identity: "dispatch", failure: "DUPLICATE_KEY", raw: publisherDispatchRawV20.slice(0, -1) + ",\"tag\":\"v0.6.14\"}" },
    { name: "dispatch-unknown-key", identity: "dispatch", failure: "UNKNOWN_KEY", raw: publisherDispatchRawV20.slice(0, -1) + ",\"unknown\":true}" },
    { name: "dispatch-mutated-byte", identity: "dispatch", failure: "DIGEST_MISMATCH", raw: publisherDispatchRawV20.replace("\"9004003\"", "\"9004004\"") }
  ]
};
writeJson("release-identity-negative-vectors-v1.fixture.json", identityNegativeVectorsV20);

const fixtureAuthorityMarkerV20 = {
  evidence_class: "synthetic-conformance-fixture",
  publication_authority: false,
  fixture_set: "issue93-v2.0"
};
const fixtureAuthorityKeysV20 = ["evidence_class", "publication_authority", "fixture_set"];
const fixtureAuthorityPropertiesV20 = {
  evidence_class: { const: fixtureAuthorityMarkerV20.evidence_class },
  publication_authority: { const: false },
  fixture_set: { const: fixtureAuthorityMarkerV20.fixture_set }
};
const workflowIdentitySchemaV20 = (workflowPath) => closed(
  ["repository_id", "workflow_path", "ref", "workflow_sha"],
  {
    repository_id: { const: "1303901324" },
    workflow_path: { const: workflowPath },
    ref: { const: "refs/heads/main" },
    workflow_sha: { const: reviewedWorkflowRevisionV20 }
  }
);
const claimIdentitySchemaV20 = closed(
  [...fixtureAuthorityKeysV20, "repository_id", "repository", "tag", "source_revision", "protected_main_revision", "coordinator_workflow", "publisher_workflow"],
  {
    ...fixtureAuthorityPropertiesV20,
    repository_id: { const: "1303901324" },
    repository: { const: "codicarium/deployment-controller" },
    tag: { const: "v0.6.14" },
    source_revision: { const: candidateSourceRevisionV20 },
    protected_main_revision: { const: reviewedWorkflowRevisionV20 },
    coordinator_workflow: workflowIdentitySchemaV20(coordinatorWorkflowPathV20),
    publisher_workflow: workflowIdentitySchemaV20(publisherWorkflowPathV20)
  }
);
const claimIdentityV20 = {
  ...fixtureAuthorityMarkerV20,
  repository_id: "1303901324",
  repository: "codicarium/deployment-controller",
  tag: "v0.6.14",
  source_revision: candidateSourceRevisionV20,
  protected_main_revision: reviewedWorkflowRevisionV20,
  coordinator_workflow: {
    repository_id: "1303901324",
    workflow_path: coordinatorWorkflowPathV20,
    ref: "refs/heads/main",
    workflow_sha: reviewedWorkflowRevisionV20
  },
  publisher_workflow: {
    repository_id: "1303901324",
    workflow_path: publisherWorkflowPathV20,
    ref: "refs/heads/main",
    workflow_sha: reviewedWorkflowRevisionV20
  }
};
const claimIdentityDigestV20 = digestJcsV20(claimIdentityV20);
const claimKeyV20 = "rel-v2-sha256:" + claimIdentityDigestV20;
const repeatedSyntheticSha40V20 = [..."0123456789abcdef"].map((character) => character.repeat(40));
const repeatedSyntheticSha64V20 = [..."0123456789abcdef"].map((character) => character.repeat(64));
const forbiddenLiveSha40V20 = [...new Set([candidateSourceRevisionV20, reviewedWorkflowRevisionV20, ...repeatedSyntheticSha40V20])];
const forbiddenLiveSha64V20 = [...new Set([claimIdentityDigestV20, ...repeatedSyntheticSha64V20])];
const nonFixtureSha40V20 = {
  allOf: [sha40, { not: { enum: forbiddenLiveSha40V20 } }]
};
const nonFixtureSha64V20 = {
  allOf: [sha64, { not: { enum: forbiddenLiveSha64V20 } }]
};
const nonFixtureSigningKidV20 = {
  allOf: [base64url, { not: { const: kid } }]
};
const liveWorkflowIdentitySchemaV20 = (workflowPath) => closed(
  ["repository_id", "workflow_path", "ref", "workflow_sha"],
  {
    repository_id: { const: "1303901324" },
    workflow_path: { const: workflowPath },
    ref: { const: "refs/heads/main" },
    workflow_sha: nonFixtureSha40V20
  }
);
const liveImplementationIdentityObjectSchemaV20 = closed(
  ["schema", "evidence_class", "publication_authority", "repository", "tag", "protected_corrective_merge_sha", "candidate_source_sha", "coordinator_workflow", "publisher_workflow", "discovery_proof", "signing_key"],
  {
    schema: { const: "codicarium.release-live-implementation-identity/v1" },
    evidence_class: { const: "live-protected-authority" },
    publication_authority: { const: true },
    repository: closed(["id", "full_name"], { id: { const: "1303901324" }, full_name: { const: "codicarium/deployment-controller" } }),
    tag: { const: "v0.6.14" },
    protected_corrective_merge_sha: nonFixtureSha40V20,
    candidate_source_sha: nonFixtureSha40V20,
    coordinator_workflow: liveWorkflowIdentitySchemaV20(coordinatorWorkflowPathV20),
    publisher_workflow: liveWorkflowIdentitySchemaV20(publisherWorkflowPathV20),
    discovery_proof: closed(
      ["captured_after_protected_merge", "repository_id", "base_ref", "corrective_pr_merged", "merge_commit_sha", "protected_main_sha", "candidate_run_head_sha", "candidate_checks_head_sha", "ancestry", "behind_by", "tag_target_sha", "compare", "workflow_file_proofs", "observed_at", "max_age_seconds"],
      {
        captured_after_protected_merge: { const: true },
        repository_id: { const: "1303901324" },
        base_ref: { const: "refs/heads/main" },
        corrective_pr_merged: { const: true },
        merge_commit_sha: nonFixtureSha40V20,
        protected_main_sha: nonFixtureSha40V20,
        candidate_run_head_sha: nonFixtureSha40V20,
        candidate_checks_head_sha: nonFixtureSha40V20,
        ancestry: { enum: ["identical", "ahead"] },
        behind_by: { const: 0 },
        tag_target_sha: nonFixtureSha40V20,
        compare: closed(
          ["api_version", "endpoint", "http_status", "base_sha", "head_sha", "status", "ahead_by", "behind_by", "merge_base_sha"],
          {
            api_version: { const: "2026-03-10" },
            endpoint: { type: "string", pattern: "^https://api\\.github\\.com/repos/codicarium/deployment-controller/compare/[0-9a-f]{40}\\.\\.\\.[0-9a-f]{40}$" },
            http_status: { const: 200 },
            base_sha: nonFixtureSha40V20,
            head_sha: nonFixtureSha40V20,
            status: { enum: ["identical", "ahead"] },
            ahead_by: { type: "integer", minimum: 0 },
            behind_by: { const: 0 },
            merge_base_sha: nonFixtureSha40V20
          }
        ),
        workflow_file_proofs: closed(
          ["coordinator", "publisher"],
          Object.fromEntries([
            ["coordinator", coordinatorWorkflowPathV20],
            ["publisher", publisherWorkflowPathV20]
          ].map(([role, workflowPath]) => [role, closed(
            ["workflow_path", "protected_revision", "candidate_revision", "protected_blob_sha", "candidate_blob_sha", "identical"],
            {
              workflow_path: { const: workflowPath },
              protected_revision: nonFixtureSha40V20,
              candidate_revision: nonFixtureSha40V20,
              protected_blob_sha: nonFixtureSha40V20,
              candidate_blob_sha: nonFixtureSha40V20,
              identical: { const: true }
            }
          )]))
        ),
        observed_at: rfc3339,
        max_age_seconds: { const: 300 }
      }
    ),
    signing_key: closed(
      ["kind", "kid", "fixture_key_forbidden"],
      { kind: { const: "vault-transit" }, kid: nonFixtureSigningKidV20, fixture_key_forbidden: { const: true } }
    )
  }
);
const liveClaimBindingSchemaV20 = closed(
  ["schema", "evidence_class", "publication_authority", "repository_id", "live_identity_jcs_sha256", "claim_key", "signing_kid", "journal_side_effects_allowed"],
  {
    schema: { const: "codicarium.release-live-claim-binding/v1" },
    evidence_class: { const: "live-protected-authority" },
    publication_authority: { const: true },
    repository_id: { const: "1303901324" },
    live_identity_jcs_sha256: nonFixtureSha64V20,
    claim_key: { type: "string", pattern: "^rel-v2-sha256:[0-9a-f]{64}$" },
    signing_kid: nonFixtureSigningKidV20,
    journal_side_effects_allowed: { const: true }
  }
);
const liveReceiptBindingSchemaV20 = closed(
  ["schema", "evidence_class", "publication_authority", "repository_id", "kind", "sequence", "previous_receipt_sha256", "live_identity_jcs_sha256", "claim_key", "protected_corrective_merge_sha", "candidate_source_sha", "coordinator_workflow_sha", "publisher_workflow_sha", "signing_kid"],
  {
    schema: { const: "codicarium.release-live-receipt-binding/v1" },
    evidence_class: { const: "live-protected-authority" },
    publication_authority: { const: true },
    repository_id: { const: "1303901324" },
    kind: { enum: ["publisher-dispatch", "publisher-mutation"] },
    sequence: sequenceV20,
    previous_receipt_sha256: sha64,
    live_identity_jcs_sha256: nonFixtureSha64V20,
    claim_key: { type: "string", pattern: "^rel-v2-sha256:[0-9a-f]{64}$" },
    protected_corrective_merge_sha: nonFixtureSha40V20,
    candidate_source_sha: nonFixtureSha40V20,
    coordinator_workflow_sha: nonFixtureSha40V20,
    publisher_workflow_sha: nonFixtureSha40V20,
    signing_kid: nonFixtureSigningKidV20
  },
  {
    allOf: [
      {
        if: { properties: { kind: { const: "publisher-dispatch" } }, required: ["kind"] },
        then: { properties: { sequence: { const: "0" }, previous_receipt_sha256: { const: zeroSha256V20 } } },
        else: { properties: { sequence: { type: "string", pattern: "^([1-9]|1[0-9])$" }, previous_receipt_sha256: { allOf: [sha64, { not: { const: zeroSha256V20 } }] } } }
      }
    ]
  }
);
const liveImplementationIdentitySchemaV20 = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.codicarium.com/release/release-live-implementation-identity-v1.schema.json",
  title: "Post-merge live release authority identity and binding schemas",
  "$defs": {
    claim_binding: liveClaimBindingSchemaV20,
    receipt_binding: liveReceiptBindingSchemaV20
  },
  ...liveImplementationIdentityObjectSchemaV20
};
writeJson("release-live-implementation-identity-v1.schema.json", liveImplementationIdentitySchemaV20);
const claimCasSchemaV20 = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.codicarium.com/release/release-claim-cas-v1.schema.json",
  title: "First-side-effect release claim CAS fixture",
  ...closed(
    ["schema", ...fixtureAuthorityKeysV20, "fixture_identity_jcs_sha256", "identity", "identity_jcs_sha256", "claim_key", "authority", "api", "vectors"],
    {
      schema: { const: "codicarium.release-claim-cas-fixture/v1" },
      ...fixtureAuthorityPropertiesV20,
      fixture_identity_jcs_sha256: { const: claimIdentityDigestV20 },
      identity: claimIdentitySchemaV20,
      identity_jcs_sha256: sha64,
      claim_key: { type: "string", pattern: "^rel-v2-sha256:[0-9a-f]{64}$" },
      authority: closed(
        ["storage", "transaction_isolation", "synchronous_commit", "first_durable_release_side_effect"],
        {
          storage: { const: "dedicated-dev-postgresql" },
          transaction_isolation: { const: "SERIALIZABLE" },
          synchronous_commit: { const: "on" },
          first_durable_release_side_effect: { const: true }
        }
      ),
      api: closed(
        ["procedure", "create_status", "exact_replay_status", "conflict_status", "ambiguity_outcome", "automatic_retry"],
        {
          procedure: { const: "release_journal.claim_cas_v1" },
          create_status: { const: 201 },
          exact_replay_status: { const: 200 },
          conflict_status: { const: 409 },
          ambiguity_outcome: { const: "UNKNOWN_MANUAL" },
          automatic_retry: { const: false }
        }
      ),
      vectors: {
        type: "array",
        minItems: 4,
        maxItems: 4,
        prefixItems: [
          closed(["name", "http_status", "outcome", "journal_writes", "automatic_retry"], { name: { const: "first-create" }, http_status: { const: 201 }, outcome: { const: "CLAIMED" }, journal_writes: { const: 1 }, automatic_retry: { const: false } }),
          closed(["name", "http_status", "outcome", "journal_writes", "automatic_retry"], { name: { const: "exact-read-only-replay" }, http_status: { const: 200 }, outcome: { const: "EXACT_REPLAY" }, journal_writes: { const: 0 }, automatic_retry: { const: false } }),
          closed(["name", "http_status", "outcome", "journal_writes", "automatic_retry"], { name: { const: "same-key-conflict" }, http_status: { const: 409 }, outcome: { const: "CONFLICT" }, journal_writes: { const: 0 }, automatic_retry: { const: false } }),
          closed(["name", "http_status", "outcome", "journal_writes", "automatic_retry"], { name: { const: "ambiguous-response" }, http_status: { type: "null" }, outcome: { const: "UNKNOWN_MANUAL" }, journal_writes: { const: 0 }, automatic_retry: { const: false } })
        ],
        items: false
      }
    }
  )
};
const claimCasFixtureV20 = {
  schema: "codicarium.release-claim-cas-fixture/v1",
  ...fixtureAuthorityMarkerV20,
  fixture_identity_jcs_sha256: claimIdentityDigestV20,
  identity: claimIdentityV20,
  identity_jcs_sha256: claimIdentityDigestV20,
  claim_key: claimKeyV20,
  authority: { storage: "dedicated-dev-postgresql", transaction_isolation: "SERIALIZABLE", synchronous_commit: "on", first_durable_release_side_effect: true },
  api: { procedure: "release_journal.claim_cas_v1", create_status: 201, exact_replay_status: 200, conflict_status: 409, ambiguity_outcome: "UNKNOWN_MANUAL", automatic_retry: false },
  vectors: [
    { name: "first-create", http_status: 201, outcome: "CLAIMED", journal_writes: 1, automatic_retry: false },
    { name: "exact-read-only-replay", http_status: 200, outcome: "EXACT_REPLAY", journal_writes: 0, automatic_retry: false },
    { name: "same-key-conflict", http_status: 409, outcome: "CONFLICT", journal_writes: 0, automatic_retry: false },
    { name: "ambiguous-response", http_status: null, outcome: "UNKNOWN_MANUAL", journal_writes: 0, automatic_retry: false }
  ]
};
writeJson("release-claim-cas-v1.schema.json", claimCasSchemaV20);
writeJson("release-claim-cas-v1.fixture.json", claimCasFixtureV20);

const transitSignatureSchemaV20 = closed(
  ["format", "transit_key", "transit_key_version", "kid", "payload_sha256", "signature_base64url"],
  {
    format: { const: "vault-transit-ed25519-jcs/v1" },
    transit_key: { const: "release-journal-v1" },
    transit_key_version: { const: "1" },
    kid: base64url,
    payload_sha256: sha64,
    signature_base64url: base64url
  }
);
const signedEnvelopeSchemaV20 = (bodySchema) => closed(
  ["body", "signature"],
  { body: bodySchema, signature: transitSignatureSchemaV20 }
);
const signTransitV20 = (body) => {
  const payload = Buffer.from(jcs(body), "utf8");
  return {
    body,
    signature: {
      format: "vault-transit-ed25519-jcs/v1",
      transit_key: "release-journal-v1",
      transit_key_version: "1",
      kid,
      payload_sha256: sha256(payload),
      signature_base64url: b64url(crypto.sign(null, payload, privateKey))
    }
  };
};

const targetSchemasV20 = {
  "tag-create": closed(
    ["ref", "object", "object_type", "force"],
    { ref: { const: "refs/tags/v0.6.14" }, object: sha40, object_type: { const: "commit" }, force: { const: false } }
  ),
  "draft-release-create": closed(
    ["release_id", "tag", "target_commitish", "draft", "prerelease"],
    { release_id: positiveDecimal, tag: { const: "v0.6.14" }, target_commitish: sha40, draft: { const: true }, prerelease: { const: false } }
  ),
  "image-publish": closed(
    ["registry", "repository", "reference", "digest"],
    { registry: { const: "docker-push.nexus.int.codicarium.com" }, repository: { const: "codicarium/deployment-controller" }, reference: { const: "v0.6.14" }, digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" } }
  ),
  "chart-publish": closed(
    ["registry", "repository", "version", "digest"],
    { registry: { const: "charts.nexus.int.codicarium.com" }, repository: { const: "codicarium/deployment-controller" }, version: { const: "0.6.14" }, digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" } }
  ),
  "release-asset-create": closed(
    ["release_id", "asset_id", "name", "size", "sha256"],
    { release_id: positiveDecimal, asset_id: positiveDecimal, name: { enum: assetNames }, size: positiveDecimal, sha256: sha64 }
  ),
  "release-finalize": closed(
    ["release_id", "tag", "target_commitish", "draft", "prerelease"],
    { release_id: positiveDecimal, tag: { const: "v0.6.14" }, target_commitish: sha40, draft: { const: false }, prerelease: { const: false } }
  )
};
const publicationTargetSchemaV20 = { oneOf: Object.values(targetSchemasV20) };
const receiptIssuerV20 = closed(
  ["kind", "principal", "vault_role", "can_mutate_targets", "can_commit_journal"],
  {
    kind: { const: "vault-transit" },
    principal: { const: "release-journal-signer" },
    vault_role: { const: "release-journal-sign-v1" },
    can_mutate_targets: { const: false },
    can_commit_journal: { const: false }
  }
);
const dispatchReceiptBodySchemaV20 = closed(
  ["schema", ...fixtureAuthorityKeysV20, "fixture_identity_jcs_sha256", "kind", "claim_key", "active_source_revision", "claim_identity_jcs_sha256", "protected_main_revision", "sequence", "previous_receipt_sha256", "reservation_entry_sha256", "authorization_sha256", "handoff_sha256", "legacy_raw_identity_authority", "dispatch_request_sha256", "dispatch_readback_sha256", "publisher_workflow", "publisher_workflow_sha", "publisher_ref", "publisher_revision", "publisher_run_id", "publisher_run_attempt", "issued_at", "issuer"],
  {
    schema: { const: "codicarium.publisher-dispatch-receipt/v2" },
    ...fixtureAuthorityPropertiesV20,
    fixture_identity_jcs_sha256: { const: claimIdentityDigestV20 },
    kind: { const: "publisher-dispatch" },
    claim_key: { type: "string", pattern: "^rel-v2-sha256:[0-9a-f]{64}$" },
    active_source_revision: { const: candidateSourceRevisionV20 },
    claim_identity_jcs_sha256: { const: claimIdentityDigestV20 },
    protected_main_revision: { const: reviewedWorkflowRevisionV20 },
    sequence: { const: "0" },
    previous_receipt_sha256: { const: zeroSha256V20 },
    reservation_entry_sha256: sha64,
    authorization_sha256: sha64,
    handoff_sha256: { const: "8abe528bb32aaa47f8fc496c3571d4b91248f3ebfe4c8be29463a25277bd9e88" },
    legacy_raw_identity_authority: { const: false },
    dispatch_request_sha256: sha64,
    dispatch_readback_sha256: sha64,
    publisher_workflow: { const: `codicarium/deployment-controller/${publisherWorkflowPathV20}` },
    publisher_workflow_sha: { const: reviewedWorkflowRevisionV20 },
    publisher_ref: { const: "refs/heads/main" },
    publisher_revision: { const: reviewedWorkflowRevisionV20 },
    publisher_run_id: positiveDecimal,
    publisher_run_attempt: positiveDecimal,
    issued_at: rfc3339,
    issuer: receiptIssuerV20
  }
);
const dispatchReceiptEnvelopeSchemaV20 = signedEnvelopeSchemaV20(dispatchReceiptBodySchemaV20);
const publisherDispatchReceiptSchemaV20 = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.codicarium.com/release/publisher-dispatch-receipt-v2.schema.json",
  title: "Signed publisher dispatch sequence-zero receipt",
  ...dispatchReceiptEnvelopeSchemaV20
};
const mutationReceiptBodySchemaV20 = closed(
  ["schema", ...fixtureAuthorityKeysV20, "fixture_identity_jcs_sha256", "kind", "claim_key", "sequence", "previous_receipt_sha256", "reservation_entry_sha256", "mutation", "request_sha256", "readback_sha256", "publisher_ref", "publisher_revision", "publisher_run_id", "publisher_run_attempt", "issued_at", "issuer", "target"],
  {
    schema: { const: "codicarium.publisher-mutation-receipt/v2" },
    ...fixtureAuthorityPropertiesV20,
    fixture_identity_jcs_sha256: { const: claimIdentityDigestV20 },
    kind: { const: "publisher-mutation" },
    claim_key: { type: "string", pattern: "^rel-v2-sha256:[0-9a-f]{64}$" },
    sequence: { enum: Array.from({ length: 19 }, (unused, index) => String(index + 1)) },
    previous_receipt_sha256: sha64,
    reservation_entry_sha256: sha64,
    mutation: { enum: Object.keys(targetSchemasV20) },
    request_sha256: sha64,
    readback_sha256: sha64,
    publisher_ref: { const: "refs/heads/main" },
    publisher_revision: { const: reviewedWorkflowRevisionV20 },
    publisher_run_id: positiveDecimal,
    publisher_run_attempt: positiveDecimal,
    issued_at: rfc3339,
    issuer: receiptIssuerV20,
    target: publicationTargetSchemaV20
  },
  {
    allOf: Object.entries(targetSchemasV20).map(([mutation, target]) => ({
      if: { properties: { mutation: { const: mutation } }, required: ["mutation"] },
      then: { properties: { target } }
    }))
  }
);
const mutationReceiptEnvelopeSchemaV20 = signedEnvelopeSchemaV20(mutationReceiptBodySchemaV20);
const publisherMutationReceiptsSchemaV20 = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.codicarium.com/release/publisher-mutation-receipts-v2.schema.json",
  title: "Exactly nineteen signed publisher mutation receipts",
  ...closed(
    ["schema", ...fixtureAuthorityKeysV20, "fixture_identity_jcs_sha256", "receipts"],
    {
      schema: { const: "codicarium.publisher-mutation-receipts-fixture/v2" },
      ...fixtureAuthorityPropertiesV20,
      fixture_identity_jcs_sha256: { const: claimIdentityDigestV20 },
      receipts: { type: "array", minItems: 19, maxItems: 19, items: mutationReceiptEnvelopeSchemaV20 }
    }
  )
};
writeJson("publisher-dispatch-receipt-v1.schema.json", publisherDispatchReceiptSchemaV20);
writeJson("publisher-mutation-receipt-v1.schema.json", publisherMutationReceiptsSchemaV20);

const actorSchemaV20 = closed(
  ["principal", "role", "capabilities", "can_mutate_targets", "can_sign", "can_commit"],
  {
    principal: { type: "string", minLength: 1 },
    role: { enum: ["claimer", "reserver", "committer", "authorizer"] },
    capabilities: { type: "array", minItems: 1, uniqueItems: true, items: { enum: ["journal:claim", "journal:reserve", "journal:commit", "journal:authorize", "journal:complete"] } },
    can_mutate_targets: { const: false },
    can_sign: { const: false },
    can_commit: { type: "boolean" }
  }
);
const journalPayloadSchemaV20 = closed(
  ["operation", "phase", "request_sha256", "result_sha256", "reservation_entry_sha256", "publication_receipt_sha256", "workflow_run_id", "outcome"],
  {
    operation: { type: "string", minLength: 1 },
    phase: { enum: ["claim", "reserve", "commit", "authorize", "complete"] },
    request_sha256: nullableV20(sha64),
    result_sha256: nullableV20(sha64),
    reservation_entry_sha256: nullableV20(sha64),
    publication_receipt_sha256: nullableV20(sha64),
    workflow_run_id: nullableV20(positiveDecimal),
    outcome: { enum: ["CLAIMED", "RESERVED", "COMMITTED", "AUTHORIZED", "COMPLETE", "UNKNOWN_MANUAL"] }
  }
);
const journalEventNamesV20 = [
  "claim",
  "verifier-dispatch-reserve",
  "verifier-dispatch-commit",
  "verification-authorization",
  "publisher-dispatch-reserve",
  "publisher-dispatch-commit",
  "mutation-reserve",
  "mutation-commit",
  "complete",
  "UNKNOWN_MANUAL"
];
const journalEntryBodySchemaV20 = closed(
  ["schema", ...fixtureAuthorityKeysV20, "fixture_identity_jcs_sha256", "journal_id", "ordinal", "event", "claim_key", "publication_sequence", "previous_entry_sha256", "payload", "actor", "created_at"],
  {
    schema: { const: "codicarium.release-journal-entry/v1" },
    ...fixtureAuthorityPropertiesV20,
    fixture_identity_jcs_sha256: { const: claimIdentityDigestV20 },
    journal_id: { type: "string", pattern: "^jrnl-v1-[0-9a-f]{32}$" },
    ordinal: positiveDecimal,
    event: { enum: journalEventNamesV20 },
    claim_key: { type: "string", pattern: "^rel-v2-sha256:[0-9a-f]{64}$" },
    publication_sequence: nullableV20(sequenceV20),
    previous_entry_sha256: sha64,
    payload: journalPayloadSchemaV20,
    actor: actorSchemaV20,
    created_at: rfc3339
  }
);
const journalEntryEnvelopeSchemaV20 = signedEnvelopeSchemaV20(journalEntryBodySchemaV20);
const journalRecordSchemaV20 = closed(
  ["entry", "entry_sha256"],
  { entry: journalEntryEnvelopeSchemaV20, entry_sha256: sha64 }
);
const githubDispatchTransportV20 = {
  api_version_header: "X-GitHub-Api-Version",
  api_version: "2026-03-10",
  accept: "application/vnd.github+json",
  return_run_details: true
};
const publisherDispatchRequestV20 = {
  schema: "codicarium.publisher-dispatch-request/v2",
  ...fixtureAuthorityMarkerV20,
  fixture_identity_jcs_sha256: claimIdentityDigestV20,
  claim_key: claimKeyV20,
  claim_identity_jcs_sha256: claimIdentityDigestV20,
  active_source_revision: candidateSourceRevisionV20,
  protected_main_revision: reviewedWorkflowRevisionV20,
  publisher_workflow_path: publisherWorkflowPathV20,
  publisher_workflow_sha: reviewedWorkflowRevisionV20,
  legacy_raw_identity: {
    authority: false,
    handoff_sha256: sha256(releaseHandoffBytesV20),
    dispatch_sha256: sha256(publisherDispatchBytesV20)
  }
};
const githubDispatchContractV20 = {
  schema: "codicarium.github-workflow-dispatch-contract/v1",
  request: githubDispatchTransportV20,
  publisher_request: publisherDispatchRequestV20,
  positive: {
    http_status: 200,
    response: {
      workflow_run_id: "9005001",
      workflow_run_url: "https://api.github.com/repos/codicarium/deployment-controller/actions/runs/9005001",
      workflow_run_html_url: "https://github.com/codicarium/deployment-controller/actions/runs/9005001"
    },
    identity_source: "direct-response.workflow_run_id",
    outcome: "DIRECT_RUN_ID_ACCEPTED",
    journal_commit: true,
    automatic_retry: false
  },
  no_body: {
    http_status: 204,
    response: null,
    outcome: "UNKNOWN_MANUAL",
    journal_commit: false,
    automatic_retry: false
  }
};
const journalProcedureNamesV20 = [
  "release_journal.claim_cas_v1",
  "release_journal.reserve_v1",
  "release_journal.commit_v1",
  "release_journal.authorize_v1",
  "release_journal.complete_v1"
];
const journalProcedureDefinitionsV20 = journalProcedureNamesV20.map((name) => {
  const signature = `${name}(jsonb)`;
  const createSignature = `${name}(request jsonb)`;
  const definitionSql = [
    `CREATE OR REPLACE FUNCTION ${createSignature}`,
    "RETURNS jsonb",
    "LANGUAGE plpgsql",
    "SECURITY DEFINER",
    "SET search_path = pg_catalog, release_journal, pg_temp",
    "AS $procedure$",
    "BEGIN",
    "  RAISE EXCEPTION USING ERRCODE = '0A000', MESSAGE = 'release journal implementation not installed';",
    "END;",
    "$procedure$;",
    `ALTER FUNCTION ${signature} OWNER TO release_journal_owner;`,
    `REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`,
    `GRANT EXECUTE ON FUNCTION ${signature} TO release_journal_runtime;`
  ].join("\n");
  return {
    name,
    signature,
    create_signature: createSignature,
    implemented: false,
    failure_sqlstate: "0A000",
    writes_on_call: 0,
    security_definer: true,
    search_path: ["pg_catalog", "release_journal", "pg_temp"],
    persistent_relation_references: "fully-qualified-release_journal-only",
    non_builtin_function_references: "fully-qualified-release_journal-only",
    builtin_function_references: "fully-qualified-pg_catalog-only",
    owner_role: "release_journal_owner",
    runtime_privileges: ["EXECUTE"],
    public_execute_revoked: true,
    definition_sql: definitionSql,
    definition_sha256: sha256(Buffer.from(definitionSql, "utf8"))
  };
});
const journalDefaultPrivilegesSqlV20 = "ALTER DEFAULT PRIVILEGES FOR ROLE release_journal_owner IN SCHEMA release_journal REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;";
const journalDatabaseConnectPublicRevokeSqlV20 = "REVOKE CONNECT ON DATABASE runner_platform_journal FROM PUBLIC;";
const journalDatabaseTempPublicRevokeSqlV20 = "REVOKE TEMPORARY ON DATABASE runner_platform_journal FROM PUBLIC;";
const journalDatabaseTempRuntimeRevokeSqlV20 = "REVOKE TEMPORARY ON DATABASE runner_platform_journal FROM release_journal_runtime;";
const journalSchemaCreatePublicRevokeSqlV20 = "REVOKE CREATE ON SCHEMA release_journal FROM PUBLIC;";
const journalSchemaCreateRuntimeRevokeSqlV20 = "REVOKE CREATE ON SCHEMA release_journal FROM release_journal_runtime;";
const journalTempShadowAttackVectorV20 = {
  name: "pg-temp-relation-and-function-shadow",
  attacker_role: "release_journal_runtime",
  attempted_objects: ["pg_temp.release_claims relation", "pg_temp.digest(jsonb) function"],
  runtime_create_result: "DENY_SQLSTATE_42501",
  privileged_test_harness_precreates_shadows: true,
  procedure_search_path: ["pg_catalog", "release_journal", "pg_temp"],
  expected_resolution: {
    persistent_relations: "explicit release_journal qualification",
    non_builtin_functions: "explicit release_journal qualification",
    builtin_functions: "explicit pg_catalog qualification",
    pg_temp_objects: "never selected"
  },
  unauthorized_writes: 0,
  activation_result: "REQUIRED_POSTGRES_INTEGRATION_EVIDENCE"
};
const journalMigrationSqlV20 = [
  "BEGIN;",
  journalDatabaseConnectPublicRevokeSqlV20,
  journalDatabaseTempPublicRevokeSqlV20,
  journalDatabaseTempRuntimeRevokeSqlV20,
  journalSchemaCreatePublicRevokeSqlV20,
  journalSchemaCreateRuntimeRevokeSqlV20,
  journalDefaultPrivilegesSqlV20,
  ...journalProcedureDefinitionsV20.map((procedure) => procedure.definition_sql),
  "COMMIT;"
].join("\n\n");
const journalProcedureMigrationV20 = {
  schema: "codicarium.release-journal-procedure-migration/v1",
  sql_path: "runner-config/release-journal/migrations/001_release_journal_v1.sql",
  implementation_status: "BLOCKED_PREACTIVATION_FAIL_CLOSED",
  migration_transactional: true,
  owner_role: "release_journal_owner",
  owner_role_login: false,
  runtime_role: "release_journal_runtime",
  runtime_is_owner: false,
  runtime_inherits_owner: false,
  runtime_schema_create_privilege: false,
  public_schema_create_privilege: false,
  runtime_database_temp_privilege: false,
  public_database_temp_privilege: false,
  public_database_connect_privilege: false,
  runtime_procedure_privileges: ["EXECUTE"],
  runtime_direct_table_privileges: [],
  public_procedure_privileges: [],
  owner_default_public_execute_revoked: true,
  persistent_relation_references_fully_qualified: true,
  non_builtin_function_references_fully_qualified: true,
  builtin_function_references_pg_catalog_qualified: true,
  database_connect_public_revoke_sql: journalDatabaseConnectPublicRevokeSqlV20,
  database_temp_public_revoke_sql: journalDatabaseTempPublicRevokeSqlV20,
  database_temp_runtime_revoke_sql: journalDatabaseTempRuntimeRevokeSqlV20,
  schema_create_public_revoke_sql: journalSchemaCreatePublicRevokeSqlV20,
  schema_create_runtime_revoke_sql: journalSchemaCreateRuntimeRevokeSqlV20,
  default_privileges_sql: journalDefaultPrivilegesSqlV20,
  temp_shadow_attack_vector: journalTempShadowAttackVectorV20,
  migration_sql: journalMigrationSqlV20,
  migration_sha256: sha256(Buffer.from(journalMigrationSqlV20, "utf8")),
  procedures: journalProcedureDefinitionsV20
};
const operationRequestSchemaV20 = closed(
  ["method", "endpoint", "actor_role", "github_api", "target_jcs", "target_sha256"],
  {
    method: { enum: ["POST", "PUT", "PATCH", "GET"] },
    endpoint: { type: "string", minLength: 1 },
    actor_role: { type: "string", pattern: "^(verifier|publisher)-target-writer(-[0-9]{2})?$" },
    github_api: nullableV20({ const: githubDispatchTransportV20 }),
    target_jcs: { type: "string", minLength: 2 },
    target_sha256: sha64
  }
);
const operationReadbackSchemaV20 = closed(
  ["status", "endpoint", "target_sha256", "state_jcs", "state_sha256"],
  {
    status: { enum: [200, 201] },
    endpoint: { type: "string", minLength: 1 },
    target_sha256: sha64,
    state_jcs: { type: "string", minLength: 2 },
    state_sha256: sha64
  }
);
const operationEvidenceSchemaV20 = closed(
  ["operation", "sequence", "request", "request_sha256", "readback", "readback_sha256"],
  {
    operation: { type: "string", minLength: 1 },
    sequence: nullableV20(sequenceV20),
    request: operationRequestSchemaV20,
    request_sha256: sha64,
    readback: operationReadbackSchemaV20,
    readback_sha256: sha64
  }
);
const journalSchemaV20 = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.codicarium.com/release/release-journal-v1.schema.json",
  title: "Dedicated PostgreSQL append-only release journal",
  ...closed(
    ["schema", ...fixtureAuthorityKeysV20, "fixture_identity_jcs_sha256", "claim_key", "storage", "procedure_migration", "github_dispatch_contract", "role_separation", "operations", "entries", "terminal_state"],
    {
      schema: { const: "codicarium.release-journal-fixture/v1" },
      ...fixtureAuthorityPropertiesV20,
      fixture_identity_jcs_sha256: { const: claimIdentityDigestV20 },
      claim_key: { type: "string", pattern: "^rel-v2-sha256:[0-9a-f]{64}$" },
      storage: closed(
        ["authority", "desired_endpoint", "live_status", "transactions", "synchronous_commit", "synchronous_replicas", "append_only", "constraints", "runtime_grants", "runtime_revocations", "write_api", "update_endpoint", "delete_endpoint", "tls_status"],
        {
          authority: { const: "dedicated-dev-postgresql-not-s3" },
          desired_endpoint: { const: "runner-platform-journal-rw.runner-platform-journal-dev.svc.cluster.local:5432" },
          live_status: { const: "PREACTIVATION_NOT_MATERIALIZED" },
          transactions: { const: "SERIALIZABLE" },
          synchronous_commit: { const: "on" },
          synchronous_replicas: { const: "REQUIRED_PREACTIVATION_NOT_PROVEN" },
          append_only: { const: true },
          constraints: { const: ["PRIMARY KEY entry_id", "UNIQUE claim_key+ordinal", "UNIQUE claim_key+event+publication_sequence", "NOT NULL and CHECK closed enums"] },
          runtime_grants: { const: "CONNECT,USAGE,SELECT(read_view),EXECUTE(exact SECURITY DEFINER procedures)" },
          runtime_revocations: { const: "CREATE,INSERT,UPDATE,DELETE,TRUNCATE,DDL,PUBLIC" },
          write_api: { const: "stored-procedures-only" },
          update_endpoint: { const: false },
          delete_endpoint: { const: false },
          tls_status: { const: "BLOCKED_UNTIL_VERIFY_FULL_CA_CONTRACT_EXISTS" }
        }
      ),
      procedure_migration: { const: journalProcedureMigrationV20 },
      github_dispatch_contract: { const: githubDispatchContractV20 },
      role_separation: closed(
        ["target_writer_can_sign_or_commit", "signer_can_mutate_or_commit", "committer_can_mutate_or_sign"],
        {
          target_writer_can_sign_or_commit: { const: false },
          signer_can_mutate_or_commit: { const: false },
          committer_can_mutate_or_sign: { const: false }
        }
      ),
      operations: { type: "array", minItems: 22, maxItems: 22, items: operationEvidenceSchemaV20 },
      entries: { type: "array", minItems: 45, maxItems: 45, items: journalRecordSchemaV20 },
      terminal_state: { const: "complete" }
    }
  )
};
writeJson("release-journal-v1.schema.json", journalSchemaV20);

const makeOperationV20 = (operation, sequence, method, endpoint, actorRole, target, status, readbackState, githubApi = null) => {
  const targetJcs = jcs(target);
  const targetSha = sha256(Buffer.from(targetJcs, "utf8"));
  const request = { method, endpoint, actor_role: actorRole, github_api: githubApi, target_jcs: targetJcs, target_sha256: targetSha };
  const stateJcs = jcs(readbackState);
  const readback = { status, endpoint, target_sha256: targetSha, state_jcs: stateJcs, state_sha256: sha256(Buffer.from(stateJcs, "utf8")) };
  return {
    operation,
    sequence,
    request,
    request_sha256: digestJcsV20(request),
    readback,
    readback_sha256: digestJcsV20(readback)
  };
};
const imagePublishDigestV20 = digestJcsV20({
  schema: "codicarium.published-image-fixture/v1",
  source_revision: candidateSourceRevisionV20,
  candidate_archive_sha256: candidateEvidenceFixture.archives["deployment-controller-verified-image"].archive_sha256
});
const chartPublishDigestV20 = digestJcsV20({
  schema: "codicarium.published-chart-fixture/v1",
  source_revision: candidateSourceRevisionV20,
  candidate_archive_sha256: candidateEvidenceFixture.archives["deployment-controller-verified-chart"].archive_sha256
});
const publicationTargetsV20 = [
  { mutation: "tag-create", target: { ref: "refs/tags/v0.6.14", object: candidateSourceRevisionV20, object_type: "commit", force: false }, endpoint: "/git/refs", method: "POST", status: 201 },
  { mutation: "draft-release-create", target: { release_id: "9006001", tag: "v0.6.14", target_commitish: candidateSourceRevisionV20, draft: true, prerelease: false }, endpoint: "/releases", method: "POST", status: 201 },
  { mutation: "image-publish", target: { registry: "docker-push.nexus.int.codicarium.com", repository: "codicarium/deployment-controller", reference: "v0.6.14", digest: "sha256:" + imagePublishDigestV20 }, endpoint: "/v2/codicarium/deployment-controller/manifests/v0.6.14", method: "PUT", status: 201 },
  { mutation: "chart-publish", target: { registry: "charts.nexus.int.codicarium.com", repository: "codicarium/deployment-controller", version: "0.6.14", digest: "sha256:" + chartPublishDigestV20 }, endpoint: "/v2/codicarium/deployment-controller/manifests/0.6.14", method: "PUT", status: 201 },
  ...assetNames.map((name, index) => ({
    mutation: "release-asset-create",
    target: { release_id: "9006001", asset_id: String(9400001 + index), name, size: String(index + 1), sha256: sha256(Buffer.from("asset-body-" + String(index + 1), "utf8")) },
    endpoint: "/releases/9006001/assets",
    method: "POST",
    status: 201
  })),
  { mutation: "release-finalize", target: { release_id: "9006001", tag: "v0.6.14", target_commitish: candidateSourceRevisionV20, draft: false, prerelease: false }, endpoint: "/releases/9006001", method: "PATCH", status: 200 }
];
if (publicationTargetsV20.length !== 19) throw new Error("publication plan must contain exactly 19 mutations");
const verifierTargetV20 = {
  ...fixtureAuthorityMarkerV20,
  fixture_identity_jcs_sha256: claimIdentityDigestV20,
  workflow: `codicarium/deployment-controller/${verifierWorkflowPathV20}`,
  ref: "refs/heads/main",
  workflow_sha: reviewedWorkflowRevisionV20,
  tag: "v0.6.14",
  source_revision: candidateSourceRevisionV20
};
const publisherTargetV20 = publisherDispatchRequestV20;
const authorizationTargetCoreV20 = {
  schema: "codicarium.release-verification-authorization/v1",
  ...fixtureAuthorityMarkerV20,
  fixture_identity_jcs_sha256: claimIdentityDigestV20,
  claim_key: claimKeyV20,
  evidence_sha256: digestJcsV20(candidateEvidenceFixture),
  verifier_run_id: "9003001",
  verifier_run_attempt: "1"
};
const authorizationTargetV20 = {
  ...authorizationTargetCoreV20,
  authorization_sha256: digestJcsV20(authorizationTargetCoreV20)
};
const verifierOperationV20 = makeOperationV20("verifier-dispatch", null, "POST", "/actions/workflows/release-verify-v2.yaml/dispatches", "verifier-target-writer", verifierTargetV20, 200, {
  workflow_run_id: "9003001",
  workflow_run_url: "https://api.github.com/repos/codicarium/deployment-controller/actions/runs/9003001",
  workflow_run_html_url: "https://github.com/codicarium/deployment-controller/actions/runs/9003001",
  run_attempt: "1",
  workflow_sha: reviewedWorkflowRevisionV20,
  conclusion: "success"
}, githubDispatchTransportV20);
const authorizationOperationV20 = makeOperationV20("verification-authorization", null, "POST", "/release-journal/verification-authorization", "verifier-target-writer", authorizationTargetV20, 201, authorizationTargetV20);
const publisherOperationV20 = makeOperationV20("publisher-dispatch", "0", "POST", "/actions/workflows/publish-release-v2.yaml/dispatches", "publisher-target-writer", publisherTargetV20, 200, {
  workflow_run_id: "9005001",
  workflow_run_url: "https://api.github.com/repos/codicarium/deployment-controller/actions/runs/9005001",
  workflow_run_html_url: "https://github.com/codicarium/deployment-controller/actions/runs/9005001",
  run_attempt: "1",
  workflow_sha: reviewedWorkflowRevisionV20,
  conclusion: "queued"
}, githubDispatchTransportV20);
const mutationOperationsV20 = publicationTargetsV20.map((item, index) => makeOperationV20(item.mutation, String(index + 1), item.method, item.endpoint, "publisher-target-writer-" + String(index + 1).padStart(2, "0"), item.target, item.status, item.target));
const allOperationEvidenceV20 = [verifierOperationV20, authorizationOperationV20, publisherOperationV20, ...mutationOperationsV20];

const journalIdV20 = "jrnl-v1-" + claimIdentityDigestV20.slice(0, 32);
const journalRecordsV20 = [];
let previousJournalEntryShaV20 = zeroSha256V20;
const journalTimestampV20 = (ordinal) => "2026-01-01T00:" + String(Math.floor((ordinal - 1) / 60)).padStart(2, "0") + ":" + String((ordinal - 1) % 60).padStart(2, "0") + "Z";
const appendJournalV20 = (event, publicationSequence, payload, role) => {
  const ordinal = journalRecordsV20.length + 1;
  const capabilityByRole = {
    claimer: ["journal:claim"],
    reserver: ["journal:reserve"],
    committer: payload.phase === "complete" ? ["journal:complete"] : ["journal:commit"],
    authorizer: ["journal:authorize"]
  };
  const body = {
    schema: "codicarium.release-journal-entry/v1",
    ...fixtureAuthorityMarkerV20,
    fixture_identity_jcs_sha256: claimIdentityDigestV20,
    journal_id: journalIdV20,
    ordinal: String(ordinal),
    event,
    claim_key: claimKeyV20,
    publication_sequence: publicationSequence,
    previous_entry_sha256: previousJournalEntryShaV20,
    payload,
    actor: {
      principal: "release-control-" + role,
      role,
      capabilities: capabilityByRole[role],
      can_mutate_targets: false,
      can_sign: false,
      can_commit: role === "committer"
    },
    created_at: journalTimestampV20(ordinal)
  };
  const entry = signTransitV20(body);
  const record = { entry, entry_sha256: digestJcsV20(entry) };
  journalRecordsV20.push(record);
  previousJournalEntryShaV20 = record.entry_sha256;
  return record;
};
const payloadV20 = (operation, phase, requestSha, resultSha, reservationSha, receiptSha, runId, outcome) => ({
  operation,
  phase,
  request_sha256: requestSha,
  result_sha256: resultSha,
  reservation_entry_sha256: reservationSha,
  publication_receipt_sha256: receiptSha,
  workflow_run_id: runId,
  outcome
});
appendJournalV20("claim", null, payloadV20("release-claim", "claim", claimIdentityDigestV20, digestJcsV20(claimCasFixtureV20), null, null, "9004001", "CLAIMED"), "claimer");
const verifierReservationV20 = appendJournalV20("verifier-dispatch-reserve", null, payloadV20("verifier-dispatch", "reserve", verifierOperationV20.request_sha256, null, null, null, null, "RESERVED"), "reserver");
appendJournalV20("verifier-dispatch-commit", null, payloadV20("verifier-dispatch", "commit", verifierOperationV20.request_sha256, verifierOperationV20.readback_sha256, verifierReservationV20.entry_sha256, null, "9003001", "COMMITTED"), "committer");
appendJournalV20("verification-authorization", null, payloadV20("verification-authorization", "authorize", authorizationOperationV20.request_sha256, authorizationOperationV20.readback_sha256, null, null, "9003001", "AUTHORIZED"), "authorizer");
const publisherReservationV20 = appendJournalV20("publisher-dispatch-reserve", "0", payloadV20("publisher-dispatch", "reserve", publisherOperationV20.request_sha256, null, null, null, null, "RESERVED"), "reserver");
const dispatchReceiptFixtureV20 = signTransitV20({
  schema: "codicarium.publisher-dispatch-receipt/v2",
  ...fixtureAuthorityMarkerV20,
  fixture_identity_jcs_sha256: claimIdentityDigestV20,
  kind: "publisher-dispatch",
  claim_key: claimKeyV20,
  active_source_revision: candidateSourceRevisionV20,
  claim_identity_jcs_sha256: claimIdentityDigestV20,
  protected_main_revision: reviewedWorkflowRevisionV20,
  sequence: "0",
  previous_receipt_sha256: zeroSha256V20,
  reservation_entry_sha256: publisherReservationV20.entry_sha256,
  authorization_sha256: authorizationTargetV20.authorization_sha256,
  handoff_sha256: sha256(releaseHandoffBytesV20),
  legacy_raw_identity_authority: false,
  dispatch_request_sha256: publisherOperationV20.request_sha256,
  dispatch_readback_sha256: publisherOperationV20.readback_sha256,
  publisher_workflow: `codicarium/deployment-controller/${publisherWorkflowPathV20}`,
  publisher_workflow_sha: reviewedWorkflowRevisionV20,
  publisher_ref: "refs/heads/main",
  publisher_revision: reviewedWorkflowRevisionV20,
  publisher_run_id: "9005001",
  publisher_run_attempt: "1",
  issued_at: "2026-01-01T00:00:05Z",
  issuer: { kind: "vault-transit", principal: "release-journal-signer", vault_role: "release-journal-sign-v1", can_mutate_targets: false, can_commit_journal: false }
});
const dispatchReceiptShaV20 = digestJcsV20(dispatchReceiptFixtureV20);
const publisherCommitV20 = appendJournalV20("publisher-dispatch-commit", "0", payloadV20("publisher-dispatch", "commit", publisherOperationV20.request_sha256, publisherOperationV20.readback_sha256, publisherReservationV20.entry_sha256, dispatchReceiptShaV20, "9005001", "COMMITTED"), "committer");

let previousPublicationReceiptShaV20 = dispatchReceiptShaV20;
const mutationReceiptFixturesV20 = [];
const publicationCommitEntriesV20 = [{ sequence: "0", entry_sha256: publisherCommitV20.entry_sha256, receipt_sha256: dispatchReceiptShaV20 }];
for (let index = 0; index < publicationTargetsV20.length; index += 1) {
  const sequence = String(index + 1);
  const item = publicationTargetsV20[index];
  const operation = mutationOperationsV20[index];
  const reservation = appendJournalV20("mutation-reserve", sequence, payloadV20(item.mutation, "reserve", operation.request_sha256, null, null, null, null, "RESERVED"), "reserver");
  const receipt = signTransitV20({
    schema: "codicarium.publisher-mutation-receipt/v2",
    ...fixtureAuthorityMarkerV20,
    fixture_identity_jcs_sha256: claimIdentityDigestV20,
    kind: "publisher-mutation",
    claim_key: claimKeyV20,
    sequence,
    previous_receipt_sha256: previousPublicationReceiptShaV20,
    reservation_entry_sha256: reservation.entry_sha256,
    mutation: item.mutation,
    request_sha256: operation.request_sha256,
    readback_sha256: operation.readback_sha256,
    publisher_ref: "refs/heads/main",
    publisher_revision: reviewedWorkflowRevisionV20,
    publisher_run_id: "9005001",
    publisher_run_attempt: "1",
    issued_at: "2026-01-01T00:" + String(index + 1).padStart(2, "0") + ":00Z",
    issuer: { kind: "vault-transit", principal: "release-journal-signer", vault_role: "release-journal-sign-v1", can_mutate_targets: false, can_commit_journal: false },
    target: item.target
  });
  const receiptSha = digestJcsV20(receipt);
  const commit = appendJournalV20("mutation-commit", sequence, payloadV20(item.mutation, "commit", operation.request_sha256, operation.readback_sha256, reservation.entry_sha256, receiptSha, "9005001", "COMMITTED"), "committer");
  mutationReceiptFixturesV20.push(receipt);
  publicationCommitEntriesV20.push({ sequence, entry_sha256: commit.entry_sha256, receipt_sha256: receiptSha });
  previousPublicationReceiptShaV20 = receiptSha;
}
appendJournalV20("complete", null, payloadV20("release", "complete", null, previousPublicationReceiptShaV20, null, null, "9005001", "COMPLETE"), "committer");
if (journalRecordsV20.length !== 45 || mutationReceiptFixturesV20.length !== 19 || publicationCommitEntriesV20.length !== 20) throw new Error("journal or receipt cardinality mismatch");

const journalFixtureV20 = {
  schema: "codicarium.release-journal-fixture/v1",
  ...fixtureAuthorityMarkerV20,
  fixture_identity_jcs_sha256: claimIdentityDigestV20,
  claim_key: claimKeyV20,
  storage: {
    authority: "dedicated-dev-postgresql-not-s3",
    desired_endpoint: "runner-platform-journal-rw.runner-platform-journal-dev.svc.cluster.local:5432",
    live_status: "PREACTIVATION_NOT_MATERIALIZED",
    transactions: "SERIALIZABLE",
    synchronous_commit: "on",
    synchronous_replicas: "REQUIRED_PREACTIVATION_NOT_PROVEN",
    append_only: true,
    constraints: ["PRIMARY KEY entry_id", "UNIQUE claim_key+ordinal", "UNIQUE claim_key+event+publication_sequence", "NOT NULL and CHECK closed enums"],
    runtime_grants: "CONNECT,USAGE,SELECT(read_view),EXECUTE(exact SECURITY DEFINER procedures)",
    runtime_revocations: "CREATE,INSERT,UPDATE,DELETE,TRUNCATE,DDL,PUBLIC",
    write_api: "stored-procedures-only",
    update_endpoint: false,
    delete_endpoint: false,
    tls_status: "BLOCKED_UNTIL_VERIFY_FULL_CA_CONTRACT_EXISTS"
  },
  procedure_migration: journalProcedureMigrationV20,
  github_dispatch_contract: githubDispatchContractV20,
  role_separation: {
    target_writer_can_sign_or_commit: false,
    signer_can_mutate_or_commit: false,
    committer_can_mutate_or_sign: false
  },
  operations: allOperationEvidenceV20,
  entries: journalRecordsV20,
  terminal_state: "complete"
};
writeJson("release-journal-v1.fixture.json", journalFixtureV20);
writeJson("publisher-dispatch-receipt-v1.fixture.json", dispatchReceiptFixtureV20);
writeJson("publisher-mutation-receipt-v1.fixture.json", {
  schema: "codicarium.publisher-mutation-receipts-fixture/v2",
  ...fixtureAuthorityMarkerV20,
  fixture_identity_jcs_sha256: claimIdentityDigestV20,
  receipts: mutationReceiptFixturesV20
});

const kubeContextBindingSchemaV20 = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.codicarium.com/platform/kube-context-binding-v1.schema.json",
  title: "Fail-before-mutation codicarium-dev kube binding",
  ...closed(
    ["schema", "kubeconfig", "context", "api_server", "ca_pem_sha256", "kube_system_uid", "kubernetes_service", "dns", "monitoring", "commands", "mutation_guard"],
    {
      schema: { const: "codicarium.kube-context-binding/v1" },
      kubeconfig: { const: "/home/rickebo/.kube/codicarium-dev.yaml" },
      context: { const: "codicarium-dev" },
      api_server: { const: "https://10.99.0.21:6443" },
      ca_pem_sha256: { const: "c73f41a70db74a9e1020ce84bf27227e0523055d3156d8d47ef31d41a3e3b935" },
      kube_system_uid: { const: "03dea961-55e6-4141-bb23-6cb4b9f79681" },
      kubernetes_service: closed(
        ["namespace", "service", "cluster_ip", "port", "accepted_audience", "accepted_audience_status", "ca_pem_sha256", "certificate_dns_san", "tls_san_status", "discovery_command"],
        {
          namespace: { const: "default" },
          service: { const: "kubernetes" },
          cluster_ip: { const: "10.43.0.1" },
          port: { const: 443 },
          accepted_audience: { const: "https://kubernetes.default.svc" },
          accepted_audience_status: { const: "REQUIRED_PREACTIVATION_TOKENREVIEW_PROBE" },
          ca_pem_sha256: { const: "c73f41a70db74a9e1020ce84bf27227e0523055d3156d8d47ef31d41a3e3b935" },
          certificate_dns_san: { const: "kubernetes.default.svc" },
          tls_san_status: { const: "REQUIRED_PREACTIVATION_TLS_PROBE" },
          discovery_command: { const: "kubectl --kubeconfig=/home/rickebo/.kube/codicarium-dev.yaml --context=codicarium-dev --namespace=default get service kubernetes" }
        }
      ),
      dns: closed(["namespace", "service", "cluster_ip", "port", "protocols"], {
        namespace: { const: "kube-system" },
        service: { const: "kube-dns" },
        cluster_ip: { const: "10.43.0.10" },
        port: { const: 53 },
        protocols: { const: ["UDP", "TCP"] }
      }),
      monitoring: closed(["namespace", "namespace_uid", "namespace_labels", "prometheus_pod_labels"], {
        namespace: { const: "monitoring" },
        namespace_uid: { const: "f78cd9cb-d069-4bde-bc56-33686eef5968" },
        namespace_labels: { const: ["kubernetes.io/metadata.name=monitoring"] },
        prometheus_pod_labels: { const: ["app.kubernetes.io/instance=prometheus-stack-prometheus", "app.kubernetes.io/name=prometheus", "operator.prometheus.io/name=prometheus-stack-prometheus", "operator.prometheus.io/shard=0", "prometheus=prometheus-stack-prometheus"] }
      }),
      commands: { type: "array", minItems: 4, uniqueItems: true, items: { type: "string", minLength: 1 } },
      mutation_guard: { const: "Every cluster command includes the exact --kubeconfig and --context flags; server, CA PEM SHA-256, context, or kube-system UID mismatch exits before every mutation." }
    }
  )
};
const kubePrefixV20 = "kubectl --kubeconfig=/home/rickebo/.kube/codicarium-dev.yaml --context=codicarium-dev ";
const kubeContextBindingFixtureV20 = {
  schema: "codicarium.kube-context-binding/v1",
  kubeconfig: "/home/rickebo/.kube/codicarium-dev.yaml",
  context: "codicarium-dev",
  api_server: "https://10.99.0.21:6443",
  ca_pem_sha256: "c73f41a70db74a9e1020ce84bf27227e0523055d3156d8d47ef31d41a3e3b935",
  kube_system_uid: "03dea961-55e6-4141-bb23-6cb4b9f79681",
  kubernetes_service: {
    namespace: "default",
    service: "kubernetes",
    cluster_ip: "10.43.0.1",
    port: 443,
    accepted_audience: "https://kubernetes.default.svc",
    accepted_audience_status: "REQUIRED_PREACTIVATION_TOKENREVIEW_PROBE",
    ca_pem_sha256: "c73f41a70db74a9e1020ce84bf27227e0523055d3156d8d47ef31d41a3e3b935",
    certificate_dns_san: "kubernetes.default.svc",
    tls_san_status: "REQUIRED_PREACTIVATION_TLS_PROBE",
    discovery_command: "kubectl --kubeconfig=/home/rickebo/.kube/codicarium-dev.yaml --context=codicarium-dev --namespace=default get service kubernetes"
  },
  dns: { namespace: "kube-system", service: "kube-dns", cluster_ip: "10.43.0.10", port: 53, protocols: ["UDP", "TCP"] },
  monitoring: {
    namespace: "monitoring",
    namespace_uid: "f78cd9cb-d069-4bde-bc56-33686eef5968",
    namespace_labels: ["kubernetes.io/metadata.name=monitoring"],
    prometheus_pod_labels: ["app.kubernetes.io/instance=prometheus-stack-prometheus", "app.kubernetes.io/name=prometheus", "operator.prometheus.io/name=prometheus-stack-prometheus", "operator.prometheus.io/shard=0", "prometheus=prometheus-stack-prometheus"]
  },
  commands: [
    kubePrefixV20 + "config view --minify -o json",
    kubePrefixV20 + "get --raw=/version",
    kubePrefixV20 + "get namespace kube-system -o json",
    kubePrefixV20 + "get namespace monitoring -o json"
  ],
  mutation_guard: "Every cluster command includes the exact --kubeconfig and --context flags; server, CA PEM SHA-256, context, or kube-system UID mismatch exits before every mutation."
};
writeJson("kube-context-binding-v1.schema.json", kubeContextBindingSchemaV20);
writeJson("kube-context-binding-v1.fixture.json", kubeContextBindingFixtureV20);

const retiredWorkflowIdsV20 = [
  ["341194538", "Automatic Release", ".github/workflows/automatic-release.yaml"],
  ["318365668", "Release Verify", ".github/workflows/release.yaml"],
  ["318365667", "Publish Release", ".github/workflows/publish-release.yaml"],
  ["333279414", "Recover Release Attestations", ".github/workflows/recover-release-attestations.yaml"],
  ["340335357", "Recover v0.6.8 Publisher Evidence", ".github/workflows/recover-release-v068.yaml"]
];
const retiredWorkflowItemSchemasV20 = retiredWorkflowIdsV20.map(([id, name, workflowPath]) => closed(
  ["id", "name", "path", "workflow_state", "path_state", "old_outputs_accepted", "reruns_accepted"],
  {
    id: { const: id },
    name: { const: name },
    path: { const: workflowPath },
    workflow_state: { const: "disabled_manually" },
    path_state: { const: "deleted-before-v0.6.14" },
    old_outputs_accepted: { const: false },
    reruns_accepted: { const: false }
  }
));
const recoveryRetirementSchemaV20 = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.codicarium.com/release/recovery-retirement-v1.schema.json",
  title: "Permanent retirement of five privileged workflow authorities",
  ...closed(
    ["schema", "must_complete_before", "workflows", "legacy_secret_authorities", "recovery_authorities", "replacement"],
    {
      schema: { const: "codicarium.recovery-retirement/v1" },
      must_complete_before: { const: "v0.6.14-first-release-side-effect" },
      workflows: { type: "array", minItems: 5, maxItems: 5, prefixItems: retiredWorkflowItemSchemasV20, items: false },
      legacy_secret_authorities: { const: ["ACTIONS_STORAGE_OVH_ACCESS_KEY_ID", "ACTIONS_STORAGE_OVH_ACCESS_KEY_SECRET", "CODICARIUM_PACKAGE_REGISTRY_PASSWORD", "CODICARIUM_PACKAGE_REGISTRY_USERNAME", "NEXUS_PASSWORD", "NEXUS_USERNAME"] },
      recovery_authorities: closed(
        ["v068_s3_credentials", "environments", "runner_routing", "revoked"],
        {
          v068_s3_credentials: { const: ["V068_RECOVERY_S3_READ_ACCESS_KEY_ID", "V068_RECOVERY_S3_READ_ACCESS_KEY_SECRET"] },
          environments: { const: ["deployment-controller-attestation-recovery", "deployment-controller-v068-recovery"] },
          runner_routing: { const: "[self-hosted,Linux,codicarium] and its general runner group" },
          revoked: { const: true }
        }
      ),
      replacement: closed(
        ["activation_time", "workflow_path", "workflow_id", "mutation_broker", "target_count", "contents_write", "broad_token", "reusable_secret", "signing_key"],
        {
          activation_time: { const: "strictly-after-verified-v0.6.14" },
          workflow_path: { const: ".github/workflows/recover-release-v068-v2.yaml" },
          workflow_id: { const: "NEW_ID_NOT_ANY_RETIRED_ID" },
          mutation_broker: { const: "typed-one-target" },
          target_count: { const: 1 },
          contents_write: { const: false },
          broad_token: { const: false },
          reusable_secret: { const: false },
          signing_key: { const: false }
        }
      )
    }
  )
};
const recoveryRetirementFixtureV20 = {
  schema: "codicarium.recovery-retirement/v1",
  must_complete_before: "v0.6.14-first-release-side-effect",
  workflows: retiredWorkflowIdsV20.map(([id, name, workflowPath]) => ({
    id,
    name,
    path: workflowPath,
    workflow_state: "disabled_manually",
    path_state: "deleted-before-v0.6.14",
    old_outputs_accepted: false,
    reruns_accepted: false
  })),
  legacy_secret_authorities: ["ACTIONS_STORAGE_OVH_ACCESS_KEY_ID", "ACTIONS_STORAGE_OVH_ACCESS_KEY_SECRET", "CODICARIUM_PACKAGE_REGISTRY_PASSWORD", "CODICARIUM_PACKAGE_REGISTRY_USERNAME", "NEXUS_PASSWORD", "NEXUS_USERNAME"],
  recovery_authorities: {
    v068_s3_credentials: ["V068_RECOVERY_S3_READ_ACCESS_KEY_ID", "V068_RECOVERY_S3_READ_ACCESS_KEY_SECRET"],
    environments: ["deployment-controller-attestation-recovery", "deployment-controller-v068-recovery"],
    runner_routing: "[self-hosted,Linux,codicarium] and its general runner group",
    revoked: true
  },
  replacement: {
    activation_time: "strictly-after-verified-v0.6.14",
    workflow_path: ".github/workflows/recover-release-v068-v2.yaml",
    workflow_id: "NEW_ID_NOT_ANY_RETIRED_ID",
    mutation_broker: "typed-one-target",
    target_count: 1,
    contents_write: false,
    broad_token: false,
    reusable_secret: false,
    signing_key: false
  }
};
writeJson("recovery-retirement-v1.schema.json", recoveryRetirementSchemaV20);
writeJson("recovery-retirement-v1.fixture.json", recoveryRetirementFixtureV20);

const migrationSnapshotSchemaV20 = closed(
  ["kind", "namespace", "name", "uid", "resource_version", "spec_sha256"],
  {
    kind: { type: "string", minLength: 1 },
    namespace: nullableV20({ type: "string", minLength: 1 }),
    name: { type: "string", minLength: 1 },
    uid: { type: "string", pattern: "^[0-9a-f-]{36}$" },
    resource_version: positiveDecimal,
    spec_sha256: sha64
  }
);
const grantMigrationSchemaV20 = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.codicarium.com/platform/grant-migration-v1.schema.json",
  title: "UID-aware no-dual-owner runner-config-dev grant migration",
  ...closed(
    ["schema", "repository_id", "environment", "uniqueness_key", "current_grant", "new_profile", "activation_compatibility", "preserved_objects", "steps", "rollback"],
    {
      schema: { const: "codicarium.grant-migration/v1" },
      repository_id: { const: "1303372884" },
      environment: { const: "dev" },
      uniqueness_key: { const: "repository_id=1303372884/environment=dev/max_grants=1" },
      current_grant: closed(
        ["name", "uid", "resource_version", "profile_ref", "profile_ref_immutable", "profile_uid", "duplicate_repo_environment_grant_allowed"],
        {
          name: { const: "runner-config-dev" },
          uid: { const: "60cf8514-cbc3-4659-ba5c-22c4d4658bae" },
          resource_version: { const: "27561715" },
          profile_ref: { const: "arc-path-helm" },
          profile_ref_immutable: { const: true },
          profile_uid: { const: "868dbd03-3a59-43bd-9c70-e393eb69d8eb" },
          duplicate_repo_environment_grant_allowed: { const: false }
        }
      ),
      new_profile: closed(
        ["name", "create_before_grant_retirement", "preserve_existing_arc_scopes", "resources", "destinations"],
        {
          name: { const: "artifact-capability-path-helm" },
          create_before_grant_retirement: { const: true },
          preserve_existing_arc_scopes: { const: true },
          resources: { const: ["Certificate", "Deployment", "Issuer", "Job", "NetworkPolicy", "PodDisruptionBudget", "PrometheusRule", "Service", "ServiceAccount", "ServiceMonitor"] },
          destinations: { const: ["arc-runners", "arc-systems", "artifact-capability"] }
        }
      ),
      activation_compatibility: closed(
        ["chosen_runtime_mode", "environment", "deployment_activation_source", "request_ref_required", "kafka_required", "poll_only_admissible", "current_main_impact"],
        {
          chosen_runtime_mode: { const: "event-driven" },
          environment: { const: "dev" },
          deployment_activation_source: { type: "null" },
          request_ref_required: { const: true },
          kafka_required: { const: true },
          poll_only_admissible: { const: false },
          current_main_impact: { const: "#103 PollOnly remains prod-only; dev runner-config-dev preserves event-driven RequestRef+Kafka authority and tests reject PollOnly/dev." }
        }
      ),
      preserved_objects: { type: "array", minItems: 5, maxItems: 5, items: migrationSnapshotSchemaV20 },
      steps: { type: "array", minItems: 10, uniqueItems: true, items: { type: "string", minLength: 1 } },
      rollback: { const: "preactivation-only; after new authorization epoch activation use forward remediation, never restore old UID, proof, activation, work, or dual ownership" }
    }
  )
};
const grantMigrationFixtureV20 = {
  schema: "codicarium.grant-migration/v1",
  repository_id: "1303372884",
  environment: "dev",
  uniqueness_key: "repository_id=1303372884/environment=dev/max_grants=1",
  current_grant: {
    name: "runner-config-dev",
    uid: "60cf8514-cbc3-4659-ba5c-22c4d4658bae",
    resource_version: "27561715",
    profile_ref: "arc-path-helm",
    profile_ref_immutable: true,
    profile_uid: "868dbd03-3a59-43bd-9c70-e393eb69d8eb",
    duplicate_repo_environment_grant_allowed: false
  },
  new_profile: {
    name: "artifact-capability-path-helm",
    create_before_grant_retirement: true,
    preserve_existing_arc_scopes: true,
    resources: ["Certificate", "Deployment", "Issuer", "Job", "NetworkPolicy", "PodDisruptionBudget", "PrometheusRule", "Service", "ServiceAccount", "ServiceMonitor"],
    destinations: ["arc-runners", "arc-systems", "artifact-capability"]
  },
  activation_compatibility: {
    chosen_runtime_mode: "event-driven",
    environment: "dev",
    deployment_activation_source: null,
    request_ref_required: true,
    kafka_required: true,
    poll_only_admissible: false,
    current_main_impact: "#103 PollOnly remains prod-only; dev runner-config-dev preserves event-driven RequestRef+Kafka authority and tests reject PollOnly/dev."
  },
  preserved_objects: [
    { kind: "AppProject", namespace: "argocd", name: "repo-runner-config-dev", uid: "59f950a3-11f2-49c7-bd38-90948df75872", resource_version: "26616740", spec_sha256: "78f44d4efdc2ea55c1ea7b527d863fb8c8c15170909750bb17d3e84b8670e468" },
    { kind: "Application", namespace: "argocd", name: "actions-runner-controller-codicarium", uid: "ff536ac7-51db-4256-8c81-6b8ef3ffda26", resource_version: "43334823", spec_sha256: "8f0e23deb6dd6c99879342af99c967ac2289834af9f989088c335cc33b7612fd" },
    { kind: "Application", namespace: "argocd", name: "actions-runner-scale-set-codicarium", uid: "586b3e1e-c5bb-4bf0-b7a9-fcaa9446ded7", resource_version: "43335012", spec_sha256: "b33e3502fd7b12cbb4f72b8524a2db97b8b2232e0b7d2363b8bd22cd6c0d9553" },
    { kind: "AutoscalingRunnerSet", namespace: "arc-runners", name: "codicarium-linux", uid: "4ef54624-27dc-464a-9215-54cc0b4b1eb9", resource_version: "43332160", spec_sha256: "1bd8af51c30bd7204cf1aec21684566fa3c5f4a28d3fa1c66477d7bf35d0809e" },
    { kind: "AutoscalingListener", namespace: "arc-systems", name: "codicarium-linux-5b84bf57-listener", uid: "c79f2712-6e1b-49d4-988c-ca1e73873ce1", resource_version: "26616851", spec_sha256: "9c1ed0b3dbf84e2a4b51adf583b76aa9d04a44251aba11cc5305703ee06a9d69" }
  ],
  steps: [
    "verify exact kube binding before any mutation",
    "create artifact-capability-path-helm before touching runner-config-dev",
    "freeze delivery activation reconciliation and generated-write actors",
    "snapshot exact UIDs resourceVersions managed fields and canonical spec hashes",
    "delete old runner-config-dev with exact UID and resourceVersion preconditions",
    "prove runner-config-dev absent and no duplicate repository/environment grant exists",
    "prove old RepositoryDeployment activation proof and work are orphaned fail-closed",
    "prove preserved AppProject Applications and ARC workloads retain exact UIDs and specs",
    "recreate runner-config-dev with the same name and new profile as a new authorization epoch",
    "reject every old activation proof work item UID and epoch",
    "activate only after journal network Kata proxy Vault TLS and three-node gates pass"
  ],
  rollback: "preactivation-only; after new authorization epoch activation use forward remediation, never restore old UID, proof, activation, work, or dual ownership"
};
writeJson("grant-migration-v1.schema.json", grantMigrationSchemaV20);
writeJson("grant-migration-v1.fixture.json", grantMigrationFixtureV20);

const combinedPeerV20 = (namespace, serviceAccount, labels) => ({
  namespace,
  service_account: serviceAccount,
  pod_labels: [...labels, `codicarium.com/service-account=${serviceAccount}`],
  selector_combination: "same-peer-namespaceSelector-AND-podSelector-plus-exact-ServiceAccount"
});
const candidateSourceTarBytesV20 = fs.readFileSync(path.join(fixtureDir, "canonical-archive-v1.tar"));
const candidateSourceArchiveBytesV20 = zlib.gzipSync(candidateSourceTarBytesV20, { level: 9, mtime: 0 });
if (candidateSourceArchiveBytesV20[0] !== 0x1f || candidateSourceArchiveBytesV20[1] !== 0x8b || candidateSourceArchiveBytesV20[2] !== 0x08 || candidateSourceArchiveBytesV20.readUInt32LE(4) !== 0) throw new Error("candidate source gzip is not deterministic");
const candidateSourceArchiveShaV20 = sha256(candidateSourceArchiveBytesV20);
const candidateSourceArchiveByteLengthV20 = String(candidateSourceArchiveBytesV20.length);
const candidateSourceArchiveBytesBase64V20 = candidateSourceArchiveBytesV20.toString("base64");
const candidateSourceTarShaV20 = sha256(candidateSourceTarBytesV20);
const candidateSourceTarByteLengthV20 = String(candidateSourceTarBytesV20.length);
const candidateInputObjectKeyV20 = `candidate-inputs/v1/repos/1303901324/commits/${candidateSourceRevisionV20}/sha256/${candidateSourceArchiveShaV20}.tar.gz`;
const sourceFetcherImageDigestV20 = digestJcsV20({ schema: "codicarium.source-fetcher-image-fixture/v1", component: "release-source-fetcher", contract: "opaque-no-exec" });
const kataBootstrapImageDigestV20 = digestJcsV20({ schema: "codicarium.kata-bootstrap-image-fixture/v1", component: "candidate-bootstrap", archive_policy: "safe-scan-before-extract" });
const identityVerifierContractV20 = ({ name, serviceAccountNamespace, serviceAccount, podNamespaces }) => ({
  schema: "codicarium.kubernetes-tokenreview-pod-verifier/v1",
  name,
  service_account: { namespace: serviceAccountNamespace, name: serviceAccount },
  api_client_identity: {
    automount_service_account_token: false,
    mechanism: "projected-bound-service-account-token",
    audience: kubeContextBindingFixtureV20.kubernetes_service.accepted_audience,
    expiration_seconds: 600,
    bound_object: "Pod",
    path: "/var/run/secrets/codicarium/kubernetes-api/token",
    mode: "0400",
    tokenrequest_api_permission: false
  },
  tokenreview_cluster_role: {
    name: `${name}-tokenreview`,
    rules: [{ api_groups: ["authentication.k8s.io"], resources: ["tokenreviews"], verbs: ["create"] }]
  },
  tokenreview_cluster_role_binding: {
    name: `${name}-tokenreview`,
    service_account: `${serviceAccountNamespace}/${serviceAccount}`
  },
  pod_namespace_roles: podNamespaces.map((namespace) => ({
    namespace,
    role: `${name}-pod-identity`,
    rules: [{ api_groups: [""], resources: ["pods"], verbs: ["get", "list", "watch"] }],
    role_binding: `${name}-pod-identity`,
    bound_service_account: `${serviceAccountNamespace}/${serviceAccount}`
  })),
  forbidden_rbac: {
    rbac_rules_exact_set: true,
    secret_access: false,
    tokenrequest_create: false,
    pod_exec_attach_or_log_access: false,
    pod_mutation: false,
    wildcard_api_groups_resources_or_verbs: false
  },
  authorization_inventory: {
    exact_subject: `system:serviceaccount:${serviceAccountNamespace}:${serviceAccount}`,
    no_other_role_or_cluster_role_binding_subject_references: true,
    self_subject_rules_review_exact_match: true,
    status: "REQUIRED_PREACTIVATION_LIVE_EVIDENCE"
  },
  kubernetes_api_egress: {
    kube_context_binding_sha256: digestJcsV20(kubeContextBindingFixtureV20),
    service_discovery_command: kubeContextBindingFixtureV20.kubernetes_service.discovery_command,
    service_namespace: kubeContextBindingFixtureV20.kubernetes_service.namespace,
    service_name: kubeContextBindingFixtureV20.kubernetes_service.service,
    destination_cidr: kubeContextBindingFixtureV20.kubernetes_service.cluster_ip + "/32",
    endpoint: `https://${kubeContextBindingFixtureV20.kubernetes_service.cluster_ip}:${kubeContextBindingFixtureV20.kubernetes_service.port}`,
    protocol: "TCP",
    port: kubeContextBindingFixtureV20.kubernetes_service.port,
    accepted_audience: kubeContextBindingFixtureV20.kubernetes_service.accepted_audience,
    accepted_audience_status: kubeContextBindingFixtureV20.kubernetes_service.accepted_audience_status,
    ca_path: "/var/run/secrets/codicarium/kubernetes-api/ca.crt",
    ca_pem_sha256: kubeContextBindingFixtureV20.kubernetes_service.ca_pem_sha256,
    certificate_dns_san: kubeContextBindingFixtureV20.kubernetes_service.certificate_dns_san,
    tls_san_status: kubeContextBindingFixtureV20.kubernetes_service.tls_san_status,
    tls_verify: true,
    network_policy_default_deny: true,
    other_api_destination_or_port_allowed: false
  }
});
const proxyIdentityVerifierV20 = identityVerifierContractV20({
  name: "codicarium-egress-proxy-identity-verifier",
  serviceAccountNamespace: "platform-egress",
  serviceAccount: "codicarium-private-egress-proxy",
  podNamespaces: ["arc-runners-v2-control", "artifact-capability"]
});
const candidateBrokerIdentityVerifierV20 = identityVerifierContractV20({
  name: "artifact-capability-candidate-identity-verifier",
  serviceAccountNamespace: "artifact-capability",
  serviceAccount: "artifact-capability",
  podNamespaces: ["arc-runners-v2-untrusted"]
});
const candidateInputDeliveryV20 = {
  schema: "codicarium.candidate-input-delivery/v1",
  ...fixtureAuthorityMarkerV20,
  fixture_identity_jcs_sha256: claimIdentityDigestV20,
  repository_id: "1303901324",
  repository: "codicarium/deployment-controller",
  commit_sha: candidateSourceRevisionV20,
  source_url: `https://codeload.github.com/codicarium/deployment-controller/tar.gz/${candidateSourceRevisionV20}`,
  archive_sha256: candidateSourceArchiveShaV20,
  byte_length: candidateSourceArchiveByteLengthV20,
  archive_bytes_base64: candidateSourceArchiveBytesBase64V20,
  archive_bytes_evidence_class: "synthetic-conformance-byte-oracle-not-live-codeload-response",
  archive_bytes_live_codeload_response: false,
  archive_format: "gzip-compressed-posix-ustar",
  uncompressed_tar_sha256: candidateSourceTarShaV20,
  uncompressed_tar_byte_length: candidateSourceTarByteLengthV20,
  content_type: "application/gzip",
  object_key: candidateInputObjectKeyV20,
  live_delivery_requirements: {
    status: "PENDING_LIVE_CANDIDATE_SOURCE_DISCOVERY",
    source_url_template: "https://codeload.github.com/codicarium/deployment-controller/tar.gz/{live_candidate_source_sha}",
    fetch_exact_raw_response_bytes: true,
    compute_archive_sha256_and_byte_length_from_raw_response: true,
    fixture_archive_bytes_forbidden: true,
    verify_repository_commit_and_response_before_broker_create: true,
    persist_create_receipt_and_one_read_binding: true
  },
  image_digest_evidence: {
    evidence_class: "synthetic-conformance-image-digest-fixture",
    live_registry_manifest_digest_and_all_kata_node_preload_readback_required: true,
    status: "REQUIRED_PREACTIVATION"
  },
  control: {
    namespace: "arc-runners-v2-control",
    service_account: "release-control",
    fetcher_image: `docker-pull.nexus.int.codicarium.com/codicarium/release-source-fetcher@sha256:${sourceFetcherImageDigestV20}`,
    image_pull_policy: "Never",
    image_preloaded: true,
    single_pid: true,
    shell_present: false,
    proxy_listener: "codicarium-private-egress-proxy.platform-egress.svc:8443",
    allowed_hosts: ["api.github.com", "codeload.github.com"],
    repository_identity_request: "GET https://api.github.com/repositories/1303901324",
    commit_identity_request: `GET https://api.github.com/repos/codicarium/deployment-controller/commits/${candidateSourceRevisionV20}`,
    fetch_mode: "opaque-stream-no-archive-parser",
    extracts_archive: false,
    executes_archive: false,
    child_execve_allowed: false,
    tls_verified: true,
    verifies: ["repository_id", "commit_sha", "source_url", "purpose", "object_key", "archive_sha256", "byte_length", "content_type"]
  },
  broker: {
    endpoint: "https://artifact-capability.artifact-capability.svc.cluster.local:8443",
    capability_endpoint: "POST /v1/capabilities",
    create_endpoint: "PUT /v1/object",
    read_endpoint: "GET /v1/object",
    purpose: "deployment-controller-candidate-source",
    operations: ["create", "read"],
    one_time: true,
    create_only: true,
    conflict_status: 409,
    mismatch_status: 422,
    read_replay_status: 410,
    cross_digest_status: 403,
    create_request_binds: ["repository_id", "commit_sha", "source_url", "purpose", "object_key", "archive_sha256", "byte_length", "content_type"],
    create_receipt_echoes: ["repository_id", "commit_sha", "source_url", "purpose", "object_key", "archive_sha256", "byte_length", "content_type"],
    read_capability_binds: ["token_jti", "pod_uid", "service_account_uid", "namespace", "repository_id", "commit_sha", "source_url", "purpose", "object_key", "archive_sha256", "byte_length", "content_type", "candidate_run_id", "candidate_run_attempt", "expires_at"],
    candidate_token_review: "authentication.k8s.io/v1 exact audience artifact-capability-candidate-read plus live source Pod UID/name/namespace/SA match",
    candidate_identity_verifier: candidateBrokerIdentityVerifierV20,
    one_successful_read: true,
    capability_ttl_seconds: 300
  },
  kata: {
    namespace: "arc-runners-v2-untrusted",
    service_account: "release-candidate-kata",
    runtime_class_name: "kata-clh-runtime-rs",
    automount_service_account_token: false,
    backoff_limit: 0,
    active_deadline_seconds: 1800,
    ttl_seconds_after_finished: 0,
    fetcher_image: `docker-pull.nexus.int.codicarium.com/codicarium/release-source-fetcher@sha256:${sourceFetcherImageDigestV20}`,
    bootstrap_image: `docker-pull.nexus.int.codicarium.com/codicarium/candidate-bootstrap@sha256:${kataBootstrapImageDigestV20}`,
    image_pull_policy: "Never",
    images_preloaded_on_all_kata_nodes: true,
    image_pull_secrets: false,
    candidate_selected_image: false,
    capability_identity: {
      mechanism: "projected-bound-service-account-token",
      audience: "artifact-capability-candidate-read",
      expiration_seconds: 300,
      token_request_bound_object: "Pod",
      projected_token_path: "/var/run/secrets/codicarium/candidate-read/token",
      projected_token_mode: "0400",
      broker_ca_path: "/var/run/secrets/codicarium/candidate-read/ca.crt",
      broker_ca_mode: "0400",
      automount_default_token: false,
      kubernetes_api_audience: false,
      egress_proxy_audience: false,
      token_review_required: true,
      bound_claims: ["token_jti", "namespace", "serviceaccount.name", "serviceaccount.uid", "pod.name", "pod.uid"],
      live_source_pod_match_required: true,
      one_object_digest_grant_registered_by_control: true,
      deleted_pod_expired_or_replayed: "DENY"
    },
    capability_reusable: false,
    capability_volume_init_only: true,
    capability_volume_removed_with_pod: true,
    input_volume: "memory emptyDir /input sizeLimit=1Gi init-write main-read-only",
    work_volume: "memory emptyDir /work sizeLimit=4Gi",
    host_path: false,
    persistent_volume: false,
    init_fetch_verifies: ["repository_id", "commit_sha", "source_url", "purpose", "object_key", "archive_sha256", "byte_length", "content_type"],
    archive_scan_before_extract: true,
    extraction_location: "inside-Kata-/work-only",
    rejects_archive_entries: ["absolute", "dot-dot", "backslash", "control-character", "duplicate", "hardlink", "symlink", "device", "fifo", "sparse", "extension-header"],
    exec_started_only_after_verified_extract: true,
    github_egress: false,
    registry_egress: false,
    proxy_egress: false
  },
  teardown: {
    applies_after_success_or_failure: true,
    job_absent: true,
    pod_absent: true,
    projected_token_volume_absent: true,
    broker_object_absent: true,
    broker_get_after_teardown_status: 410,
    input_and_work_volumes_absent: true,
    exec_marker_absent_on_verification_failure: true
  },
  negative_cases: [
    "repository-id-substitution",
    "commit-or-source-url-substitution",
    "object-key-digest-length-or-byte-substitution",
    "immutable-object-conflict",
    "cross-digest-token-use",
    "token-audience-pod-or-service-account-mismatch",
    "read-token-replay",
    "archive-path-link-device-sparse-or-extension-traversal",
    "control-child-execve-or-archive-parse",
    "success-or-failure-teardown-residue"
  ],
  negative_outcome: {
    exec_started: false,
    publication_mutations: 0,
    broker_read_committed: false,
    job_pod_token_object_and_memory_volumes_absent: true
  }
};
const proxyIdentityContractV20 = {
  schema: "codicarium.egress-proxy-identity/v1",
  mode: "projected-bound-service-account-token",
  audience: "codicarium-egress-proxy",
  expiration_seconds: 600,
  tls_only: true,
  server_certificate: {
    dns_san: "codicarium-private-egress-proxy.platform-egress.svc",
    duration_hours: 24,
    renew_before_hours: 8,
    plaintext_listener: false
  },
  token_review: {
    api_version: "authentication.k8s.io/v1",
    required_audience: "codicarium-egress-proxy",
    require_authenticated: true,
    error_timeout_or_unauthenticated: "DENY_NO_UPSTREAM"
  },
  identity_verifier: proxyIdentityVerifierV20,
  bound_claims: ["sub", "kubernetes.io.namespace", "kubernetes.io.serviceaccount.name", "kubernetes.io.serviceaccount.uid", "kubernetes.io.pod.name", "kubernetes.io.pod.uid"],
  source_pod_check: "peer Pod IP maps to one live Pod whose UID/name/namespace/serviceAccountName exactly equal TokenReview claims",
  rotation: { refresh_before_expiry_seconds: 120, reject_expired: true, delete_with_pod: true },
  replay: {
    request_nonce_header: "X-Codicarium-Proxy-Request-Nonce",
    duplicate_nonce: "DENY_NO_UPSTREAM",
    different_or_recreated_pod: "DENY_NO_UPSTREAM",
    token_jti_pod_uid_cache_seconds_max: 60,
    same_live_pod_unique_nonce_reuse_until_expiry: true
  },
  candidate_projection: false,
  bindings: {
    "8443": {
      namespace: "arc-runners-v2-control",
      service_account: "release-control",
      username: "system:serviceaccount:arc-runners-v2-control:release-control",
      automount_service_account_token: false,
      projected_token: { audience: "codicarium-egress-proxy", expiration_seconds: 600, path: "/var/run/secrets/codicarium/proxy/token", mode: "0400", bound_object: "Pod" }
    },
    "8444": {
      namespace: "artifact-capability",
      service_account: "artifact-capability",
      username: "system:serviceaccount:artifact-capability:artifact-capability",
      automount_service_account_token: false,
      projected_token: { audience: "codicarium-egress-proxy", expiration_seconds: 600, path: "/var/run/secrets/codicarium/proxy/token", mode: "0400", bound_object: "Pod" }
    }
  },
  listeners: {
    "8443": {
      principal: "system:serviceaccount:arc-runners-v2-control:release-control",
      host_methods: {
        "api.github.com": ["GET", "POST"],
        "codeload.github.com": ["GET"],
        "github.com": ["GET"],
        "objects.githubusercontent.com": ["GET"],
        "raw.githubusercontent.com": ["GET"],
        "release-assets.githubusercontent.com": ["GET"]
      }
    },
    "8444": {
      principal: "system:serviceaccount:artifact-capability:artifact-capability",
      host_methods: {
        "s3.sbg.io.cloud.ovh.net": ["GET", "HEAD", "PUT"],
        "token.actions.githubusercontent.com": ["GET"]
      }
    }
  },
  listener_host_method_confusion: "DENY_BEFORE_UPSTREAM",
  direct_upstream_or_proxy_bypass: false,
  network_policy_role: "transport-confinement-only-not-identity-proof",
  negative_cases: [
    "wrong-namespace-service-account-or-username",
    "pod-uid-name-namespace-or-source-ip-mismatch",
    "wrong-audience-expired-rotated-or-replayed-token",
    "tokenreview-error-timeout-or-unauthenticated",
    "plaintext-listener",
    "listener-host-or-method-confusion",
    "direct-upstream-or-proxy-bypass"
  ],
  negative_outcome: { upstream_requests: 0, dns_connection_and_http_forwarding: false }
};
const journalDatabasePeerV20 = combinedPeerV20("runner-platform-journal-dev", "runner-platform-journal", ["cnpg.io/cluster=runner-platform-journal"]);
const postgresClientFlowsV20 = [
  { source: combinedPeerV20("artifact-capability", "artifact-capability", ["app.kubernetes.io/name=artifact-capability"]), destination: journalDatabasePeerV20, protocol: "TCP", port: 5432, purpose: "broker-journal-database" },
  { source: combinedPeerV20("artifact-capability", "release-journal-migrator", ["app.kubernetes.io/name=release-journal-migration"]), destination: journalDatabasePeerV20, protocol: "TCP", port: 5432, purpose: "migration-journal-database" }
];
const postgresAccessContractV20 = {
  schema: "codicarium.release-journal-postgres-access/v1",
  activation: "BLOCKED_PREACTIVATION",
  database_name: "runner_platform_journal",
  service: "runner-platform-journal-rw.runner-platform-journal-dev.svc.cluster.local",
  port: 5432,
  tls_mode: "verify-full",
  network_policy: {
    client_ingress_flows: postgresClientFlowsV20,
    default_deny_all_other_clients: true,
    selectors: "combined exact namespace+pod label+workload spec.serviceAccountName",
    database_pod_ingress_default_deny: true,
    database_pod_egress_default_deny: true,
    client_pod_egress_default_deny: true,
    preserved_platform_flows: [
      { purpose: "streaming-replication", source: journalDatabasePeerV20, destination: journalDatabasePeerV20, protocol: "TCP", port: 5432 },
      { purpose: "cnpg-operator-management", source: combinedPeerV20("cnpg-system", "cloudnative-pg", ["app.kubernetes.io/name=cloudnative-pg"]), destination: journalDatabasePeerV20, protocol: "TCP", port: 8000 },
      { purpose: "cluster-dns", destination: "10.43.0.10/32", protocols: ["TCP", "UDP"], port: 53 },
      { purpose: "kubernetes-api", destination: "10.43.0.1/32", protocol: "TCP", port: 443 }
    ],
    activation_evidence: "rendered ingress and egress policies plus live denied unauthorized-client probe"
  },
  cnpg_bootstrap_credential: {
    secret_name: "runner-platform-journal-bootstrap-owner",
    created_by: "cloudnative-pg-operator",
    generated_at_runtime: true,
    rendered_by_helm: false,
    committed_to_git: false,
    external_secret_or_push_secret: false,
    exact_reader_service_account: "release-journal-bootstrap-transfer",
    exact_namespace: "runner-platform-journal-dev",
    uid_and_resource_version_preconditions_required: true,
    projected_volume_mode: "0400",
    read_count: 1,
    reusable: false
  },
  vault_transfer: {
    job: "release-journal-bootstrap-vault-transfer",
    source_secret: "runner-platform-journal-dev/runner-platform-journal-bootstrap-owner",
    destination_path: "codicarium/dev/release-journal/bootstrap-owner",
    write_semantics: "KV-v2 create-only version 1",
    readback: "metadata version and value SHA-256 only",
    vault_kubernetes_auth_role: "release-journal-bootstrap-transfer",
    source_secret_uid_and_resource_version_match_required: true,
    memory_only_transfer: true,
    log_or_artifact_value: false,
    delete_kubernetes_secret_after_verified_readback: true,
    prevent_operator_regeneration: true
  },
  roles: {
    bootstrap: { name: "release_journal_bootstrap", initial_login: true, final_login: false, connect_after_bootstrap: false, credential_destroyed_after_migration: true },
    owner: { name: "release_journal_owner", login: false, owns_database_and_schema: true },
    migrator: { name: "release_journal_migrator", login_during_migration_only: true, inherit: false, set_role_owner_during_reviewed_transaction_only: true, owner_membership_after_migration: false, login_after_migration: false, connect_after_migration: false, vault_credential_destroyed: true },
    runtime: { name: "release_journal_runtime", login: true, inherit_owner: false, owner_membership: false, database_temp: false, schema_create: false, direct_table_privileges: [], procedure_privileges: ["EXECUTE"] }
  },
  database_privileges: {
    public_connect: false,
    public_temp: false,
    runtime_connect: true,
    runtime_temp: false,
    runtime_schema_usage: true,
    runtime_schema_create: false,
    runtime_direct_dml: false,
    migrator_connect_after_migration: false
  },
  migration_job: {
    service_account: "release-journal-migrator",
    vault_agent_file_injection_only: true,
    external_secret: false,
    reviewed_migration_sha256_required: true,
    transactional: true,
    disables_own_identity_before_success: true,
    success_requires_no_login_no_connect_no_owner_membership: true
  },
  retirement: {
    bootstrap_secret_absent: true,
    bootstrap_vault_versions_destroyed: true,
    bootstrap_role_no_login: true,
    migration_pod_and_job_absent: true,
    migration_identity_disabled: true,
    migration_service_account_token_invalid: true,
    migration_vault_auth_role_deleted: true,
    migration_vault_versions_destroyed: true,
    runtime_never_received_bootstrap_or_migrator_credential: true
  },
  negative_cases: [
    "unauthorized-client-denied",
    "bootstrap-secret-second-read-denied",
    "bootstrap-secret-regeneration-denied",
    "runtime-owner-membership-denied",
    "runtime-direct-dml-denied",
    "runtime-or-public-database-temp-denied",
    "runtime-or-public-schema-create-denied",
    "temp-relation-and-function-shadow-denied",
    "migration-identity-persistence-denied",
    "retired-bootstrap-or-migrator-credential-reuse-denied"
  ]
};
const networkPeerSchemaV20 = closed(
  ["namespace", "service_account", "pod_labels", "selector_combination"],
  {
    namespace: { type: "string", minLength: 1 },
    service_account: { type: "string", minLength: 1 },
    pod_labels: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", pattern: "^[^=]+=[^=]+$" } },
    selector_combination: { const: "same-peer-namespaceSelector-AND-podSelector-plus-exact-ServiceAccount" }
  }
);
const networkFlowSchemaV20 = closed(
  ["source", "destination", "protocol", "port", "purpose"],
  {
    source: networkPeerSchemaV20,
    destination: networkPeerSchemaV20,
    protocol: { const: "TCP" },
    port: { enum: [5432, 8443, 9090] },
    purpose: { enum: ["candidate-broker", "trusted-control-broker", "prometheus-metrics", "broker-journal-database", "migration-journal-database"] }
  }
);
const networkConformanceSchemaV20 = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.codicarium.com/platform/network-conformance-v1.schema.json",
  title: "Fail-closed release-control network conformance",
  ...closed(
    ["schema", "activation", "broker", "candidate", "trusted_control", "proxies", "postgres_access", "vault_direct", "infra", "ingress_flows", "vault_reserved_path_policy"],
    {
      schema: { const: "codicarium.network-conformance/v1" },
      activation: { const: "BLOCKED_PREACTIVATION" },
      broker: closed(
        ["service", "namespace", "endpoint", "type", "tls", "certificate_dns_san", "tls_port", "metrics_port", "ingress_or_public_route", "direct_public_egress", "public_egress_via", "proxy_token_projection", "proxy_identity", "s3_hosts", "oidc_jwks_hosts", "journal_database"],
        {
          service: { const: "artifact-capability" },
          namespace: { const: "artifact-capability" },
          endpoint: { const: "https://artifact-capability.artifact-capability.svc.cluster.local:8443" },
          type: { const: "ClusterIP" },
          tls: { const: true },
          certificate_dns_san: { const: "artifact-capability.artifact-capability.svc.cluster.local" },
          tls_port: { const: 8443 },
          metrics_port: { const: 9090 },
          ingress_or_public_route: { const: false },
          direct_public_egress: { const: false },
          public_egress_via: { const: "codicarium-private-egress-proxy.platform-egress.svc:8444-only" },
          proxy_token_projection: { const: true },
          proxy_identity: { const: proxyIdentityContractV20.bindings["8444"] },
          s3_hosts: { const: ["s3.sbg.io.cloud.ovh.net"] },
          oidc_jwks_hosts: { const: ["token.actions.githubusercontent.com"] },
          journal_database: closed(["desired_service", "port", "direct_internal", "live_status", "tls_status"], {
            desired_service: { const: "runner-platform-journal-rw.runner-platform-journal-dev.svc.cluster.local" },
            port: { const: 5432 },
            direct_internal: { const: true },
            live_status: { const: "PREACTIVATION_NOT_MATERIALIZED" },
            tls_status: { const: "BLOCKED_UNTIL_VERIFY_FULL_CA_CONTRACT_EXISTS" }
          })
        }
      ),
      candidate: closed(
        ["execution", "runtime_class", "runtime_class_live", "default_or_kubernetes_api_service_account_token", "typed_broker_read_token", "proxy_token_projection", "github_egress", "proxy_egress", "public_egress", "allowed_egress", "input_delivery"],
        {
          execution: { const: "separate-destroyed-after-use-Kata-Job" },
          runtime_class: { const: "kata-clh-runtime-rs" },
          runtime_class_live: { const: false },
          default_or_kubernetes_api_service_account_token: { const: false },
          typed_broker_read_token: { const: true },
          proxy_token_projection: { const: false },
          github_egress: { const: false },
          proxy_egress: { const: false },
          public_egress: { const: false },
          allowed_egress: { const: ["DNS 10.43.0.10 TCP/UDP 53", "artifact-capability.artifact-capability.svc.cluster.local TCP 8443"] },
          input_delivery: { const: candidateInputDeliveryV20 }
        }
      ),
      trusted_control: closed(
        ["executes_candidate_source", "github_hosts", "direct_public_egress", "proxy_required", "proxy_listener", "proxy_token_projection", "proxy_identity"],
        {
          executes_candidate_source: { const: false },
          github_hosts: { const: ["api.github.com", "codeload.github.com", "github.com", "objects.githubusercontent.com", "raw.githubusercontent.com", "release-assets.githubusercontent.com"] },
          direct_public_egress: { const: false },
          proxy_required: { const: true },
          proxy_listener: { const: "codicarium-private-egress-proxy.platform-egress.svc:8443-only" },
          proxy_token_projection: { const: true },
          proxy_identity: { const: proxyIdentityContractV20.bindings["8443"] }
        }
      ),
      proxies: closed(
        ["owner", "live_status", "service", "github_listener", "broker_artifact_listener", "separate_listeners", "direct_bypass", "identity_authentication"],
        {
          owner: { const: "central-platform" },
          live_status: { const: "ABSENT_BLOCKER" },
          service: { const: "codicarium-private-egress-proxy.platform-egress.svc" },
          github_listener: { const: 8443 },
          broker_artifact_listener: { const: 8444 },
          separate_listeners: { const: true },
          direct_bypass: { const: false },
          identity_authentication: { const: proxyIdentityContractV20 }
        }
      ),
      postgres_access: { const: postgresAccessContractV20 },
      vault_direct: closed(
        ["owner", "status", "ip", "port", "sni", "ca_sha256", "proxy"],
        {
          owner: { const: "vault-config/infra" },
          status: { const: "MISSING_VERIFIED_INTERNAL_IP_PORT_SNI_CA_BLOCKER" },
          ip: { type: "null" },
          port: { type: "null" },
          sni: { type: "null" },
          ca_sha256: { type: "null" },
          proxy: { const: false }
        }
      ),
      infra: closed(
        ["generic_eligible_workers_live", "kata_v2_eligible_workers_live", "required_eligible_workers", "additional_workers_required", "control_node", "remaining_two_node_capacity_proven", "kata_runtime_present", "proxy_present"],
        {
          generic_eligible_workers_live: { const: 1 },
          kata_v2_eligible_workers_live: { const: 0 },
          required_eligible_workers: { const: 3 },
          additional_workers_required: { const: 2 },
          control_node: { const: "NoSchedule" },
          remaining_two_node_capacity_proven: { const: false },
          kata_runtime_present: { const: false },
          proxy_present: { const: false }
        }
      ),
      ingress_flows: { type: "array", minItems: 5, maxItems: 5, items: networkFlowSchemaV20 },
      vault_reserved_path_policy: closed(
        ["evidence_schema", "kv_metadata_inventory_access", "new_paths", "deny_rule_pairs", "partial_or_ancestor_only_evidence", "secret_seed"],
        {
          evidence_schema: { const: "2" },
          kv_metadata_inventory_access: { const: "reconciled" },
          new_paths: { const: ["codicarium/dev/release-journal/database-ca", "codicarium/dev/release-journal/runtime-password", "codicarium/dev/release-journal/bootstrap-owner", "codicarium/dev/release-journal/migrator-password", "codicarium/dev/artifact-capability/journal-signing-policy"] },
          deny_rule_pairs: { const: "Every reserved path has exact paired kv/data/<path> and kv/metadata/<path> deny rules plus both descendants." },
          partial_or_ancestor_only_evidence: { const: "REJECT" },
          secret_seed: { const: "guarded Kubernetes-secret-to-Vault seed; no Bitwarden" }
        }
      )
    }
  )
};
const networkConformanceFixtureV20 = {
  schema: "codicarium.network-conformance/v1",
  activation: "BLOCKED_PREACTIVATION",
  broker: {
    service: "artifact-capability",
    namespace: "artifact-capability",
    endpoint: "https://artifact-capability.artifact-capability.svc.cluster.local:8443",
    type: "ClusterIP",
    tls: true,
    certificate_dns_san: "artifact-capability.artifact-capability.svc.cluster.local",
    tls_port: 8443,
    metrics_port: 9090,
    ingress_or_public_route: false,
    direct_public_egress: false,
    public_egress_via: "codicarium-private-egress-proxy.platform-egress.svc:8444-only",
    proxy_token_projection: true,
    proxy_identity: proxyIdentityContractV20.bindings["8444"],
    s3_hosts: ["s3.sbg.io.cloud.ovh.net"],
    oidc_jwks_hosts: ["token.actions.githubusercontent.com"],
    journal_database: {
      desired_service: "runner-platform-journal-rw.runner-platform-journal-dev.svc.cluster.local",
      port: 5432,
      direct_internal: true,
      live_status: "PREACTIVATION_NOT_MATERIALIZED",
      tls_status: "BLOCKED_UNTIL_VERIFY_FULL_CA_CONTRACT_EXISTS"
    }
  },
  candidate: {
    execution: "separate-destroyed-after-use-Kata-Job",
    runtime_class: "kata-clh-runtime-rs",
    runtime_class_live: false,
    default_or_kubernetes_api_service_account_token: false,
    typed_broker_read_token: true,
    proxy_token_projection: false,
    github_egress: false,
    proxy_egress: false,
    public_egress: false,
    allowed_egress: ["DNS 10.43.0.10 TCP/UDP 53", "artifact-capability.artifact-capability.svc.cluster.local TCP 8443"],
    input_delivery: candidateInputDeliveryV20
  },
  trusted_control: {
    executes_candidate_source: false,
    github_hosts: ["api.github.com", "codeload.github.com", "github.com", "objects.githubusercontent.com", "raw.githubusercontent.com", "release-assets.githubusercontent.com"],
    direct_public_egress: false,
    proxy_required: true,
    proxy_listener: "codicarium-private-egress-proxy.platform-egress.svc:8443-only",
    proxy_token_projection: true,
    proxy_identity: proxyIdentityContractV20.bindings["8443"]
  },
  proxies: {
    owner: "central-platform",
    live_status: "ABSENT_BLOCKER",
    service: "codicarium-private-egress-proxy.platform-egress.svc",
    github_listener: 8443,
    broker_artifact_listener: 8444,
    separate_listeners: true,
    direct_bypass: false,
    identity_authentication: proxyIdentityContractV20
  },
  postgres_access: postgresAccessContractV20,
  vault_direct: {
    owner: "vault-config/infra",
    status: "MISSING_VERIFIED_INTERNAL_IP_PORT_SNI_CA_BLOCKER",
    ip: null,
    port: null,
    sni: null,
    ca_sha256: null,
    proxy: false
  },
  infra: {
    generic_eligible_workers_live: 1,
    kata_v2_eligible_workers_live: 0,
    required_eligible_workers: 3,
    additional_workers_required: 2,
    control_node: "NoSchedule",
    remaining_two_node_capacity_proven: false,
    kata_runtime_present: false,
    proxy_present: false
  },
  ingress_flows: [
    { source: combinedPeerV20("arc-runners-v2-untrusted", "release-candidate-kata", ["app.kubernetes.io/name=release-candidate-kata"]), destination: combinedPeerV20("artifact-capability", "artifact-capability", ["app.kubernetes.io/name=artifact-capability"]), protocol: "TCP", port: 8443, purpose: "candidate-broker" },
    { source: combinedPeerV20("arc-runners-v2-control", "release-control", ["app.kubernetes.io/name=release-control"]), destination: combinedPeerV20("artifact-capability", "artifact-capability", ["app.kubernetes.io/name=artifact-capability"]), protocol: "TCP", port: 8443, purpose: "trusted-control-broker" },
    { source: combinedPeerV20("monitoring", "prometheus-stack-prometheus", ["app.kubernetes.io/instance=prometheus-stack-prometheus", "app.kubernetes.io/name=prometheus"]), destination: combinedPeerV20("artifact-capability", "artifact-capability", ["app.kubernetes.io/name=artifact-capability"]), protocol: "TCP", port: 9090, purpose: "prometheus-metrics" },
    ...postgresClientFlowsV20
  ],
  vault_reserved_path_policy: {
    evidence_schema: "2",
    kv_metadata_inventory_access: "reconciled",
    new_paths: ["codicarium/dev/release-journal/database-ca", "codicarium/dev/release-journal/runtime-password", "codicarium/dev/release-journal/bootstrap-owner", "codicarium/dev/release-journal/migrator-password", "codicarium/dev/artifact-capability/journal-signing-policy"],
    deny_rule_pairs: "Every reserved path has exact paired kv/data/<path> and kv/metadata/<path> deny rules plus both descendants.",
    partial_or_ancestor_only_evidence: "REJECT",
    secret_seed: "guarded Kubernetes-secret-to-Vault seed; no Bitwarden"
  }
};
writeJson("network-conformance-v1.schema.json", networkConformanceSchemaV20);
writeJson("network-conformance-v1.fixture.json", networkConformanceFixtureV20);

const protectedCheckEvidenceV20 = (name) => closed(
  ["name", "app_id", "head_sha", "status", "conclusion"],
  { name: { const: name }, app_id: { const: "15368" }, head_sha: sha40, status: { const: "completed" }, conclusion: { const: "success" } }
);
const publicationCommitSummarySchemaV20 = closed(
  ["sequence", "journal_commit_entry_sha256", "receipt_sha256"],
  { sequence: sequenceV20, journal_commit_entry_sha256: sha64, receipt_sha256: sha64 }
);
const liveEvidenceSchemaV20 = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.codicarium.com/release/release-live-evidence-v2.schema.json",
  title: "Closed synthetic v0.6.14 conformance evidence; never live publication authority",
  ...closed(
    ["schema", ...fixtureAuthorityKeysV20, "fixture_identity_jcs_sha256", "captured_at", "repository", "protected_main_sha", "protected_checks", "release_identity", "claim", "check_run_observations", "journal", "publication_receipts", "publication_commit_entries", "release", "registries", "assets", "retirement", "kube_binding_sha256", "grant_migration_sha256", "network_conformance_sha256"],
    {
      schema: { const: "codicarium.release-live-evidence/v2" },
      ...fixtureAuthorityPropertiesV20,
      fixture_identity_jcs_sha256: { const: claimIdentityDigestV20 },
      captured_at: rfc3339,
      repository: closed(["full_name", "id"], { full_name: { const: "codicarium/deployment-controller" }, id: { const: "1303901324" } }),
      protected_main_sha: sha40,
      protected_checks: { type: "array", minItems: 5, maxItems: 5, prefixItems: protectedChecks.map(protectedCheckEvidenceV20), items: false },
      release_identity: closed(["tag", "source_sha"], { tag: { const: "v0.6.14" }, source_sha: sha40 }),
      claim: closed(
        [...fixtureAuthorityKeysV20, "fixture_identity_jcs_sha256", "claim_key", "identity_jcs_sha256", "first_durable_release_side_effect", "exact_replay_status", "conflict_status", "ambiguity"],
        {
          ...fixtureAuthorityPropertiesV20,
          fixture_identity_jcs_sha256: { const: claimIdentityDigestV20 },
          claim_key: { type: "string", pattern: "^rel-v2-sha256:[0-9a-f]{64}$" },
          identity_jcs_sha256: sha64,
          first_durable_release_side_effect: { const: true },
          exact_replay_status: { const: 200 },
          conflict_status: { const: 409 },
          ambiguity: { const: "UNKNOWN_MANUAL_NO_RETRY" }
        }
      ),
      check_run_observations: closed(
        ["authority", "handoff_coordinator_check_run_id", "dispatch_handoff_check_run_id", "handoff_sha256", "dispatch_sha256"],
        {
          authority: { const: false },
          handoff_coordinator_check_run_id: { const: "9002003" },
          dispatch_handoff_check_run_id: { const: "9004003" },
          handoff_sha256: { const: "8abe528bb32aaa47f8fc496c3571d4b91248f3ebfe4c8be29463a25277bd9e88" },
          dispatch_sha256: { const: "b150fa8dad70a207fb7a78f6a41ab1bc1430833ba70b86fdc2f08a13c7c11f3b" }
        }
      ),
      journal: closed(
        ["authority", "journal_id", "entry_count", "first_entry_sha256", "last_entry_sha256", "terminal_state"],
        {
          authority: { const: "dedicated-dev-postgresql-not-s3" },
          journal_id: { type: "string", pattern: "^jrnl-v1-[0-9a-f]{32}$" },
          entry_count: { const: 45 },
          first_entry_sha256: sha64,
          last_entry_sha256: sha64,
          terminal_state: { const: "complete" }
        }
      ),
      publication_receipts: {
        type: "array",
        minItems: 20,
        maxItems: 20,
        items: { oneOf: [dispatchReceiptEnvelopeSchemaV20, mutationReceiptEnvelopeSchemaV20] }
      },
      publication_commit_entries: { type: "array", minItems: 20, maxItems: 20, items: publicationCommitSummarySchemaV20 },
      release: closed(["id", "tag", "target", "draft", "prerelease"], { id: positiveDecimal, tag: { const: "v0.6.14" }, target: sha40, draft: { const: false }, prerelease: { const: false } }),
      registries: closed(
        ["image", "chart"],
        {
          image: targetSchemasV20["image-publish"],
          chart: targetSchemasV20["chart-publish"]
        }
      ),
      assets: { type: "array", minItems: 14, maxItems: 14, prefixItems: assetNames.map((name) => closed(["release_id", "asset_id", "name", "size", "sha256"], { release_id: positiveDecimal, asset_id: positiveDecimal, name: { const: name }, size: positiveDecimal, sha256: sha64 })), items: false },
      retirement: closed(["workflow_count", "workflow_ids", "legacy_authorities_revoked", "old_outputs_or_reruns_accepted"], { workflow_count: { const: 5 }, workflow_ids: { const: retiredWorkflowIdsV20.map((item) => item[0]) }, legacy_authorities_revoked: { const: true }, old_outputs_or_reruns_accepted: { const: false } }),
      kube_binding_sha256: sha64,
      grant_migration_sha256: sha64,
      network_conformance_sha256: sha64
    }
  )
};
writeJson("release-live-evidence-v1.schema.json", liveEvidenceSchemaV20);
const publicationReceiptsV20 = [dispatchReceiptFixtureV20, ...mutationReceiptFixturesV20];
const liveEvidenceFixtureV20 = {
  schema: "codicarium.release-live-evidence/v2",
  ...fixtureAuthorityMarkerV20,
  fixture_identity_jcs_sha256: claimIdentityDigestV20,
  captured_at: "2026-01-01T01:00:00Z",
  repository: { full_name: "codicarium/deployment-controller", id: "1303901324" },
  protected_main_sha: reviewedWorkflowRevisionV20,
  protected_checks: protectedChecks.map((name) => ({ name, app_id: "15368", head_sha: reviewedWorkflowRevisionV20, status: "completed", conclusion: "success" })),
  release_identity: { tag: "v0.6.14", source_sha: candidateSourceRevisionV20 },
  claim: {
    ...fixtureAuthorityMarkerV20,
    fixture_identity_jcs_sha256: claimIdentityDigestV20,
    claim_key: claimKeyV20,
    identity_jcs_sha256: claimIdentityDigestV20,
    first_durable_release_side_effect: true,
    exact_replay_status: 200,
    conflict_status: 409,
    ambiguity: "UNKNOWN_MANUAL_NO_RETRY"
  },
  check_run_observations: {
    authority: false,
    handoff_coordinator_check_run_id: "9002003",
    dispatch_handoff_check_run_id: "9004003",
    handoff_sha256: sha256(releaseHandoffBytesV20),
    dispatch_sha256: sha256(publisherDispatchBytesV20)
  },
  journal: {
    authority: "dedicated-dev-postgresql-not-s3",
    journal_id: journalIdV20,
    entry_count: journalRecordsV20.length,
    first_entry_sha256: journalRecordsV20[0].entry_sha256,
    last_entry_sha256: journalRecordsV20[journalRecordsV20.length - 1].entry_sha256,
    terminal_state: "complete"
  },
  publication_receipts: publicationReceiptsV20,
  publication_commit_entries: publicationCommitEntriesV20.map((item) => ({ sequence: item.sequence, journal_commit_entry_sha256: item.entry_sha256, receipt_sha256: item.receipt_sha256 })),
  release: { id: "9006001", tag: "v0.6.14", target: candidateSourceRevisionV20, draft: false, prerelease: false },
  registries: {
    image: publicationTargetsV20[2].target,
    chart: publicationTargetsV20[3].target
  },
  assets: publicationTargetsV20.slice(4, 18).map((item) => item.target),
  retirement: {
    workflow_count: 5,
    workflow_ids: retiredWorkflowIdsV20.map((item) => item[0]),
    legacy_authorities_revoked: true,
    old_outputs_or_reruns_accepted: false
  },
  kube_binding_sha256: digestJcsV20(kubeContextBindingFixtureV20),
  grant_migration_sha256: digestJcsV20(grantMigrationFixtureV20),
  network_conformance_sha256: digestJcsV20(networkConformanceFixtureV20)
};
writeJson("release-live-evidence-v1.fixture.json", liveEvidenceFixtureV20);

const followUpOrderV20 = {
  schema: "codicarium.issue93-follow-up-order/v2",
  total_order: [
    "issue-93-corrective-pr-merged-and-five-old-workflows-retired",
    "v0.6.14-public-release-and-twenty-receipt-live-evidence-verified",
    "issue-98-new-workflow-id-v0.6.8-one-target-broker-recovery-success",
    "issue-98-eight-assets-read-back",
    "pr-99-rebased-on-current-main",
    "pr-99-five-checks-at-one-head",
    "pr-99-merged",
    "new-recover-release-v068-v2-workflow-removed-at-pr-99-merge-sha",
    "issue-98-closed",
    "pr-94-rebased-on-resulting-main",
    "pr-94-five-checks-at-one-head",
    "pr-94-merged"
  ],
  forbidden: ["PR #99 triggers or resumes v0.6.13", "PR #94 triggers or resumes v0.6.13", "any v0.6.13 mutation authority", "reuse of any retired workflow ID"]
};
writeJson("follow-up-order-v1.json", followUpOrderV20);

const manifestFilesV20 = [
  "artifact-capability-api-v1.schemas.json",
  "candidate-evidence-v1.schema.json",
  "publisher-dispatch-receipt-v1.schema.json",
  "publisher-mutation-receipt-v1.schema.json",
  "release-live-evidence-v1.schema.json",
  "release-identity-v1.schema.json",
  "release-live-implementation-identity-v1.schema.json",
  "release-claim-cas-v1.schema.json",
  "release-journal-v1.schema.json",
  "recovery-retirement-v1.schema.json",
  "grant-migration-v1.schema.json",
  "network-conformance-v1.schema.json",
  "kube-context-binding-v1.schema.json",
  "workflow-permissions-v1.json",
  "history-horizon-1000.json",
  "canonical-identity-fixtures-v1.json",
  "jcs-rfc8785-conformance-v1.fixture.json",
  "release-identity-negative-vectors-v1.fixture.json",
  "artifact-capability-jws-v1.fixture.json",
  "candidate-evidence-v1.fixture.json",
  "release-claim-cas-v1.fixture.json",
  "release-journal-v1.fixture.json",
  "publisher-dispatch-receipt-v1.fixture.json",
  "publisher-mutation-receipt-v1.fixture.json",
  "release-live-evidence-v1.fixture.json",
  "recovery-retirement-v1.fixture.json",
  "grant-migration-v1.fixture.json",
  "network-conformance-v1.fixture.json",
  "kube-context-binding-v1.fixture.json",
  "follow-up-order-v1.json",
  "release-handoff-v1.json",
  "publisher-dispatch-v1.json",
  "canonical-archive-v1.tar",
  "canonical-archive-v1.tar.zst",
  "archive-input/alpha.txt",
  "archive-input/beta.txt"
];
if (manifestFilesV20.length !== 36 || new Set(manifestFilesV20).size !== 36) throw new Error("v2 manifest cardinality mismatch");

const annexV20 = {
  schema: "codicarium.issue93-spec-annex/v2",
  generated_at: "2026-08-25T09:30:00Z",
  baselines,
  repository_ids: {
    "codicarium/deployment-controller": "1303901324",
    "codicarium/codicarium-actions": "1205279565",
    "codicarium/runner-config": "1303372884",
    "codicarium/app-config": "1136354283",
    "codicarium/infra": "1136354160",
    "codicarium/postgres-config": "1285126920",
    "codicarium/vault-config": "1287061314"
  },
  current_main_focused_impact: {
    deployment_controller_103: {
      baseline: "74defd205658b8db4b90a80cc7f8aa05dfe8a193",
      choice: "runner-config-dev remains dev/event-driven",
      reason: "PollOnly admission is prod-only. The migration preserves source-absent plus required RequestRef and Kafka authority, and rejects PollOnly/dev; no poll controller, poll ServiceAccount, or poll-only NetworkPolicy is added.",
      required_tests: ["dev plus PollOnly rejected", "dev event-driven source absent RequestRef+Kafka accepted", "grant/profile UID generation and digest bindings remain exact"]
    },
    vault_config_258: {
      baseline: "59b06ef256b5f3a5956f630240e95f00b22a9d07",
      evidence_schema: "2",
      kv_metadata_inventory_access: "reconciled",
      requirement: "Every new reserved path has paired exact kv/data and kv/metadata denies plus descendants; partial and ancestor-only evidence is rejected."
    }
  },
  live_authority_contract: {
    status: "PENDING_PROTECTED_MERGE_DISCOVERY",
    schema_file: "fixtures-v2.0/release-live-implementation-identity-v1.schema.json",
    positive_live_identity_fixture_present: false,
    synthetic_fixture: {
      evidence_class: fixtureAuthorityMarkerV20.evidence_class,
      publication_authority: false,
      fixture_set: fixtureAuthorityMarkerV20.fixture_set,
      fixture_identity_jcs_sha256: claimIdentityDigestV20
    },
    required_live_evidence_class: "live-protected-authority",
    required_publication_authority: true,
    required_bindings: ["live identity JCS digest", "claim key", "corrective merge SHA", "candidate source SHA", "coordinator workflow SHA", "publisher workflow SHA", "trusted Vault signing kid"],
    prohibited_live_inputs: ["synthetic candidate source SHA", "synthetic reviewed workflow SHA", "fixture identity digest", "fixture Ed25519 signing kid"],
    negative_cases: ["relabeled fixture identity", "standalone fixture receipt", "authority-flipped fixture signature", "wrong repository ID", "synthetic SHA reuse", "invalid ancestry", "workflow path/ref/SHA drift", "tag-target mismatch", "mixed identity digest", "missing or stale discovery proof"],
    negative_outcome: { claim_creates: 0, dispatches: 0, journal_commits: 0, publication_mutations: 0 }
  },
  claim_contract: {
    identity: claimIdentityV20,
    identity_jcs_sha256: claimIdentityDigestV20,
    claim_key: claimKeyV20,
    first_durable_release_side_effect: true,
    create_status: 201,
    exact_read_only_replay_status: 200,
    conflict_status: 409,
    ambiguity: "UNKNOWN_MANUAL; no automatic retry"
  },
  journal_contract: {
    authority: "A new dedicated dev PostgreSQL journal, never S3 or another object store.",
    ownership: {
      "codicarium/postgres-config": "new dev CNPG cluster/database, NOLOGIN owner, coarse roles, synchronous replica/N-1 desired state",
      "codicarium/runner-config": "broker source, versioned SQL, migration Job, Vault injection, fixed SECURITY DEFINER procedures"
    },
    desired_endpoint: journalFixtureV20.storage.desired_endpoint,
    live_status: journalFixtureV20.storage.live_status,
    database_roles: {
      owner: "NOLOGIN and owns database/schema",
      migrator: "separate identity allowed to SET ROLE for reviewed DDL only",
      runtime: "LOGIN, not owner and not owner member; CONNECT, schema USAGE, SELECT read view, EXECUTE exact append/claim procedures only"
    },
    revoked: ["PUBLIC CONNECT", "PUBLIC/runtime database TEMP", "PUBLIC/runtime schema CREATE", "direct INSERT", "UPDATE", "DELETE", "TRUNCATE", "DDL"],
    durability: ["SERIALIZABLE", "synchronous_commit=on", "primary keys", "unique idempotency/sequence constraints", "NOT NULL/CHECK constraints", "append-only rows", "synchronous replicas and N-1 evidence"],
    procedures: journalProcedureNamesV20,
    procedure_migration: journalProcedureMigrationV20,
    function_resolution: "SET search_path = pg_catalog, release_journal, pg_temp; persistent relations and non-builtins are explicitly release_journal-qualified and builtins explicitly pg_catalog-qualified",
    temp_shadow_attack_vector: journalTempShadowAttackVectorV20,
    github_dispatch_contract: githubDispatchContractV20,
    endpoints: ["claim CAS", "exact read", "reserve", "commit", "authorize", "complete"],
    forbidden_endpoints: ["update", "delete"],
    closed_states: ["claim", "verifier-dispatch-reserve", "verifier-dispatch-commit", "verification-authorization", "publisher-dispatch-reserve", "publisher-dispatch-commit", "mutation-reserve 1..19", "mutation-commit 1..19", "complete", "UNKNOWN_MANUAL"],
    procedure_execution_authority: false,
    procedure_activation_status: journalProcedureMigrationV20.implementation_status,
    protocol_model_fixture_entries: 45,
    signing: "Every reservation and commit is immutable, previous-hash linked, and independently signed by Vault transit; the fixture signs all entries.",
    tls: "verify-full exact CA contract is a preactivation blocker and is not asserted live."
  },
  publication_plan: {
    dispatch_sequence: 0,
    mutations: publicationTargetsV20.map((item, index) => ({ sequence: index + 1, mutation: item.mutation, target_sha256: digestJcsV20(item.target) })),
    signed_publication_receipts: 20,
    chain: "one sequence-zero dispatch receipt plus nineteen mutation receipts; each body and envelope digest is computed from actual canonical request/readback/target evidence",
    tag_owner: "publisher mutation 1; Automatic Release has no tag-create authority"
  },
  check_runs: { authority: false, use: "observation-only", write_scope_allowed: false },
  raw_identity_contract: {
    authority: false,
    purpose: "byte-regression-only",
    fixture: canonicalIdentityFixtureV20
  },
  candidate_input_delivery: candidateInputDeliveryV20,
  proxy_identity_contract: proxyIdentityContractV20,
  postgres_access_contract: postgresAccessContractV20,
  old_workflow_retirement: recoveryRetirementFixtureV20,
  platform_ownership: {
    "codicarium/codicarium-actions": ["closed schemas", "JCS/Ed25519 conformance", "canonical archive and broker client"],
    "codicarium/postgres-config": ["postgres-config-dev-path-helm and postgres-config-dev desired state", "runner-platform-journal CNPG cluster/database", "NOLOGIN owner and coarse roles", "synchronous replica/N-1 desired state"],
    "codicarium/vault-config": ["transit signing role", "runtime/migrator secret paths", "schema-2 paired data/metadata reserved-path denies", "guarded Kubernetes-secret-to-Vault seed"],
    "codicarium/runner-config": ["broker", "trusted release-control runner", "candidate Kata Job", "journal SQL and migration Job", "Service/ServiceAccount/Deployment/Job/NetworkPolicy/PDB/ServiceMonitor/PrometheusRule/Issuer/Certificate"],
    "codicarium/infra": ["two additional eligible workers", "remaining-two-node capacity", "kata-clh-runtime-rs", "centrally owned identity-bound egress proxy and separate listeners", "UID-aware runner-config-dev grant/profile migration", "separate postgres-config-dev-path-helm and postgres-config-dev authority"],
    "codicarium/app-config": ["bootstrap wiring only if required; no workload or journal ownership"],
    "codicarium/deployment-controller": ["v2 workflows/helpers", "five-workflow retirement", "event-driven dev activation compatibility", "live evidence validation"]
  },
  postgres_gitops: {
    repository_id: "1285126920",
    profile: "postgres-config-dev-path-helm",
    grant: "postgres-config-dev",
    app_project: "repo-postgres-config-dev",
    activation_label: "post-retirement",
    component_id: "runner-platform-journal",
    application_name: "runner-platform-journal-dev",
    chart_path: "charts/postgres-platform",
    release_name: "runner-platform-journal",
    destination_namespace: "runner-platform-journal-dev",
    values_file: ".codicarium/dev/values.yaml",
    cnpg_cluster: "runner-platform-journal",
    desired_endpoint: "runner-platform-journal-rw.runner-platform-journal-dev.svc.cluster.local:5432",
    namespace_owner: "central platform; namespace.create=false",
    exact_profile_resources: ["networking.k8s.io/NetworkPolicy", "postgresql.cnpg.io/Cluster"],
    forbidden_rendered_resources: ["Namespace", "ExternalSecret", "PushSecret", "plaintext Secret"],
    required_values: ["externalSecrets.enabled=false", "no Bitwarden", "immutable PostgreSQL image", "ceph-rbd-replicated storage", "dedicated runtime/migrator roles", "verify-full TLS", "synchronous replicas/N-1"],
    access_bootstrap_contract: postgresAccessContractV20
  },
  service_runtime: {
    broker: networkConformanceFixtureV20.broker,
    candidate: networkConformanceFixtureV20.candidate,
    trusted_control: networkConformanceFixtureV20.trusted_control,
    proxies: networkConformanceFixtureV20.proxies,
    postgres_access: networkConformanceFixtureV20.postgres_access,
    vault_direct: networkConformanceFixtureV20.vault_direct,
    ingress_flows: networkConformanceFixtureV20.ingress_flows,
    no_ingress: true,
    activation_blockers: [
      "provide two additional generic eligible workers and prove three total plus remaining-two-node capacity",
      "label/provision three Kata-v2-eligible workers; live count is zero; replace synthetic archive/image byte oracles with exact raw live codeload and registry-manifest/preload readback; prove protected-control opaque fetch -> immutable broker object -> one-read projected Pod token -> safe in-Kata scan/extract and complete teardown, with the separate broker verifier limited to tokenreviews.create, untrusted-namespace Pod get/list/watch, exact binding inventory and 10.43.0.1/32:443 CA/SAN/audience-verified API egress",
      "install kata-clh-runtime-rs",
      "materialize the centrally owned TLS-only proxy with projected bound Pod tokens, TokenReview/source-Pod binding, replay denial and separate exact GitHub/artifact listener host+method ACLs; limit its separate verifier to tokenreviews.create, Pod get/list/watch only in control+broker namespaces, no other binding inventory, and 10.43.0.1/32:443 CA/SAN/audience-verified API egress",
      "establish and verify exact direct internal Vault IP, port, SNI and CA",
      "materialize postgres-config-dev-path-helm/postgres-config-dev and runner-platform-journal-dev namespace with default-deny database/client NetworkPolicies, one-time CNPG bootstrap-secret transfer to Vault, least-privilege roles and bootstrap/migrator retirement",
      "replace fail-closed journal procedure stubs with reviewed CAS/FSM implementations and PostgreSQL integration evidence including pg_catalog-first/pg_temp-last search path, fully qualified persistent relation/function references, PUBLIC/runtime TEMP and CREATE revocation, and temp-shadow attacks; materialize dedicated dev PostgreSQL with verify-full TLS, synchronous replicas and N-1 evidence; after the protected corrective merge discover and bind a non-fixture live identity before any claim"
    ]
  },
  grant_migration: grantMigrationFixtureV20,
  kube_context_binding: kubeContextBindingFixtureV20,
  protected_gate: { check_names: protectedChecks, app_id: "15368", same_current_head: true, repository_self_authorization: false },
  rollback: "Preactivation only: revert reviewed Git desired state. After activation use forward remediation. Always disable v2 release workflows on uncertainty; never restore five old workflows, credentials, routing, old grant epoch, v0.6.13, or mutable output.",
  forward_only: { retired: "v0.6.13/ad52dfcbc45d71eccad1d49fbd905161af7a44b1", next: "v0.6.14", retag_or_resume_allowed: false },
  follow_up_order: followUpOrderV20.total_order,
  fixture_counts: {
    manifest_files: 36,
    draft_2020_12_schemas: 13,
    raw_identity_positive_vectors: 2,
    raw_identity_negative_vectors: 6,
    claim_cas_vectors: 4,
    journal_entries: 45,
    journal_operation_evidence: 22,
    signed_publication_receipts: 20,
    publisher_mutations: 19,
    protected_checks: 5,
    retired_workflows: 5,
    release_assets: 14
  },
  archive_profile: {
    fixture_tar: { byte_length: 3072, sha256: "fb7a260f46a361d9b90bf6371824f0b62dcabf99be09ab984a4fb6fcaeebda31" },
    fixture_tar_zst: { byte_length: 102, sha256: "5858457a000d6f7334053b51ba4f1106f1ee1e683ffc6bcf461af0fe9b3dc64b" },
    rule: "single canonical ustar plus single canonical zstd frame; payload object storage may be exact S3, but S3 is never the release journal"
  },
  files: manifestFilesV20.map(fileRecord)
};
const annexBytesV20 = jsonBytes(annexV20);
fs.writeFileSync(path.join(runDir, "feature-spec.v2.0.annex.json"), annexBytesV20);
const annexShaV20 = sha256(annexBytesV20);

const requirementRowsV20 = [
  ["REQ-001", "Freeze all seven repository IDs and remote-main SHAs exactly as the annex records; any movement requires focused re-audit before code."],
  ["REQ-002", "Account for deployment-controller #103 by retaining admissible dev event-driven RequestRef+Kafka activation and rejecting PollOnly/dev; account for vault-config #258 with schema-2 paired data/metadata deny evidence."],
  ["REQ-003", "Treat every generated source/workflow identity and signed chain as synthetic-conformance-fixture with publication_authority=false and its exact fixture identity digest; after the protected corrective merge derive the only live claim key from the separately discovered non-fixture live identity JCS."],
  ["REQ-004", "Make a live-identity-bound claim CAS the first durable release side effect: reject every synthetic SHA/digest/key even if relabeled or re-signed; first create 201, exact read-only replay 200, conflict 409, and ambiguity UNKNOWN_MANUAL with no retry."],
  ["REQ-005", "Use a new dedicated dev PostgreSQL journal, never S3, with SERIALIZABLE transactions, synchronous_commit=on, primary/unique/check constraints, append-only rows, synchronous replicas, and N-1 evidence."],
  ["REQ-006", "Define every journal function as SECURITY DEFINER with SET search_path = pg_catalog, release_journal, pg_temp; fully qualify persistent relations/non-builtins with release_journal and builtins with pg_catalog; revoke PUBLIC/runtime database TEMP and schema CREATE, and test relation/function temp-shadow attacks in addition to PUBLIC execute, direct DML, TRUNCATE, and DDL denial."],
  ["REQ-007", "Enforce the closed journal FSM: claim; verifier reserve/commit; authorization; publisher reserve/commit; mutation reserve/commit 1..19; complete or UNKNOWN_MANUAL, with exactly one next sequence."],
  ["REQ-008", "Make every reservation/commit immutable, previous-hash linked, and independently Vault-transit signed; target writers cannot sign/commit and signers/committers cannot mutate targets."],
  ["REQ-009", "Expose claim/read/reserve/commit/authorize/complete procedures only; no update or delete endpoint exists."],
  ["REQ-010", "Treat Check Runs only as observations with checks:read; no Check Run, external ID, URL, or checks:write grants publication authority."],
  ["REQ-011", "Dispatch verifier with X-GitHub-Api-Version 2026-03-10 and return_run_details=true; accept only the direct HTTP-200 workflow_run_id/URLs, while HTTP 204 or any missing response is UNKNOWN_MANUAL with zero retry and no commit."],
  ["REQ-012", "Record one closed verification-authorization state that binds claim, candidate evidence, protected verifier identity, and authorization digest."],
  ["REQ-013", "Dispatch publisher with X-GitHub-Api-Version 2026-03-10 and return_run_details=true; accept only the direct HTTP-200 workflow_run_id/URLs, commit it as sequence 0, and map HTTP 204, manual, independent, or rerun execution to UNKNOWN_MANUAL with zero retry."],
  ["REQ-014", "Move tag creation out of Automatic Release into publisher mutation 1; execute draft release, image, chart, fourteen assets, and finalize as mutations 2..19."],
  ["REQ-015", "Emit exactly twenty signed publication receipts: one dispatch plus nineteen mutation receipts, each over actual canonical body/request/readback/target hashes rather than placeholder labels."],
  ["REQ-016", "Stop permanently at UNKNOWN_MANUAL after any ambiguous reservation, target write, readback, signing, or commit; never retry or advance sequence."],
  ["REQ-017", "Preserve raw release-handoff-v1.json at exactly 697 bytes/SHA-256 8abe528b... and raw publisher-dispatch-v1.json at exactly 436 bytes/SHA-256 b150fa8d..., with independently recomputed canonical metadata."],
  ["REQ-018", "Reject duplicate, unknown, and byte-mutated identity vectors; distinguish handoff coordinator Check Run 9002003 from dispatch handoff Check Run 9004003 and keep both observation-only."],
  ["REQ-019", "Before v0.6.14 disable permanently and delete all five privileged workflow IDs/paths in the retirement fixture; reject every old output and rerun."],
  ["REQ-020", "Revoke the six legacy Nexus/OVH secret authorities plus V068 S3 credentials, both recovery environments, and general runner routing before the claim."],
  ["REQ-021", "Create any later v0.6.8 recovery strictly after verified v0.6.14 as a new path and workflow ID with one typed broker target and no contents:write, broad token, reusable secret, or signing key."],
  ["REQ-022", "After live candidate discovery, hash/count the exact raw codeload response bytes (never the synthetic byte oracle), bind repository/commit/URL/purpose/key/digest/length/content type through protected-control create, receipt, broker grant and Kata verification, and permit only a 300-second Pod-bound projected one-read token; the separate broker verifier gets only tokenreviews.create plus untrusted-namespace Pod get/list/watch and exact 10.43.0.1/32:443 CA/SAN/audience-verified API egress; deny default/API/proxy tokens and GitHub/registry/public egress, safely scan/extract only in Kata memory volumes, and prove every teardown residue absent."],
  ["REQ-023", "Never execute candidate source on trusted release-control runners; authenticate its 8443 proxy access with a 600-second projected Pod-bound codicarium-egress-proxy token, TokenReview, exact namespace/SA/UID/source-Pod binding and nonce replay denial, then allow only the exact GitHub host+method ACL; the separate proxy verifier gets only tokenreviews.create plus Pod get/list/watch RoleBindings in control and broker namespaces, exact authorization inventory, and context-bound 10.43.0.1/32:443 API egress."],
  ["REQ-024", "Authenticate broker 8444 proxy access with the same enforceable projected-token/TokenReview Pod binding but a distinct artifact-capability principal and exact S3/OIDC host+method ACL; neither verifier may read Secrets, create TokenRequests, access exec/attach/log, mutate Pods, or hold wildcard/extra bindings; deny listener confusion and direct public/proxy bypass, and reach Vault directly only after exact internal IP/port/SNI/CA verification."],
  ["REQ-025", "Allow broker ingress on 8443 only from exact candidate/trusted-control peers, metrics on 9090 only from Prometheus, and PostgreSQL 5432 only from exact broker/migrator peers while preserving only explicit replication/operator/DNS/API flows; default-deny all other clients and expose no ingress or public route."],
  ["REQ-026", "Provision two additional generic eligible workers, three Kata-v2-eligible workers, remaining-two-node capacity, kata-clh-runtime-rs, proxy, Vault, and journal TLS before activation; the control node remains NoSchedule."],
  ["REQ-027", "Keep runner-config-dev profileRef arc-path-helm immutable and reject duplicate repository 1303372884/environment dev grants; create artifact-capability-path-helm first with existing ARC scopes and exact broker resources/destinations."],
  ["REQ-028", "Freeze writers, snapshot UIDs/resourceVersions/spec hashes, delete the old grant with UID/resourceVersion preconditions, prove absent/orphan fail-closed, recreate the same name as a new epoch, and preserve AppProject/Application/workload UIDs/specs."],
  ["REQ-029", "Permit rollback only before activation; never reuse an old grant UID, proof, activation, work item, or epoch after recreation."],
  ["REQ-030", "Bind every cluster command to the exact kubeconfig, context, API server, CA PEM SHA-256, and kube-system UID in the context fixture; mismatch exits before mutation."],
  ["REQ-031", "Keep ownership minimal: postgres-config owns runner-platform-journal-dev and its CNPG-generated bootstrap Secret; runner-config performs one UID/resourceVersion-bound memory-only transfer to create-only Vault v1, owns broker/qualified SQL/migration/runtime roles, and retires bootstrap/migrator login, CONNECT, Vault credentials/auth and workloads; vault-config owns transit/narrow paths/paired denies; infra owns workers/proxy/scoped authorities; app-config remains bootstrap-only."],
  ["REQ-032", "Retain exactly test, lint, chart, integration, and supply-chain from GitHub Actions app ID 15368 at one current head; repository-controlled content cannot self-authorize."],
  ["REQ-033", "Keep v0.6.13 permanently retired, release only forward v0.6.14, and fail closed without restoring old workflows, credentials, routing, journal state, or grant epoch."],
  ["REQ-034", "Follow issue #98 then PR #99 then PR #94 only after verified public v0.6.14 and complete twenty-receipt live evidence, with rebases and all five checks at each exact head."],
  ["REQ-035", "Post-merge evidence must first discover the actual corrective merge, candidate source and exact protected workflow identities, then bind their live identity digest and trusted non-fixture Vault key through the exact claim/journal/receipt chain, five protected checks, tag/source, image/chart, fourteen assets, five-workflow retirement, and final non-draft release."],
  ["REQ-036", "Ship thirteen closed Draft 2020-12 schemas including release-live-implementation-identity-v1 with no persisted positive live instance, plus positive synthetic fixtures and strict duplicate-key/JCS/Ed25519/journal/raw/archive/manifest/trace checks; negative oracles must reject relabeled fixture authority, live binding drift, candidate substitution/traversal/token/replay/residue, proxy identity/listener/ACL confusion, unauthorized PostgreSQL/bootstrap/role reuse, and temp relation/function shadow attacks with zero side effects."]
];
const requirementsV20 = requirementRowsV20.map(([id, statement]) => ({
  id,
  priority: "MUST",
  statement,
  rationale: "This condition preserves a fail-closed release authority boundary and is executable against annex " + annexShaV20 + "."
}));
const acceptanceCriteriaV20 = Array.from({ length: 18 }, (unused, index) => {
  const first = "REQ-" + String(index * 2 + 1).padStart(3, "0");
  const second = "REQ-" + String(index * 2 + 2).padStart(3, "0");
  return {
    id: "AC-" + String(index + 1).padStart(3, "0"),
    requirement_ids: [first, second],
    scenario: "Given the frozen v2.0 annex and fail-closed prerequisites, When " + first + " and " + second + " are evaluated with their positive and negative fixtures, Then both contracts pass exactly or the release remains non-authorizing."
  };
});
const testPlanV20 = Array.from({ length: 18 }, (unused, index) => {
  const first = "REQ-" + String(index * 2 + 1).padStart(3, "0");
  const second = "REQ-" + String(index * 2 + 2).padStart(3, "0");
  return {
    id: "TST-" + String(index + 1).padStart(3, "0"),
    type: index < 12 ? "integration" : (index < 17 ? "e2e" : "manual"),
    requirement_ids: [first, second],
    approach: "Validate " + first + " and " + second + " using the closed annex fixtures, mutate each authority-bearing field, and assert exact failure with zero unauthorized side effects."
  };
});
const traceMapV20 = new Map(requirementsV20.map((item) => [item.id, { acceptance_ids: [], test_ids: [] }]));
for (const item of acceptanceCriteriaV20) for (const id of item.requirement_ids) traceMapV20.get(id).acceptance_ids.push(item.id);
for (const item of testPlanV20) for (const id of item.requirement_ids) traceMapV20.get(id).test_ids.push(item.id);
const traceabilityV20 = requirementsV20.map((item) => ({
  requirement_id: item.id,
  acceptance_ids: traceMapV20.get(item.id).acceptance_ids,
  test_ids: traceMapV20.get(item.id).test_ids,
  review_checks: ["Review " + item.id + " against exact annex SHA-256 " + annexShaV20 + "."],
  validation_checks: ["Run its mapped acceptance/test oracle; UNKNOWN_MANUAL and every unmet preactivation prerequisite remain non-authorizing."]
}));
const specV20 = {
  meta: {
    id: "SPEC-deployment-controller-issue-93-release-proof-v2-0",
    title: "PostgreSQL-journaled credentialless protected-main release authorization and forward-only issue #93 recovery",
    author: "Codex release manager",
    created_at: "2026-08-25T09:30:00Z",
    version: "2.0.0-exact-candidate"
  },
  feature: {
    problem_statement: "The historical release boundary used mutable privileged workflows, candidate-adjacent reusable authority, Check Run-shaped authorization, and no first-side-effect release CAS. v2.0 replaces authority with an exact protected-main claim and independently signed PostgreSQL journal before any forward v0.6.14 publication.",
    goals: [
      "Make one exact claim and append-only signed journal the sole release authority.",
      "Keep candidate execution credentialless and network-confined while separating target mutation, signing, and commit roles.",
      "Retire all historical privileged authorities and publish only forward v0.6.14 after infrastructure, migration, and evidence gates."
    ],
    non_goals: [
      "Resume, retag, publish, or fabricate success for v0.6.13.",
      "Use S3, Check Runs, workflow outputs, repository content, or runtime owner privileges as the journal.",
      "Assert currently missing Vault, proxy, Kata, worker-capacity, PostgreSQL TLS, or UID/spec snapshots as live."
    ],
    scope_in: [
      "Exact annex SHA-256 " + annexShaV20 + " and its 36-file fixture manifest.",
      "Seven repository baselines, five-workflow retirement, grant migration, network/Kata/proxy/Vault/PostgreSQL prerequisites, and strict #98 -> #99 -> #94 follow-up."
    ],
    scope_out: [
      "Repository, GitHub, cluster, Vault, registry, release, or database mutation during this spec stage.",
      "Activation while any explicit preactivation blocker remains."
    ]
  },
  requirements: requirementsV20,
  acceptance_criteria: acceptanceCriteriaV20,
  test_plan: testPlanV20,
  traceability: traceabilityV20,
  quality_gates: { spec_review_required: true, testability_required: true, traceability_required: true },
  council: {
    perspectives: [
      { role: "planner", summary: "Review dependency order, current-main impact, ownership, migration epochs, rollback, and traceability." },
      { role: "security", summary: "Review claim/JCS identity, PostgreSQL RBAC, transit signatures, role separation, network proxy/Vault boundaries, and retirement." },
      { role: "tech_lead_qa", summary: "Recompute schemas, raw bytes, hashes, signatures, journal/receipt chains, counts, manifest, archives, and negative vectors." },
      { role: "tech_lead_devops", summary: "Review explicit kube binding, workers/Kata/proxy/Vault/PostgreSQL blockers, event-driven dev compatibility, GitOps ownership, and N-1 gates." }
    ],
    consensus_summary: "Draft only. Exact-hash council review may authorize ordered implementation; it does not claim the listed preactivation blockers are satisfied.",
    open_questions: []
  }
};
const specBytesV20 = jsonBytes(specV20);
fs.writeFileSync(path.join(runDir, "feature-spec.v2.0.draft.json"), specBytesV20);
console.log(JSON.stringify({
  v2_exact: true,
  annex_sha256: annexShaV20,
  annex_byte_length: annexBytesV20.length,
  spec_sha256: sha256(specBytesV20),
  spec_byte_length: specBytesV20.length,
  requirements: requirementsV20.length,
  acceptance_criteria: acceptanceCriteriaV20.length,
  tests: testPlanV20.length,
  traceability: traceabilityV20.length,
  manifest_files: manifestFilesV20.length,
  journal_entries: journalRecordsV20.length,
  signed_publication_receipts: publicationReceiptsV20.length,
  mutations: publicationTargetsV20.length
}, null, 2));
