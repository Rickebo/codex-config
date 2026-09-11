#!/usr/bin/env python3
import hashlib
import json
import pathlib
import re
import subprocess
import sys

from jsonschema import Draft202012Validator

RUN = pathlib.Path("/home/rickebo/.codex/pipeline/runs/2026-08-24T16-21-43-985Z")
FIXTURES = RUN / "fixtures-v2.1"
SPEC = RUN / "feature-spec.v2.1.draft.json"
ANNEX = RUN / "feature-spec.v2.1.annex.json"
SHA40 = re.compile(r"^[0-9a-f]{40}$")
SHA64 = re.compile(r"^[0-9a-f]{64}$")
BASELINES = {
    "codicarium/deployment-controller": "ef25cab94f8faec1d9824cc21f868b0b578858e4",
    "codicarium/vault-config": "8412372a2fb328070ec43d6a596b921b4fe05c8e",
    "codicarium/app-config": "6f1a2af06e5b970d6036b9a834320fea74a4dfc8",
    "codicarium/infra": "40073c068a9cf8ff4c1e625b97e09fda31b40637",
    "codicarium/runner-config": "9625e442a12c721e89250812f3d079b09833ccb0",
    "codicarium/postgres-config": "d5ccccfcfc5bae4d099f1848b68e07dcaa679d62",
    "codicarium/codicarium-actions": "9545b5a66498f67667e57d021507ac060fd016b6",
}

def load(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            assert key not in result, f"duplicate key {key} in {path}"
            result[key] = value
        return result
    return json.loads(path.read_text(), object_pairs_hook=unique)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

spec = load(SPEC)
annex = load(ANNEX)
base = subprocess.run(
    [sys.executable, str(RUN / "validate-v2.0.py")], cwd=RUN,
    text=True, capture_output=True, check=False,
)
assert base.returncode == 0, base.stdout + base.stderr
base_result = json.loads(base.stdout)
assert base_result["ok"] is True
assert base_result["manifest_files"] == 36

feature_schema = load(pathlib.Path("/home/rickebo/.codex/pipeline/feature-spec.schema.json"))
Draft202012Validator(feature_schema, format_checker=Draft202012Validator.FORMAT_CHECKER).validate(spec)
assert spec["meta"]["version"] == "2.1.0-council-closure"
assert annex["schema"] == "codicarium.deployment-controller-release-spec/v2.1"
assert annex["baselines"] == BASELINES
assert all(SHA40.fullmatch(value) for value in BASELINES.values())

authority = annex["release_authority_repository"]
assert authority["full_name"] == "codicarium/release-platform-config"
assert authority["state"] == "MUST_BE_CREATED"
assert authority["numeric_repository_id"] is None
assert annex["repository_ids"]["codicarium/release-platform-config"] is None
assert "after creation" in authority["freeze_rule"]

spec_envelope = annex["spec_envelope"]
binding = annex["repository_binding_envelope"]
assert spec_envelope["repository_id"] is None
assert spec_envelope["unresolved_legal_until"] == "R10"
assert "pre-existing repository at R10 is a terminal stop" in spec_envelope["constraints"]
assert any("unresolved ID" in item for item in spec_envelope["constraints"])
assert binding["state"] == "ABSENT_PRE_R11"
assert set(binding["required_fields"]) == {
    "repository_numeric_id", "repository_node_id", "private", "default_branch",
    "creation_receipt_sha256", "protection_receipt_sha256", "seed_commit_sha", "approved_spec_sha256",
}
assert "no delete or recreate after binding" in binding["invariants"]

gate_ids = [f"GATE-{number:03d}" for number in range(1, 16)]
activation = annex["activation"]
assert activation == {
    "state": "BLOCKED_PREACTIVATION", "required_gate_ids": gate_ids,
    "authorization_gate": "GATE-015", "activation_is_separate_dag_node": "Z50",
    "synthetic_evidence_authorizes": False, "circular_dependency": False,
}

commands = annex["command_catalog"]
assert len(commands) == 20
assert len({item["id"] for item in commands}) == 20
command_ids = {item["id"] for item in commands}
assert all(re.fullmatch(r"CMD-[0-9]{3}-[A-Z0-9-]+", item["id"]) for item in commands)
assert all(item["executor"] not in {"shell", "bash", "sh", "manual"} for item in commands)
assert all(item["operation"] and item["output_schema"].startswith("codicarium.") for item in commands)
assert all(item["arguments"]["activation_side_effect"] is False for item in commands)

gates = annex["executable_gates"]
assert [item["id"] for item in gates] == gate_ids
assert len({item["evidence_schema"] for item in gates}) == 15
for gate in gates:
    assert gate["owner"].startswith("codicarium/")
    assert gate["command_ids"] and set(gate["command_ids"]) <= command_ids
    assert 1 <= gate["freshness_max_age_seconds"] <= 86400
    assert len(gate["pass_predicate"]) >= 60
    assert gate["failure_state"] == "BLOCKED_PREACTIVATION"
assert gates[-1]["depends_on"] == gate_ids[:-1]

closures = annex["council_closure_matrix"]
assert [item["id"] for item in closures] == [f"CLOSE-{number:03d}" for number in range(1, 12)]
assert all(item["finding"] and item["resolution"] for item in closures)
assert all(set(item["gate_ids"]) <= set(gate_ids) for item in closures)

bundle = load(FIXTURES / "executable-gates-v2.1.schemas.json")
evidence = load(FIXTURES / "executable-gates-v2.1.fixture.json")
assert list(bundle["schemas"]) == gate_ids
assert [item["gate_id"] for item in evidence] == gate_ids
for record in evidence:
    schema = bundle["schemas"][record["gate_id"]]
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER).validate(record)
    assert record["evidence_class"] == "synthetic"
    assert record["publication_authority"] is False
    gate = next(item for item in gates if item["id"] == record["gate_id"])
    assert [item["command_id"] for item in record["command_outputs"]] == gate["command_ids"]
    assert all(SHA64.fullmatch(item["sha256"]) for item in record["command_outputs"])

expected_edges = {
    "S01": [], "R10": ["S01"], "R11": ["R10"], "C20": ["R11"],
    "A20": ["C20"], "T20": ["R11"], "G20": ["A20", "T20"],
    "W20": ["S01"], "W21": ["W20"], "P20": ["W21"],
    "Q30": ["G20", "P20"], "X31": ["Q30"], "X32": ["X31"],
    "X33": ["X32"], "D40": ["S01"], "D41": ["X33", "D40"],
    "D42": ["D41"], "Z50": ["D42"],
}
rollout = annex["rollout_dag"]
nodes = rollout["nodes"]
node_ids = {item["id"] for item in nodes}
assert rollout["closed_world"] is True
assert rollout["activation_node"] == "Z50"
assert len(nodes) == 18
assert node_ids == set(expected_edges)
assert {item["id"]: item["depends_on"] for item in nodes} == expected_edges
assert all(set(item["gate_ids"]) <= set(gate_ids) for item in nodes)
assert all(set(item["dag_ids"]) <= node_ids for item in closures)

by_id = {item["id"]: item for item in nodes}
visiting = set()
visited = set()
def visit(node_id):
    assert node_id not in visiting, f"cycle at {node_id}"
    if node_id in visited:
        return
    visiting.add(node_id)
    for dependency in by_id[node_id]["depends_on"]:
        visit(dependency)
    visiting.remove(node_id)
    visited.add(node_id)
for node_id in node_ids:
    visit(node_id)
assert visited == node_ids
assert by_id["Z50"]["gate_ids"] == []
assert not any("Z50" in item["depends_on"] for item in nodes)

facts = annex["current_github_facts"]
assert facts["issue_93_state"] == "closed"
assert "does not reopen" in facts["issue_93_role"]
assert facts["release_v0_6_13"] == "exists"
assert facts["release_v0_6_14"] == "absent"

grant = annex["grant_migration"]
assert grant["runner_config_dev"] == {
    "name": "runner-config-dev", "profile_ref": "arc-path-helm",
    "mutation_allowed": False, "recreation_allowed": False, "uid_preservation_claimed": False,
}
assert grant["new_authority_grant"]["repository_id_source"] == "R11.RepositoryBindingEnvelope.repository_numeric_id"
assert grant["writer_fence"]["compare_and_swap"] is True
assert grant["writer_fence"]["serializable"] is True
assert "no UID preservation claim" in grant["adoption"]
runner = grant["runner_config_invariant"]
assert runner == {
    "baseline_commit": BASELINES["codicarium/runner-config"],
    "descriptor_path": ".codicarium/dev/deploy.yaml",
    "descriptor_blob_sha256": "85ccb1d1be03c71d2e2004d7819fddbd80189ce678c47f5dc3ddb25041a7589b",
    "values_path": ".codicarium/dev/values.yaml",
    "values_blob_sha256": "ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356",
    "handoff_path": ".codicarium/dev/handoff-policy.yaml",
    "handoff_blob_sha256": "f2564ab21178ee42dbda98fd465c7e3023ff1cec5522e93d4d9b93ff59100a4e",
    "branch_head_movement_is_invariant": False,
}
assert grant["prepare_activation"] == {
    "node": "X31", "required_grant_applications_absent": "ALL",
    "subset_allowed": False, "partial_existing_set_result": "BLOCKED_PREACTIVATION",
    "create_node": "X32", "ready_node": "X33",
}

network = annex["network_policy_enforcement"]
assert network["api_version"] == "networking.k8s.io/v1"
assert network["identity_claim"] == "none"
assert "ServiceAccount identity" in network["forbidden_claims"]
assert "does not authenticate ServiceAccounts" in network["rule"]
admission = annex["central_namespace_and_admission"]
assert admission["owner_repository"] == "codicarium/infra"
assert admission["namespace_creation_by_workload_charts"] is False
assert admission["policy"]["api_version"] == "admissionregistration.k8s.io/v1"
assert admission["policy"]["kind"] == "ValidatingAdmissionPolicy"
assert admission["policy"]["failure_policy"] == "Fail"
expected_authority = {
    "v1/Pod", "v1/Service", "v1/ServiceAccount", "apps/v1/Deployment",
    "batch/v1/Job", "networking.k8s.io/v1/NetworkPolicy",
    "policy/v1/PodDisruptionBudget", "cert-manager.io/v1/Issuer",
    "cert-manager.io/v1/Certificate", "monitoring.coreos.com/v1/ServiceMonitor",
    "monitoring.coreos.com/v1/PrometheusRule", "postgresql.cnpg.io/v1/Cluster",
}
assert set(admission["exact_authority"]) == expected_authority
assert len(admission["negative_cases"]) == 8

postgres = annex["postgres_journal"]
assert postgres["owner_repository"] == "codicarium/postgres-config"
assert postgres["instances"] == 3
assert postgres["credentials"]["app_secret"] == "runner-platform-journal-app"
assert postgres["credentials"]["ca_secret"] == "runner-platform-journal-ca"
assert postgres["tls"]["mode"] == "verify-full"
assert postgres["tls"]["ca_source"] == "Secret runner-platform-journal-ca"
assert set(postgres["tls"]["negative_probes"]) == {
    "wrong CA", "wrong SAN", "expired certificate", "plaintext connection",
}
assert "overlap old and new CA" in postgres["tls"]["rotation"]
assert postgres["vault"]["write"] == "KV-v2 create-only version 1"
assert "never log value" in postgres["vault"]["readback"]
assert postgres["synchronous_replication"] == {
    "required": True, "minimum_sync_replicas": 1, "n_minus_one_nodes": 1,
}
assert postgres["rbac"]["runtime_direct_dml"] is False
assert postgres["rbac"]["runtime_execute_only"] is True

readback = annex["independent_readback"]
assert readback["writer_identity_reuse"] is False
assert readback["writer_supplied_digest_accepted"] is False
assert "authenticate independently" in readback["method"]
assert readback["mismatch"].startswith("UNKNOWN_MANUAL")
retirement = annex["old_workflow_retirement"]
assert set(retirement["cancellation"]["states_to_cancel"]) == {"queued", "in_progress"}
assert retirement["cancellation"]["rerun_disabled"] is True
quiescence = retirement["quiescence"]
assert quiescence["active_tokens"] == 0
assert quiescence["active_sessions"] == 0
assert quiescence["active_runner_jobs"] == 0
assert quiescence["first_claim_before_quiescence"] is False

limits = annex["archive_profile"]["hard_limits"]
assert limits == {
    "maximum_entries": 256, "maximum_path_utf8_bytes": 240,
    "maximum_component_utf8_bytes": 100, "maximum_expanded_bytes": 1073741824,
    "maximum_single_entry_bytes": 536870912, "maximum_compression_ratio": 200,
    "cpu_seconds": 120, "memory_bytes": 536870912,
    "deadline_seconds": 180, "maximum_nesting_depth": 16,
}
assert len(annex["archive_profile"]["forbidden_entries"]) == 11
replay = annex["replay_protection"]
assert replay["atomic_key"] == ["token_issuer", "token_jti", "pod_uid", "listener_id"]
assert replay["terminal_tombstone"] is True
assert replay["race_oracle"] == "32 concurrent attempts produce exactly one winner"

manifest = annex["files"]
assert len(manifest) == 42
assert annex["fixture_counts"]["manifest_files"] == 42
assert annex["fixture_counts"]["executable_gates"] == 15
assert annex["fixture_counts"]["closed_commands"] == 20
assert annex["fixture_counts"]["rollout_dag_nodes"] == 18
assert len({item["path"] for item in manifest}) == 42
actual = sorted(path.relative_to(RUN).as_posix() for path in FIXTURES.rglob("*") if path.is_file())
assert sorted(item["path"] for item in manifest) == actual
for item in manifest:
    relative = pathlib.PurePosixPath(item["path"])
    assert not relative.is_absolute()
    assert ".." not in relative.parts
    path = RUN / relative
    assert path.stat().st_size == item["byte_length"]
    assert digest(path) == item["sha256"]
    if path.suffix == ".json":
        load(path)

fixture_text = "\n".join(
    path.read_text() for path in FIXTURES.rglob("*.json")
)
assert "runner-platform-journal-bootstrap-owner" not in fixture_text
assert "same-peer-namespaceSelector-AND-podSelector-plus-exact-ServiceAccount" not in fixture_text
assert "combined exact namespace+pod label+workload spec.serviceAccountName" not in fixture_text

for schema_name, fixture_name in [
    ("command-catalog-v2.1.schema.json", "command-catalog-v2.1.fixture.json"),
    ("rollout-dag-v2.1.schema.json", "rollout-dag-v2.1.fixture.json"),
]:
    schema = load(FIXTURES / schema_name)
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema).validate(load(FIXTURES / fixture_name))

requirements = spec["requirements"]
assert len(requirements) == 45
assert all(item["priority"] == "MUST" for item in requirements)
assert len(spec["acceptance_criteria"]) == 23
assert len(spec["test_plan"]) == 23
assert len(spec["traceability"]) == 45
requirement_ids = {f"REQ-{number:03d}" for number in range(1, 46)}
assert {item["id"] for item in requirements} == requirement_ids
assert {item["requirement_id"] for item in spec["traceability"]} == requirement_ids
assert all(
    item["acceptance_ids"] and item["test_ids"] and
    item["review_checks"] and item["validation_checks"]
    for item in spec["traceability"]
)
assert digest(ANNEX) in json.dumps(spec)

print(json.dumps({
    "status": "PASS v2.1 validator",
    "base_validator": "PASS v2.0 exact validator",
    "spec_sha256": digest(SPEC), "annex_sha256": digest(ANNEX),
    "json_documents": sum(1 for path in FIXTURES.rglob("*.json")),
    "manifest_files": len(manifest),
    "requirements": len(requirements),
    "acceptance_criteria": len(spec["acceptance_criteria"]),
    "tests": len(spec["test_plan"]), "trace_rows": len(spec["traceability"]),
    "executable_gates": len(gates), "closed_commands": len(commands),
    "dag_nodes": len(nodes),
    "synthetic_authorizing_records": sum(1 for item in evidence if item["publication_authority"]),
    "activation": activation["state"], "remaining_live_blockers": 15,
}, indent=2))
