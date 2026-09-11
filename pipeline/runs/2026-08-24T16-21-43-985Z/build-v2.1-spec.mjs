#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const RUN = "/home/rickebo/.codex/pipeline/runs/2026-08-24T16-21-43-985Z";
const SRC = path.join(RUN, "fixtures-v2.0");
const DST = path.join(RUN, "fixtures-v2.1");
const TIME = "2026-08-25T22:30:00Z";
const bytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const read = (name) => JSON.parse(fs.readFileSync(path.join(RUN, name), "utf8"));
const write = (name, value) => fs.writeFileSync(path.join(DST, name), bytes(value));

function copy(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copy(from, to);
    else fs.writeFileSync(to, fs.readFileSync(from));
  }
}

function files(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const current = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...files(current));
    else result.push(current);
  }
  return result.sort();
}

fs.rmSync(DST, { recursive: true, force: true });
copy(SRC, DST);

// v2.1 corrects the inherited synthetic network fixture without touching v2.0.
for (const name of ["network-conformance-v1.schema.json", "network-conformance-v1.fixture.json"]) {
  const target = path.join(DST, name);
  const corrected = fs.readFileSync(target, "utf8")
    .replaceAll("same-peer-namespaceSelector-AND-podSelector-plus-exact-ServiceAccount", "same-peer-namespaceSelector-AND-podSelector-with-admission-verified-identity-label")
    .replaceAll("combined exact namespace+pod label+workload spec.serviceAccountName", "namespace-and-pod-label-selectors-only-central-admission-enforces-serviceAccountName")
    .replaceAll("runner-platform-journal-bootstrap-owner", "runner-platform-journal-app");
  fs.writeFileSync(target, corrected);
}

const baselines = {
  "codicarium/deployment-controller": "ef25cab94f8faec1d9824cc21f868b0b578858e4",
  "codicarium/vault-config": "8412372a2fb328070ec43d6a596b921b4fe05c8e",
  "codicarium/app-config": "6f1a2af06e5b970d6036b9a834320fea74a4dfc8",
  "codicarium/infra": "40073c068a9cf8ff4c1e625b97e09fda31b40637",
  "codicarium/runner-config": "9625e442a12c721e89250812f3d079b09833ccb0",
  "codicarium/postgres-config": "d5ccccfcfc5bae4d099f1848b68e07dcaa679d62",
  "codicarium/codicarium-actions": "9545b5a66498f67667e57d021507ac060fd016b6"
};

const commandRows = [
  ["CMD-001-REPOSITORY-READ", "github-rest", "GET /repos/codicarium/release-platform-config", "codicarium.repository-binding/v1"],
  ["CMD-002-BASELINE-READ", "github-graphql", "read exact default branch object IDs for seven repositories", "codicarium.baseline-heads/v1"],
  ["CMD-003-NAMESPACE-READ", "kubernetes-api", "GET four exact central Namespace objects", "codicarium.namespace-state/v1"],
  ["CMD-004-ADMISSION-READ", "kubernetes-api", "GET named ValidatingAdmissionPolicy and Binding", "codicarium.admission-state/v1"],
  ["CMD-005-VAULT-READ", "vault-http", "GET exact auth role transit key and KV metadata", "codicarium.vault-state/v1"],
  ["CMD-006-CNPG-READ", "kubernetes-api", "GET postgresql.cnpg.io/v1 runner-platform-journal Cluster", "codicarium.cnpg-state/v1"],
  ["CMD-007-SECRET-METADATA-READ", "kubernetes-api", "GET metadata only for runner-platform-journal-app and runner-platform-journal-ca", "codicarium.secret-metadata/v1"],
  ["CMD-008-POSTGRES-TLS-RBAC", "postgres-wire", "verify-full connection and closed SQL assertion set", "codicarium.postgres-tls-rbac/v1"],
  ["CMD-009-NODE-LOSS", "cnpg-evidence-controller", "single-node loss write continuity synchronous replica and reseed exercise", "codicarium.cnpg-n-minus-one/v1"],
  ["CMD-010-NETWORK-VERIFY", "network-conformance-controller", "run exact positive and negative flow matrix", "codicarium.network-conformance/v2"],
  ["CMD-011-INDEPENDENT-READBACK", "release-readback-controller", "authenticated canonical target GET by read-only identity", "codicarium.independent-readback/v1"],
  ["CMD-012-EPOCH-CAS", "postgres-wire", "serializable writer epoch acknowledgement and stale-writer rejection", "codicarium.writer-epoch/v1"],
  ["CMD-013-LEGACY-RUNS-READ", "github-rest", "GET all runs for five retired workflow IDs", "codicarium.legacy-runs/v1"],
  ["CMD-014-LEGACY-RUN-CANCEL", "github-rest", "POST cancel for each queued or in-progress retired run", "codicarium.legacy-cancellation/v1"],
  ["CMD-015-QUIESCENCE-READ", "authority-inventory-controller", "read revoked credentials sessions environments and runner routes", "codicarium.quiescence/v1"],
  ["CMD-016-ARCHIVE-VERIFY", "sandbox-archive-verifier", "run bounded streaming archive negative vectors", "codicarium.archive-bounds/v1"],
  ["CMD-017-REPLAY-VERIFY", "replay-ledger-controller", "run atomic thirty-two-attempt replay race", "codicarium.replay-race/v1"],
  ["CMD-018-CHECKS-READ", "github-rest", "GET exact five check runs at one head", "codicarium.protected-checks/v1"],
  ["CMD-019-RELEASE-READBACK", "release-readback-controller", "read canonical tag release image chart and fourteen assets", "codicarium.release-live/v1"],
  ["CMD-020-GATE-AGGREGATE", "gate-controller", "aggregate fresh live GATE-001 through GATE-014 without activation", "codicarium.activation-authorization/v1"]
];
const commands = commandRows.map((row) => ({
  id: row[0], executor: row[1], operation: row[2],
  arguments: { profile: row[0].toLowerCase(), activation_side_effect: false }, output_schema: row[3]
}));

const gateCommands = [
  ["CMD-001-REPOSITORY-READ"], ["CMD-002-BASELINE-READ"], ["CMD-003-NAMESPACE-READ", "CMD-004-ADMISSION-READ"],
  ["CMD-005-VAULT-READ"], ["CMD-006-CNPG-READ", "CMD-007-SECRET-METADATA-READ", "CMD-008-POSTGRES-TLS-RBAC"],
  ["CMD-009-NODE-LOSS"], ["CMD-010-NETWORK-VERIFY"], ["CMD-011-INDEPENDENT-READBACK"], ["CMD-012-EPOCH-CAS"],
  ["CMD-002-BASELINE-READ", "CMD-003-NAMESPACE-READ"], ["CMD-013-LEGACY-RUNS-READ", "CMD-014-LEGACY-RUN-CANCEL", "CMD-015-QUIESCENCE-READ"],
  ["CMD-016-ARCHIVE-VERIFY", "CMD-017-REPLAY-VERIFY"], ["CMD-018-CHECKS-READ"], ["CMD-019-RELEASE-READBACK", "CMD-011-INDEPENDENT-READBACK"], ["CMD-020-GATE-AGGREGATE"]
];
const predicates = [
  "post-create read returns the exact private repository, numeric ID, node ID, main default branch, creation/protection receipts, seed SHA and approved spec hash",
  "all seven heads equal the frozen baseline map and focused re-audit is complete",
  "all four namespaces and fail-closed admission objects exist and every spoof negative is denied",
  "exact Vault transit auth and KV objects exist with no wildcard and direct TLS passes",
  "three CNPG instances plus actual app and CA Secret metadata exist and verify-full positive and negative probes pass",
  "loss of any node preserves writes on two nodes with synchronous health, zero data loss and RTO at most one hundred twenty seconds",
  "every allow and deny flow passes; NetworkPolicy claims no ServiceAccount identity and central admission is enforced",
  "all twenty mutations have canonical target readback by a distinct read-only identity with no writer digest or mismatch",
  "every enumerated writer acknowledges one serializable durable epoch and every stale writer is denied before side effect",
  "runner-config descriptor values and handoff blobs retain exact digests; runner-config-dev has zero mutations and no UID claim",
  "five workflows and all queued or running runs are terminal and every credential token session environment and route is quiescent",
  "all hard archive-limit negatives fail with zero effects and the replay race has exactly one winner",
  "exact five checks from GitHub Actions app 15368 pass at one head and live identity is non-fixture",
  "v0.6.14 is forward-only with twenty signed receipts fourteen assets and zero canonical readback mismatches",
  "GATE-001 through GATE-014 each has fresh live non-synthetic PASS evidence and aggregation returns READY_NOT_ACTIVATED"
];
const gates = predicates.map((predicate, index) => {
  const id = `GATE-${String(index + 1).padStart(3, "0")}`;
  return {
    id, owner: index === 3 ? "codicarium/vault-config" : "codicarium/release-security",
    depends_on: index === 14 ? predicates.slice(0, 14).map((unused, item) => `GATE-${String(item + 1).padStart(3, "0")}`) : [],
    command_ids: gateCommands[index], evidence_schema: `codicarium.${id.toLowerCase()}-evidence/v1`,
    freshness_max_age_seconds: index === 5 ? 86400 : 600, pass_predicate: predicate,
    failure_state: "BLOCKED_PREACTIVATION"
  };
});

const dagRows = [
  ["S01", "pipeline/spec", []], ["R10", "github/codicarium", ["S01"]], ["R11", "codicarium/release-platform-config", ["R10"]],
  ["C20", "codicarium/codicarium-actions", ["R11"]], ["A20", "codicarium/infra", ["C20"]],
  ["T20", "codicarium/postgres-config+codicarium/vault-config", ["R11"]], ["G20", "codicarium/release-platform-config", ["A20", "T20"]],
  ["W20", "codicarium/deployment-controller", ["S01"]], ["W21", "codicarium/deployment-controller", ["W20"]],
  ["P20", "codicarium/deployment-controller", ["W21"]], ["Q30", "codicarium/release-security", ["G20", "P20"]],
  ["X31", "codicarium/release-platform-config", ["Q30"]], ["X32", "codicarium/release-platform-config", ["X31"]],
  ["X33", "codicarium/release-platform-config", ["X32"]], ["D40", "codicarium/deployment-controller", ["S01"]],
  ["D41", "cross-repository", ["X33", "D40"]], ["D42", "codicarium/release-security", ["D41"]],
  ["Z50", "codicarium/release-platform-config", ["D42"]]
];
const actions = {
  S01: "unanimous exact-hash spec approval with unresolved repository ID",
  R10: "create repository and stop if it already exists",
  R11: "commit authenticated RepositoryBindingEnvelope",
  C20: "land shared schemas readback archive and replay contracts",
  A20: "land central namespaces admission capacity Kata and proxy",
  T20: "land CNPG TLS journal and exact Vault authority",
  G20: "land activation-disabled desired state using committed binding",
  W20: "disable and delete five legacy workflow definitions",
  W21: "cancel runs and prove credential and session quiescence",
  P20: "bind exact protected checks and non-fixture identity",
  Q30: "qualify infrastructure trust workflow and authority evidence",
  X31: "require every grant Application absent and reject subsets",
  X32: "create complete new grant and Application set atomically",
  X33: "prove complete set ready with runner-config-dev unchanged",
  D40: "land successor work linked to closed issue 93 without reopening",
  D41: "collect forward-only v0.6.14 evidence after X33 and D40",
  D42: "aggregate fresh live gates without activation side effects",
  Z50: "perform separate post-authorization activation as leaf"
};
const gateMap = {
  R11: ["GATE-001"], C20: ["GATE-012"], A20: ["GATE-003", "GATE-006", "GATE-007"],
  T20: ["GATE-004", "GATE-005", "GATE-006"], G20: ["GATE-008", "GATE-009", "GATE-010"],
  W21: ["GATE-011"], P20: ["GATE-013"], Q30: ["GATE-002"], D41: ["GATE-014"], D42: ["GATE-015"]
};
const dag = dagRows.map((row) => ({
  id: row[0], repository: row[1], action: actions[row[0]], depends_on: row[2], gate_ids: gateMap[row[0]] || []
}));

const commandSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema", type: "array", minItems: 20, maxItems: 20,
  items: { type: "object", additionalProperties: false,
    required: ["id", "executor", "operation", "arguments", "output_schema"],
    properties: {
      id: { type: "string", pattern: "^CMD-[0-9]{3}-[A-Z0-9-]+$" }, executor: { type: "string", minLength: 3 },
      operation: { type: "string", minLength: 12 }, arguments: { type: "object" },
      output_schema: { type: "string", pattern: "^codicarium\\.[a-z0-9.-]+/v[0-9]+$" }
    }
  }
};
const dagSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema", type: "array", minItems: 18, maxItems: 18,
  items: { type: "object", additionalProperties: false,
    required: ["id", "repository", "action", "depends_on", "gate_ids"],
    properties: {
      id: { type: "string", pattern: "^[A-Z][0-9]{2}$" }, repository: { type: "string", minLength: 1 },
      action: { type: "string", minLength: 12 }, depends_on: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^[A-Z][0-9]{2}$" } },
      gate_ids: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^GATE-[0-9]{3}$" } }
    }
  }
};
const gateSchemas = {};
const gateEvidence = [];
for (const gate of gates) {
  gateSchemas[gate.id] = {
    $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: false,
    required: ["schema", "gate_id", "evidence_class", "publication_authority", "observed_at", "command_outputs", "result"],
    properties: {
      schema: { const: gate.evidence_schema }, gate_id: { const: gate.id }, evidence_class: { enum: ["synthetic", "live"] },
      publication_authority: { type: "boolean" }, observed_at: { type: "string", format: "date-time" }, result: { enum: ["PASS", "FAIL"] },
      command_outputs: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
        required: ["command_id", "sha256"], properties: { command_id: { type: "string" }, sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } }
      }
    }
  }
  };
  gateEvidence.push({
    schema: gate.evidence_schema, gate_id: gate.id, evidence_class: "synthetic", publication_authority: false,
    observed_at: TIME, result: "PASS", command_outputs: gate.command_ids.map((id) => ({ command_id: id, sha256: hash(Buffer.from(id)) }))
  });
}
write("command-catalog-v2.1.schema.json", commandSchema);
write("command-catalog-v2.1.fixture.json", commands);
write("executable-gates-v2.1.schemas.json", { schema: "codicarium.executable-gate-schema-bundle/v1", schemas: gateSchemas });
write("executable-gates-v2.1.fixture.json", gateEvidence);
write("rollout-dag-v2.1.schema.json", dagSchema);
write("rollout-dag-v2.1.fixture.json", dag);

const baseAnnex = read("feature-spec.v2.0.annex.json");
const networkPolicy = {
  api_version: "networking.k8s.io/v1", identity_claim: "none",
  selectors: ["Namespace metadata labels", "admission-verified immutable Pod labels", "protocol", "port", "ipBlock"],
  forbidden_claims: ["ServiceAccount identity", "Pod UID identity", "token identity"],
  admission_dependency: "release-platform-workload-identity-v1",
  rule: "NetworkPolicy does not authenticate ServiceAccounts; central admission validates the label and spec.serviceAccountName mapping."
};
const postgres = {
  owner_repository: "codicarium/postgres-config", namespace: "runner-platform-journal-dev", cluster: "runner-platform-journal",
  instances: 3, storage_class: "ceph-rbd-replicated",
  synchronous_replication: { required: true, minimum_sync_replicas: 1, n_minus_one_nodes: 1 },
  service: "runner-platform-journal-rw.runner-platform-journal-dev.svc.cluster.local", port: 5432,
  credentials: {
    app_secret: "runner-platform-journal-app", ca_secret: "runner-platform-journal-ca",
    read_rule: "metadata-only except one memory-only app credential transfer", committed: false
  },
  tls: {
    mode: "verify-full", server_name: "runner-platform-journal-rw.runner-platform-journal-dev.svc.cluster.local",
    ca_source: "Secret runner-platform-journal-ca", delivery: "read-only projected volume",
    rotation: "overlap old and new CA until every client reports the new digest, then negative-probe the old CA",
    negative_probes: ["wrong CA", "wrong SAN", "expired certificate", "plaintext connection"]
  },
  vault: {
    path: "codicarium/dev/release-platform/journal-app", write: "KV-v2 create-only version 1",
    readback: "independent metadata version and value digest; never log value", auth_role: "release-platform-journal-bootstrap",
    retirement: "delete bootstrap auth role and workload after verified runtime login"
  },
  network_policy: networkPolicy,
  rbac: {
    runtime_direct_dml: false, runtime_temp: false, runtime_schema_create: false, runtime_execute_only: true,
    owner_login: false, migrator_login_after_migration: false
  },
  n_minus_one_gate: "GATE-006"
};
const annex = {
  ...baseAnnex,
  schema: "codicarium.deployment-controller-release-spec/v2.1", generated_at: TIME,
  revision: {
    predecessor: "v2.0", council_decision: "rejected_return_to_spec",
    closure_target: "all planner security and DevOps NO-GO findings", source_artifacts_immutable: true
  },
  council_closure_matrix: [
    { id: "CLOSE-001", finding: "planner executable live gates", resolution: "closed commands typed schemas owners freshness and predicates", gate_ids: gates.map((gate) => gate.id), dag_ids: ["Q30", "D42"] },
    { id: "CLOSE-002", finding: "planner cross-repository ordering", resolution: "exact closed acyclic S01 through Z50 graph", gate_ids: ["GATE-015"], dag_ids: dag.map((node) => node.id) },
    { id: "CLOSE-003", finding: "security writer-supplied readback", resolution: "separate authenticated read-only canonical collector", gate_ids: ["GATE-008", "GATE-014"], dag_ids: ["G20", "D41"] },
    { id: "CLOSE-004", finding: "security legacy run and credential quiescence", resolution: "inventory cancel terminal poll revoke and maximum-TTL wait", gate_ids: ["GATE-011"], dag_ids: ["W20", "W21"] },
    { id: "CLOSE-005", finding: "security concurrent writer fence", resolution: "serializable durable epoch CAS acknowledged by every writer", gate_ids: ["GATE-009"], dag_ids: ["G20"] },
    { id: "CLOSE-006", finding: "security archive resource ceilings and replay", resolution: "hard entry path expansion ratio CPU memory deadline limits and atomic four-field replay key", gate_ids: ["GATE-012"], dag_ids: ["C20"] },
    { id: "CLOSE-007", finding: "DevOps stale baselines", resolution: "seven supplied current immutable heads plus focused re-audit", gate_ids: ["GATE-002"], dag_ids: ["S01", "Q30"] },
    { id: "CLOSE-008", finding: "DevOps unsuitable authority repository", resolution: "SpecEnvelope R10 creation and immutable R11 RepositoryBindingEnvelope", gate_ids: ["GATE-001"], dag_ids: ["R10", "R11"] },
    { id: "CLOSE-009", finding: "DevOps unsafe grant replacement and UID claim", resolution: "runner-config-dev unchanged by three blob digests; new complete-set grant only; no adoption or UID claim", gate_ids: ["GATE-010"], dag_ids: ["X31", "X32", "X33"] },
    { id: "CLOSE-010", finding: "DevOps GVK and NetworkPolicy identity", resolution: "exact authority list; NetworkPolicy selectors only; central fail-closed admission enforces identity", gate_ids: ["GATE-003", "GATE-007"], dag_ids: ["A20"] },
    { id: "CLOSE-011", finding: "DevOps CNPG Secret TLS Vault and N-1", resolution: "actual app and CA Secrets verify-full rotation create-only Vault and any-node-loss evidence", gate_ids: ["GATE-004", "GATE-005", "GATE-006"], dag_ids: ["T20"] }
  ],
  baselines,
  repository_ids: { ...baseAnnex.repository_ids, "codicarium/release-platform-config": null },
  spec_envelope: {
    schema: "codicarium.release-platform-spec-envelope/v1", approved_spec_sha256: null,
    repository_full_name: "codicarium/release-platform-config", repository_id: null,
    unresolved_legal_until: "R10", resolver: "R10 authenticated create response followed by R11 authenticated repository GET",
    constraints: [
      "R10 occurs only after unanimous exact-hash approval at S01",
      "pre-existing repository at R10 is a terminal stop",
      "no grant credential workflow workload or activation consumer may use an unresolved ID"
    ]
  },
  repository_binding_envelope: {
    schema: "codicarium.release-platform-repository-binding-envelope/v1", state: "ABSENT_PRE_R11",
    required_fields: [
      "repository_numeric_id", "repository_node_id", "private", "default_branch", "creation_receipt_sha256",
      "protection_receipt_sha256", "seed_commit_sha", "approved_spec_sha256"
    ],
    invariants: [
      "committed at R11", "numeric ID is positive decimal", "private is true", "default branch is main",
      "approved spec hash equals S01 bytes", "no delete or recreate after binding"
    ]
  },
  release_authority_repository: {
    full_name: "codicarium/release-platform-config", state: "MUST_BE_CREATED", numeric_repository_id: null,
    suitability: "no existing repository is a suitable separate least-privilege release authority",
    freeze_rule: "freeze only from authenticated R11 evidence after creation",
    bootstrap: "after unanimous S01 approval R10 creates the repository and R11 commits the binding; the authority does not create itself",
    owns: ["release platform chart and values", "broker and journal client desired state", "gate aggregation", "Z50 activation"]
  },
  current_github_facts: {
    issue_93_state: "closed", issue_93_role: "historical predecessor; successor work links to it and does not reopen it",
    release_v0_6_13: "exists", release_v0_6_14: "absent", observed_at: "2026-08-25T22:25:00Z"
  },
  activation: {
    state: "BLOCKED_PREACTIVATION", required_gate_ids: gates.map((gate) => gate.id), authorization_gate: "GATE-015",
    activation_is_separate_dag_node: "Z50", synthetic_evidence_authorizes: false, circular_dependency: false
  },
  command_catalog: commands,
  executable_gates: gates,
  rollout_dag: { schema: "codicarium.cross-repository-rollout-dag/v1", closed_world: true, nodes: dag, activation_node: "Z50" },
  central_namespace_and_admission: {
    owner_repository: "codicarium/infra",
    namespaces: ["arc-runners-v2-control", "arc-runners-v2-untrusted", "artifact-capability", "runner-platform-journal-dev"],
    namespace_creation_by_workload_charts: false,
    policy: {
      api_version: "admissionregistration.k8s.io/v1", kind: "ValidatingAdmissionPolicy",
      name: "release-platform-workload-identity-v1", binding: "release-platform-workload-identity-v1",
      failure_policy: "Fail", match_policy: "Equivalent"
    },
    exact_authority: [
      "v1/Pod", "v1/Service", "v1/ServiceAccount", "apps/v1/Deployment", "batch/v1/Job",
      "networking.k8s.io/v1/NetworkPolicy", "policy/v1/PodDisruptionBudget", "cert-manager.io/v1/Issuer",
      "cert-manager.io/v1/Certificate", "monitoring.coreos.com/v1/ServiceMonitor",
      "monitoring.coreos.com/v1/PrometheusRule", "postgresql.cnpg.io/v1/Cluster"
    ],
    invariants: [
      "approved workload maps to one exact spec.serviceAccountName", "identity label equals approved mapping",
      "updates cannot change identity or serviceAccountName", "unapproved group kind or namespace is denied",
      "controller service accounts cannot create admission exceptions"
    ],
    negative_cases: [
      "spoof label", "change serviceAccountName", "missing label", "extra apiGroup", "extra kind",
      "extra namespace", "policy unavailable", "binding unavailable"
    ]
  },
  network_policy_enforcement: networkPolicy,
  postgres_journal: postgres,
  postgres_gitops: { ...baseAnnex.postgres_gitops, access_bootstrap_contract: postgres },
  postgres_access_contract: postgres,
  service_runtime: {
    ...baseAnnex.service_runtime, postgres_access: postgres, ingress_flows: [],
    network_policy_enforcement: networkPolicy, activation_blockers: gates.map((gate) => gate.id)
  },
  grant_migration: {
    schema: "codicarium.grant-separation/v2.1",
    runner_config_dev: {
      name: "runner-config-dev", profile_ref: "arc-path-helm", mutation_allowed: false,
      recreation_allowed: false, uid_preservation_claimed: false
    },
    runner_config_invariant: {
      baseline_commit: baselines["codicarium/runner-config"],
      descriptor_path: ".codicarium/dev/deploy.yaml",
      descriptor_blob_sha256: "85ccb1d1be03c71d2e2004d7819fddbd80189ce678c47f5dc3ddb25041a7589b",
      values_path: ".codicarium/dev/values.yaml",
      values_blob_sha256: "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
      handoff_path: ".codicarium/dev/handoff-policy.yaml",
      handoff_blob_sha256: "f2564ab21178ee42dbda98fd465c7e3023ff1cec5522e93d4d9b93ff59100a4e",
      branch_head_movement_is_invariant: false
    },
    new_authority_grant: {
      repository: "codicarium/release-platform-config",
      repository_id_source: "R11.RepositoryBindingEnvelope.repository_numeric_id",
      environment: "dev", created_after_binding: true, duplicate_runner_grant: false
    },
    writer_fence: {
      store: "release_journal.writer_epoch", compare_and_swap: true, serializable: true,
      acknowledgement: "every enumerated controller and workflow writer", stale_epoch_result: "deny before side effect"
    },
    prepare_activation: {
      node: "X31", required_grant_applications_absent: "ALL", subset_allowed: false,
      partial_existing_set_result: "BLOCKED_PREACTIVATION", create_node: "X32", ready_node: "X33"
    },
    adoption: "No existing runner-config grant or workload is adopted and no UID preservation claim is made.",
    rollback: "preactivation removal of only the complete new set; after activation use a new forward epoch"
  },
  independent_readback: {
    collector: "release-platform-readback", writer_identity_reuse: false, writer_supplied_digest_accepted: false,
    method: "authenticate independently and read canonical target state; canonicalize RFC 8785 JSON or hash exact raw bytes; sign with readback-only transit authority",
    binds: [
      "target type", "immutable target ID", "mutation receipt digest", "canonical state digest",
      "byte length", "reader principal", "observed time", "previous readback digest"
    ],
    mismatch: "UNKNOWN_MANUAL and BLOCKED_PREACTIVATION without mutation retry"
  },
  old_workflow_retirement: {
    ...baseAnnex.old_workflow_retirement,
    cancellation: {
      inventory_command: "CMD-013-LEGACY-RUNS-READ", cancel_command: "CMD-014-LEGACY-RUN-CANCEL",
      states_to_cancel: ["queued", "in_progress"], success_states: ["cancelled", "completed"], rerun_disabled: true
    },
    quiescence: {
      command: "CMD-015-QUIESCENCE-READ", active_tokens: 0, active_sessions: 0, active_runner_jobs: 0,
      wait_rule: "maximum observed token or session TTL after revocation", first_claim_before_quiescence: false
    },
    gate: "GATE-011"
  },
  archive_profile: {
    ...baseAnnex.archive_profile,
    hard_limits: {
      maximum_entries: 256, maximum_path_utf8_bytes: 240, maximum_component_utf8_bytes: 100,
      maximum_expanded_bytes: 1073741824, maximum_single_entry_bytes: 536870912,
      maximum_compression_ratio: 200, cpu_seconds: 120, memory_bytes: 536870912,
      deadline_seconds: 180, maximum_nesting_depth: 16
    },
    forbidden_entries: [
      "absolute path", "dot-dot component", "duplicate normalized path", "symlink", "hardlink",
      "device", "fifo", "socket", "sparse extent", "pax override", "additional zstd frame"
    ],
    enforcement: "streaming preflight and sandbox resource limits; breach kills sandbox and emits typed zero-side-effect evidence"
  },
  replay_protection: {
    atomic_key: ["token_issuer", "token_jti", "pod_uid", "listener_id"],
    store: "linearizable durable ledger", reserve: "single compare-and-create before side effect",
    terminal_tombstone: true, retention: "token expiry plus skew plus audit retention",
    duplicate_result: "deny", ambiguous_result: "UNKNOWN_MANUAL without retry",
    race_oracle: "32 concurrent attempts produce exactly one winner"
  },
  files: [],
  fixture_counts: { ...baseAnnex.fixture_counts }
};

const manifest = files(DST).map((name) => {
  const data = fs.readFileSync(name);
  return { path: path.relative(RUN, name).split(path.sep).join("/"), byte_length: data.length, sha256: hash(data) };
});
annex.files = manifest;
annex.fixture_counts = {
  ...annex.fixture_counts, manifest_files: manifest.length, draft_2020_12_schemas: 16,
  executable_gates: 15, closed_commands: 20, rollout_dag_nodes: 18
};
const annexData = bytes(annex);
const annexHash = hash(annexData);
fs.writeFileSync(path.join(RUN, "feature-spec.v2.1.annex.json"), annexData);

const baseSpec = read("feature-spec.v2.0.draft.json");
const replacements = {
  "REQ-001": "Freeze the seven v2.1 baselines. SpecEnvelope keeps release-platform-config unresolved through unanimous S01 approval; R10 stops if it already exists and creates it otherwise; R11 commits RepositoryBindingEnvelope before any consumer uses its numeric ID.",
  "REQ-019": "Before a v0.6.14 side effect, disable and delete all five legacy workflows, enumerate and cancel every queued or running run, disable reruns, and prove terminal states through GATE-011.",
  "REQ-020": "Before the first claim, revoke legacy secrets environments and runner routes, inventory credentials and sessions, and remain quiescent for the maximum observed TTL with zero active token session or job.",
  "REQ-021": "Any recovery successor is a new workflow identity after verified v0.6.14 with one typed broker target and no contents write broad token reusable secret signing key or legacy session.",
  "REQ-022": "Treat candidate archives as hostile: enforce the annex entry path expansion single-entry compression nesting CPU memory and deadline ceilings in a sandbox, reject unsafe entry types, and prove zero effects for every breach.",
  "REQ-025": "Use NetworkPolicy only for namespace labels admission-verified immutable Pod labels protocol port and IP blocks; it MUST NOT claim ServiceAccount identity. Central ValidatingAdmissionPolicy and Binding fail closed on the exact group kind namespace identity label and serviceAccountName mapping.",
  "REQ-026": "Keep BLOCKED_PREACTIVATION until GATE-001 through GATE-015 each has fresh typed live non-synthetic PASS evidence. GATE-015 aggregates without activation and Z50 is a separate leaf.",
  "REQ-027": "Keep runner-config-dev and arc-path-helm unchanged by exact descriptor values and handoff blob SHA-256. Create the separate release-platform-config grant only from R11 binding and never duplicate the runner grant.",
  "REQ-028": "Do not replace delete recreate or adopt runner-config-dev and do not claim UID preservation. Fence every new authority writer with a serializable durable epoch CAS acknowledged before any claim.",
  "REQ-031": "postgres-config owns three-instance runner-platform-journal using actual Secrets runner-platform-journal-app and runner-platform-journal-ca; clients use verify-full TLS and create-only Vault transfer; infra owns namespaces/admission; release-platform-config owns release desired state; app-config is bootstrap-only.",
  "REQ-033": "Treat existing v0.6.13 as immutable historical release evidence, never reuse or mutate it, and release only new forward v0.6.14 after all gates without restoring legacy authority.",
  "REQ-034": "Treat closed issue 93 as historical predecessor, link successor work without reopening it, and sequence implementation through the exact S01 to Z50 DAG with all protected checks at each exact head.",
  "REQ-035": "Post-merge evidence discovers the successor corrective merge and exact protected workflow identities, binds one live non-fixture identity through claim journal receipts checks tag source image chart fourteen assets retirement and final non-draft v0.6.14 readback.",
  "REQ-036": "Ship the v2.0 corpus plus v2.1 command gate-evidence and DAG schemas; validate duplicate keys schema closure exact manifests DAG acyclicity independent readback archive ceilings replay race and every GATE binding."
};
const requirements = baseSpec.requirements.map((item) => ({
  ...item,
  statement: replacements[item.id] || item.statement.replaceAll("v2.0", "v2.1"),
  rationale: `Fail-closed requirement bound to v2.1 annex SHA-256 ${annexHash}.`
}));
const additions = [
  ["REQ-037", "Define GATE-001 through GATE-015 with stable IDs owners dependencies closed command IDs typed evidence schemas maximum ages and objective predicates; shell and manual probes are non-authorizing."],
  ["REQ-038", "Execute the exact closed edges S01-R10-R11-C20-A20-T20-G20-Q30, S01-W20-W21-P20-Q30, W21-G20, R11-T20 and G20, Q30-X31-X32-X33, S01-D40, and X33 plus D40-D41-D42-Z50; Z50 is a leaf."],
  ["REQ-039", "For every mutation a distinct read-only collector authenticates to the target, reads canonical state independently, hashes canonical JSON or raw bytes, binds the mutation and prior readback, and signs it; writer-supplied digests are forbidden."],
  ["REQ-040", "Atomically reserve token issuer JTI Pod UID and listener ID in a durable linearizable ledger before effects, retain tombstones beyond expiry skew and audit retention, and permit exactly one winner in thirty-two concurrent attempts."],
  ["REQ-041", "Central admission enumerates exact core apps batch networking policy cert-manager monitoring and CNPG kinds and denies unapproved group kind namespace identity-label or serviceAccountName combinations when unavailable."],
  ["REQ-042", "GATE-005 and GATE-006 prove CNPG three-instance readiness actual app and CA Secret metadata verify-full CA SAN expiry and plaintext negatives synchronous replication any-node-loss continuity zero data loss and RTO at most one hundred twenty seconds."],
  ["REQ-043", "GATE-011 proves cancellation and terminal state for every queued or running legacy run plus credential session environment and runner-route quiescence before the first claim; file deletion alone is insufficient."],
  ["REQ-044", "Use SpecEnvelope then RepositoryBindingEnvelope: unresolved is legal only pre-R10; R11 binds numeric and node IDs privacy default branch receipts seed SHA and approved spec hash; unresolved consumers and post-binding delete or recreate are forbidden."],
  ["REQ-045", "PrepareActivation X31 requires ALL grant Applications absent and rejects subsets. Synthetic fixtures have publication_authority false; until fifteen fresh live gates pass the only state is BLOCKED_PREACTIVATION and no claim mutation activation or UID assertion is authorized."]
].map((row) => ({
  id: row[0], priority: "MUST", statement: row[1],
  rationale: `Closes a v2.0 council NO-GO finding against annex SHA-256 ${annexHash}.`
}));
requirements.push(...additions);

const acceptance = [];
const tests = [];
for (let index = 0; index < requirements.length; index += 2) {
  const ids = requirements.slice(index, index + 2).map((item) => item.id);
  const number = String(acceptance.length + 1).padStart(3, "0");
  acceptance.push({
    id: `AC-${number}`, requirement_ids: ids,
    scenario: `Given v2.1 annex and BLOCKED_PREACTIVATION, When ${ids.join(" and ")} use closed typed evidence and negatives, Then they pass exactly or authorize no claim mutation activation or UID assertion.`
  });
  tests.push({
    id: `TST-${number}`, type: index < 30 ? "integration" : "e2e", requirement_ids: ids,
    approach: `Run validate-v2.1.py and mapped gate oracles for ${ids.join(" and ")}; mutate every authority field and assert typed failure with zero side effects.`
  });
}
const traceIndex = new Map(requirements.map((item) => [item.id, { acceptance_ids: [], test_ids: [] }]));
for (const item of acceptance) for (const id of item.requirement_ids) traceIndex.get(id).acceptance_ids.push(item.id);
for (const item of tests) for (const id of item.requirement_ids) traceIndex.get(id).test_ids.push(item.id);
const traceability = requirements.map((item) => ({
  requirement_id: item.id, acceptance_ids: traceIndex.get(item.id).acceptance_ids,
  test_ids: traceIndex.get(item.id).test_ids,
  review_checks: [`Review ${item.id} against annex SHA-256 ${annexHash}.`],
  validation_checks: ["Run validate-v2.1.py; missing stale or synthetic live evidence remains BLOCKED_PREACTIVATION."]
}));

const spec = {
  ...baseSpec,
  meta: {
    ...baseSpec.meta, id: "SPEC-deployment-controller-issue-93-successor-v2-1",
    title: "Successor release-platform authority with executable preactivation gates",
    created_at: TIME, version: "2.1.0-council-closure"
  },
  feature: {
    problem_statement: "v2.0 was deterministic but rejected for stale baselines and unsafe prose gates readback retirement migration identity PostgreSQL and archive details. Issue 93 is closed and v0.6.13 exists while v0.6.14 is absent. v2.1 is linked successor work, not a reopening, and closes each finding with two authority envelopes, a closed DAG and typed gates.",
    goals: [
      "Create a non-circular separate release authority boundary.",
      "Make GATE-001 through GATE-015 executable typed fresh fail-closed and DAG-bound.",
      "Prove independent readback quiescent retirement writer fencing archive replay admission and CNPG N-1 behavior."
    ],
    non_goals: [
      "Reopen issue 93 alter v0.6.13 change runner-config-dev or preserve any UID.",
      "Claim any live preactivation gate already passes.",
      "Mutate repositories GitHub cluster Vault registry release or database during spec revision."
    ],
    scope_in: [
      `Exact annex SHA-256 ${annexHash} and ${manifest.length}-file manifest.`,
      "Seven baselines two envelopes exact S01 to Z50 DAG closed command catalog typed evidence and fifteen gates."
    ],
    scope_out: ["Activation before fresh live gates.", "Backward compatibility with v2.0 authority or legacy workflows."]
  },
  requirements, acceptance_criteria: acceptance, test_plan: tests, traceability,
  council: {
    perspectives: baseSpec.council.perspectives,
    consensus_summary: "Draft v2.1 structurally closes every v2.0 NO-GO; unanimous exact-hash council approval at S01 is required before R10.",
    open_questions: []
  }
};
const specData = bytes(spec);
fs.writeFileSync(path.join(RUN, "feature-spec.v2.1.draft.json"), specData);
console.log(JSON.stringify({
  v2_1: true, spec_sha256: hash(specData), annex_sha256: annexHash,
  requirements: requirements.length, acceptance_criteria: acceptance.length, tests: tests.length,
  traceability: traceability.length, manifest_files: manifest.length,
  gates: gates.length, commands: commands.length, dag_nodes: dag.length,
  activation: annex.activation.state, remaining_live_blockers: gates.length
}, null, 2));
