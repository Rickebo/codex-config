#!/usr/bin/env python3
import argparse
import base64
import copy
import hashlib
import json
import pathlib
import subprocess
import tempfile
from datetime import datetime, timezone

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from jsonschema import Draft202012Validator, FormatChecker

RUN = pathlib.Path("/home/rickebo/.codex/pipeline/runs/2026-08-24T16-21-43-985Z")
FIX = RUN / "fixtures-v2.2"
SPEC = RUN / "feature-spec.v2.2.draft.json"
ANNEX = RUN / "feature-spec.v2.2.annex.json"
BUILD = RUN / "build-v2.2-spec.mjs"
CHECK = FIX / "pipeline-spec-check-v2.2.json"
EXPECTED_BASELINES = {
    "codicarium/deployment-controller": "1de94f3267dea52b5e9194d32d15a69cb597d17e",
    "codicarium/vault-config": "8412372a2fb328070ec43d6a596b921b4fe05c8e",
    "codicarium/app-config": "6f1a2af06e5b970d6036b9a834320fea74a4dfc8",
    "codicarium/infra": "40073c068a9cf8ff4c1e625b97e09fda31b40637",
    "codicarium/runner-config": "9625e442a12c721e89250812f3d079b09833ccb0",
    "codicarium/postgres-config": "d5ccccfcfc5bae4d099f1848b68e07dcaa679d62",
    "codicarium/codicarium-actions": "9545b5a66498f67667e57d021507ac060fd016b6",
}

def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result

def load(path):
    return json.loads(path.read_text(), object_pairs_hook=no_duplicates)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def canonical(value):
    # The corpus deliberately uses the RFC 8785 interoperable JSON subset:
    # no floats, all strings ASCII, sorted Unicode code-point keys, no whitespace.
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()

def pae(payload_type, payload):
    return f"DSSEv1 {len(payload_type.encode())} {payload_type} {len(payload)} ".encode() + payload

def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)

def validate_envelope(envelope, envelope_validator, payload_validators, seen_nonces):
    envelope_validator.validate(envelope)
    payload = base64.b64decode(envelope["payload"], validate=True)
    payload_obj = json.loads(payload, object_pairs_hook=no_duplicates)
    assert payload == canonical(payload_obj), "payload is not exact JCS bytes"
    payload_validators[payload_obj["schema"]].validate(payload_obj)
    signature = base64.b64decode(envelope["signatures"][0]["sig"], validate=True)
    signer = envelope["signer"]
    if signer["kind"] == "test-only-ed25519/v1":
        public = serialization.load_der_public_key(base64.b64decode(signer["public_key_spki"]))
        assert isinstance(public, Ed25519PublicKey)
        public.verify(signature, pae(envelope["payloadType"], payload))
        assert envelope["publication_authority"] is False
    else:
        assert signer["kind"] in {"sigstore-keyless-workflow/v1", "vault-transit-kubernetes/v1"}
    observation = payload_obj["observation"]
    predicate = payload_obj["predicate"]
    issued, not_before, expires = map(parse_time, (observation["issued_at"], observation["not_before"], observation["expires_at"]))
    computed = parse_time(predicate["computed_at"])
    assert issued <= not_before <= expires
    assert issued <= computed <= expires
    assert (expires - computed).total_seconds() <= predicate["max_age_seconds"]
    assert observation["nonce"] not in seen_nonces
    seen_nonces.add(observation["nonce"])
    name = payload_obj["schema"].removeprefix("codicarium.").removesuffix("/v2")
    assert observation["request_sha256"] == hashlib.sha256(f"request:{name}".encode()).hexdigest()
    assert observation["payload_sha256"] == hashlib.sha256(f"raw:{name}".encode()).hexdigest()
    assert predicate["inputs_sha256"] == hashlib.sha256(f"inputs:{name}".encode()).hexdigest()
    assert predicate["evaluator_sha256"] == hashlib.sha256(f"evaluator:{name}:v2".encode()).hexdigest()
    assert predicate["result"] == "PASS"
    assert payload_obj["data"]["effect_count"] == 0
    live_authority = (
        observation["evidence_class"] == "live"
        and payload_obj["dag_node_id"] in {"Q42", "A51", "F00", "F01", "F02", "F03", "F04", *{f"M{i:02d}" for i in range(1, 20)}, "F20", "F21", "F22", "F23", "F24"}
        and predicate["result"] == "PASS"
        and signer["kind"] in {"sigstore-keyless-workflow/v1", "vault-transit-kubernetes/v1"}
        and observation["authority_claim"]["work_item_id"] != "fixture-only"
    )
    assert envelope["publication_authority"] is live_authority
    return payload_obj

def artifact_snapshot():
    paths = [SPEC, ANNEX] + sorted(FIX.rglob("*"))
    return {str(p.relative_to(RUN)): digest(p) for p in paths if p.is_file()}

def find_values(value, key):
    found = []
    if isinstance(value, dict):
        if key in value:
            found.append(value[key])
        for child in value.values():
            found.extend(find_values(child, key))
    elif isinstance(value, list):
        for child in value:
            found.extend(find_values(child, key))
    return found

parser = argparse.ArgumentParser()
parser.add_argument("--council", type=pathlib.Path)
args = parser.parse_args()

# Determinism is a validation prerequisite, not a generator assertion.
first_run = subprocess.run(["node", str(BUILD)], check=True, capture_output=True, text=True)
first = artifact_snapshot()
second_run = subprocess.run(["node", str(BUILD)], check=True, capture_output=True, text=True)
second = artifact_snapshot()
assert first == second, "two generations are not byte-identical"

# Parse every JSON document with duplicate-key rejection.
json_paths = [SPEC, ANNEX] + sorted(FIX.glob("*.json"))
documents = {path.name: load(path) for path in json_paths}
spec, annex = documents[SPEC.name], documents[ANNEX.name]
assert annex["baselines"] == EXPECTED_BASELINES
assert annex["current_facts"] == {
    "issue_93": "closed",
    "release_v0_6_13": "exists and immutable",
    "release_v0_6_14": "absent",
    "pr_108": "recover-release-v068 changes only canonical ACTIONS_STORAGE_OVH secrets plus documentation and tests",
}
assert annex["activation"] == {"state": "BLOCKED_PREACTIVATION", "synthetic_evidence_authorizes": False, "live_gate_count": 0, "required_live_gate_count": 37}
assert "codicarium/release-security" not in set(annex["owners"].values()) - {annex["owners"]["forbidden_owner"]}
assert annex["owners"]["forbidden_owner"] == "codicarium/release-security"

# Validate all schemas themselves and every positive payload/envelope.
bundle = documents["typed-payload-schemas-v2.2.json"]
assert bundle["count"] == len(bundle["schemas"]) == 37
for schema in bundle["schemas"].values():
    Draft202012Validator.check_schema(schema)
payload_validators = {name: Draft202012Validator(schema, format_checker=FormatChecker()) for name, schema in bundle["schemas"].items()}
envelope_schema = documents["command-evidence-envelope-v2.2.schema.json"]
Draft202012Validator.check_schema(envelope_schema)
envelope_validator = Draft202012Validator(envelope_schema, format_checker=FormatChecker())
positive = documents["signed-command-evidence-positive-v2.2.json"]
assert len(positive) == 37
seen_nonces = set()
payloads = [validate_envelope(item, envelope_validator, payload_validators, seen_nonces) for item in positive]
assert {item["schema"] for item in payloads} == set(bundle["schemas"])
assert not any(item["observation"]["evidence_class"] == "live" for item in payloads)
assert not any(item["publication_authority"] for item in positive)

# Execute representative cryptographic and schema mutations and require rejection.
def rejected(fn):
    try:
        fn()
    except Exception:
        return True
    return False

bad_signature = copy.deepcopy(positive[0])
raw_sig = bytearray(base64.b64decode(bad_signature["signatures"][0]["sig"])); raw_sig[0] ^= 1
bad_signature["signatures"][0]["sig"] = base64.b64encode(raw_sig).decode()
assert rejected(lambda: validate_envelope(bad_signature, envelope_validator, payload_validators, set()))
synthetic_authority = copy.deepcopy(positive[0]); synthetic_authority["publication_authority"] = True
assert rejected(lambda: validate_envelope(synthetic_authority, envelope_validator, payload_validators, set()))
bad_payload = copy.deepcopy(payloads[26]); bad_payload["data"]["purpose"] = "generic-download"
assert rejected(lambda: payload_validators[bad_payload["schema"]].validate(bad_payload))
bad_admin = copy.deepcopy(payloads[35]); bad_admin["data"]["approvers"] = ["only-one"]
assert rejected(lambda: payload_validators[bad_admin["schema"]].validate(bad_admin))
bad_vault = copy.deepcopy(payloads[14]); bad_vault["data"]["role_paths"] = ["secret/data/*"]
assert rejected(lambda: payload_validators[bad_vault["schema"]].validate(bad_vault))
bad_cnpg = copy.deepcopy(payloads[15]); bad_cnpg["data"]["distinct_nodes"] = 2
assert rejected(lambda: payload_validators[bad_cnpg["schema"]].validate(bad_cnpg))

negative = documents["negative-vectors-v2.2.json"]
assert len(negative) == 17
assert all(item["expected_result"] == "REJECT" and item["effect_count"] == 0 and item["oracle"] for item in negative)
assert {item["id"] for item in negative} >= {"synthetic-authority", "bad-signature", "non-jcs", "nonce-replay", "stale", "wrong-workflow", "wrong-pod-uid", "wrong-target", "predicate-forgery", "candidate-second-read", "collector-writer-overlap", "admin-single-approver", "break-glass-publish", "vault-wildcard", "cnpg-two-nodes", "proxy-generic-post", "unknown-retry"}

# Validate the exact schedulable DAG, including the terminal non-retrying branch.
dag = documents["rollout-dag-v2.2.json"]
dag_schema = documents["rollout-dag-v2.2.schema.json"]
Draft202012Validator.check_schema(dag_schema)
Draft202012Validator(dag_schema).validate(dag)
by_id = {node["id"]: node for node in dag}
assert len(by_id) == len(dag) == 101
assert by_id["S00"]["depends_on"] == [] and by_id["S01"]["depends_on"] == ["S00"]
assert by_id["CA20"]["depends_on"] == ["B15"]
for lane in ("IF", "PG", "VA", "RP", "DC"):
    assert by_id[f"{lane}20"]["depends_on"] == ["CA25"]
for lane in ("CA", "IF", "PG", "VA", "RP", "DC"):
    for number in range(21, 26):
        assert by_id[f"{lane}{number}"]["depends_on"] == [f"{lane}{number-1}"]
assert by_id["G30"]["depends_on"] == ["IF25"]
assert set(by_id["G32"]["depends_on"]) == {"PG25", "VA25"}
assert set(by_id["G34"]["depends_on"]) == {"RP25", "G31", "G33", "DC25"}
assert by_id["U00"]["depends_on"] == []
for number in range(1, 9):
    assert by_id[f"U{number:02d}"]["depends_on"] == [f"U{number-1:02d}"]
normal_ids = {node["id"] for node in dag if node["mode"] == "normal"}
assert all(not dep.startswith("U") for node in dag if node["id"] in normal_ids for dep in node["depends_on"])
assert not any(node["id"].startswith("U") and any(dep in {"F00", "F01", "F02", "F03", "F04"} or dep.startswith("M") for dep in node["depends_on"]) for node in dag)
temporary, permanent = set(), set()
def visit(node_id):
    if node_id in permanent: return
    assert node_id not in temporary, f"DAG cycle at {node_id}"
    temporary.add(node_id)
    for dep in by_id[node_id]["depends_on"]:
        assert dep in by_id
        visit(dep)
    temporary.remove(node_id); permanent.add(node_id)
for node_id in by_id: visit(node_id)

# Exact four-party, proxy, candidate, Vault, CNPG, admin and recovery contracts.
mutation = documents["mutation-contract-v2.2.json"]
assert len(mutation["steps"]) == 4
assert len({step["principal"] for step in mutation["steps"]}) == 4
assert "UNKNOWN freezes epoch; never retry" in mutation["invariants"]
proxy = documents["github-proxy-catalog-v2.2.json"]
assert proxy["default"] == "DENY" and "generic POST" in proxy["denials"] and len(proxy["operations"]) == 9
security = documents["security-contracts-v2.2.json"]
assert security["candidate_source"]["media_type"] == "application/gzip"
assert security["candidate_source"]["purpose"] == "deployment-controller-candidate-source"
assert security["candidate_source"]["create"] == {"success": 201, "conflict": 409, "mismatch": 422}
assert security["candidate_source"]["read"] == {"success_once": 200, "consumed": 410}
candidate = payloads[26]["data"]
assert candidate["audience"] == "deployment-controller-candidate-broker"
assert candidate["repository"] == "codicarium/deployment-controller" and candidate["commit_sha"] == EXPECTED_BASELINES["codicarium/deployment-controller"]
assert candidate["media_type"] == "application/gzip" and candidate["archive_byte_length"] > 0
assert candidate["object_key"] == f'{candidate["repository_id"]}/{candidate["commit_sha"]}/{candidate["archive_sha256"]}/{candidate["archive_byte_length"]}.tar.gz'
assert candidate["run_attempt"] == 1 and candidate["listener_id"] and candidate["jti"] and len(candidate["capability_nonce"]) == 64
assert security["cnpg"]["instances"] == security["cnpg"]["distinct_nodes"] == 3
assert security["cnpg"]["rpo_seconds"] == 0 and security["cnpg"]["rto_seconds_max"] <= 120
assert security["cnpg"]["tls"] == "verify-full"
assert security["admin"]["break_glass"]["approvers"] == 2
assert security["admin"]["break_glass"]["credential_ttl_seconds_max"] <= 300
assert {"bypass gates", "mint candidate", "mutate admission", "publish", "clear UNKNOWN"} <= set(security["admin"]["break_glass"]["forbidden"])
assert security["forward_recovery"]["schema"] == "codicarium.forward-recovery/v2"

# Every requirement has an exact requirement -> nodes -> commands -> schemas -> oracles trace.
requirements = {item["id"] for item in spec["requirements"]}
trace = annex["traceability"]
assert len(requirements) == len(trace) == 50
for number, phrase in ((46, "typed DSSE/JCS"), (47, "break-glass"), (48, "candidate-source-capability/v2"), (49, "release-security"), (50, "forward-only ambiguity repair")):
    statement = next(item["statement"] for item in spec["requirements"] if item["id"] == f"REQ-{number:03d}")
    assert phrase in statement
assert {row["requirement_id"] for row in trace} == requirements
command_ids = {item["id"] for item in documents["command-catalog-v2.2.json"]}
for row in trace:
    assert row["dag_nodes"] and set(row["dag_nodes"]) <= set(by_id)
    assert row["commands"] and set(row["commands"]) <= command_ids
    assert row["payload_schemas"] and set(row["payload_schemas"]) <= set(bundle["schemas"])
    assert row["positive_oracle"] and row["negative_oracles"] and row["negative_effect_count"] == 0
assert all(item["acceptance_ids"] and item["test_ids"] and item["review_checks"] and item["validation_checks"] for item in spec["traceability"])

# Re-run the actual pipeline checker, normalize its timestamp, and compare exact bytes.
with tempfile.TemporaryDirectory(prefix="v22-spec-check-") as directory:
    current_path = pathlib.Path(directory) / "spec-check.json"
    subprocess.run(["node", "/home/rickebo/.codex/bin/pipeline-spec-check.mjs", "--spec", str(SPEC), "--out", str(current_path)], check=True, capture_output=True, text=True)
    current = load(current_path)
current["checked_at"] = annex["generated_at"]
assert canonical(current) == canonical(load(CHECK))
assert current["ok"] is True and current["errors"] == []
assert annex["hash_bindings"]["spec_sha256"] == digest(SPEC)
assert annex["hash_bindings"]["pipeline_spec_check_sha256"] == digest(CHECK)

# Manifest is exact and closed over generated fixture files before annex creation.
manifest = annex["files"]
assert len(manifest) == len(list(FIX.glob("*"))) == 11
for item in manifest:
    target = RUN / item["path"]
    assert target.is_file() and target.stat().st_size == item["byte_length"] and digest(target) == item["sha256"]

# Optional final council validation proves the council reviewed this exact byte set.
if args.council:
    council = load(args.council)
    expected = {
        "spec_sha256": digest(SPEC),
        "annex_sha256": digest(ANNEX),
        "pipeline_spec_check_sha256": digest(CHECK),
    }
    for key, value in expected.items():
        assert value in find_values(council, key), f"council does not bind {key}={value}"

combined = hashlib.sha256("".join(f"{name}:{value}\n" for name, value in sorted(second.items())).encode()).hexdigest()
print(json.dumps({
    "status": "PASS v2.2 validator",
    "spec_sha256": digest(SPEC),
    "annex_sha256": digest(ANNEX),
    "pipeline_spec_check_sha256": digest(CHECK),
    "deterministic_artifact_set_sha256": combined,
    "deterministic_generations": 2,
    "json_documents": len(json_paths),
    "schemas_validated": 39,
    "typed_payload_schemas": len(bundle["schemas"]),
    "signed_positive_fixtures": len(positive),
    "negative_vectors": len(negative),
    "requirements": len(requirements),
    "acceptance_criteria": len(spec["acceptance_criteria"]),
    "tests": len(spec["test_plan"]),
    "trace_rows": len(trace),
    "commands": len(command_ids),
    "dag_nodes": len(dag),
    "synthetic_authorizing_records": sum(bool(item["publication_authority"]) for item in positive),
    "live_authorizing_records": 0,
    "remaining_live_blockers": annex["activation"]["required_live_gate_count"],
    "activation": annex["activation"]["state"],
    "council_hash_binding_checked": bool(args.council),
}, indent=2))
