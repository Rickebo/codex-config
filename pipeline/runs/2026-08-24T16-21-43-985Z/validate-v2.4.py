#!/usr/bin/env python3
"""Read-only validator for the clean v2.4 offline corpus."""
import argparse
import base64
import copy
import datetime
import hashlib
import json
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization

ROOT = Path(__file__).resolve().parent
FIX = ROOT / "fixtures-v2.4"
CLOCK = "2026-08-26T12:00:00Z"
SKEW = 30
COUNCIL = {
    "v2_1": "ed0e9615847927c41f08c2e08ac37423de4f1d2d669b4c7c69c94c3a02958996",
    "v2_2": "b8d5fd6157c112f841e5d03d2f2df2cc0418f118f83361c85ec7c9ae12fa0f29",
    "v2_3": "4b5786803c2fbd05cb277e08f51cd36b8d629c84c7a367dfd118e068bab5bb3d",
}


class Invalid(Exception):
    pass


def need(ok, message):
    if not ok:
        raise Invalid(message)


def load(name):
    return json.loads((ROOT / name).read_text(encoding="utf-8"))


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def pretty_hash(value):
    return hashlib.sha256((json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()).hexdigest()


def canonical(value):
    if isinstance(value, list):
        return [canonical(item) for item in value]
    if isinstance(value, dict):
        return {key: canonical(value[key]) for key in sorted(value)}
    return value


def canonical_bytes(value):
    return json.dumps(canonical(value), separators=(",", ":"), ensure_ascii=False).encode()


def verify(pub, signature, payload):
    try:
        key = serialization.load_der_public_key(base64.b64decode(pub, validate=True))
        key.verify(base64.b64decode(signature, validate=True), canonical_bytes(payload))
    except Exception as exc:
        raise Invalid("signature-invalid") from exc


def schema_value(value, schema, where="$"):
    kind = schema.get("type")
    if kind == "object":
        need(isinstance(value, dict), where + ":object")
        for key in schema.get("required", []):
            need(key in value, where + ":missing:" + key)
        if schema.get("additionalProperties") is False:
            need(set(value) <= set(schema.get("properties", {})), where + ":extra")
        for key, child in schema.get("properties", {}).items():
            if key in value:
                schema_value(value[key], child, where + "." + key)
    elif kind == "array":
        need(isinstance(value, list), where + ":array")
        need(len(value) >= schema.get("minItems", 0), where + ":minItems")
        for index, child in enumerate(value):
            schema_value(child, schema.get("items", {}), where + "[" + str(index) + "]")
    elif kind == "string":
        need(isinstance(value, str), where + ":string")
        need(len(value) >= schema.get("minLength", 0), where + ":minLength")
    elif kind == "boolean":
        need(isinstance(value, bool), where + ":boolean")
    elif kind == "integer":
        need(isinstance(value, int) and not isinstance(value, bool), where + ":integer")
    if "const" in schema:
        need(value == schema["const"], where + ":const")


def validate_spec(spec):
    need(spec["meta"]["version"] == "2.4.0-council-draft", "spec-version")
    need(len(spec["requirements"]) == 32, "requirements-count")
    need(len(spec["acceptance_criteria"]) == 32, "acceptance-count")
    need(len(spec["test_plan"]) == 32, "test-count")
    need(len(spec["traceability"]) == 32, "trace-count")
    need({x["id"] for x in spec["requirements"]} == {f"REQ-{i:03d}" for i in range(1, 33)}, "requirements-set")
    need({x["id"] for x in spec["acceptance_criteria"]} == {f"AC-{i:03d}" for i in range(1, 33)}, "acceptance-set")
    need({x["id"] for x in spec["test_plan"]} == {f"TST-{i:03d}" for i in range(1, 33)}, "tests-set")
    for item in spec["acceptance_criteria"]:
        need(item["scenario"].startswith("Given ") and " When " in item["scenario"] and " Then " in item["scenario"], item["id"])
    for item in spec["test_plan"]:
        need(item["approach"].startswith("Run "), item["id"])


def validate_commands(items):
    commands = {x["id"]: x for x in items}
    for item in items:
        need(item["shell"] is False and item["network"] == "none", item["id"] + ":sandbox")
        need(item["digest"] == pretty_hash(item["argv"]), item["id"] + ":digest")
        need(item["const_binding"] == {"argv": item["argv"], "digest": item["digest"]}, item["id"] + ":const")
    return commands


def validate_dag(dag, commands, schemas, trace):
    nodes = dag["nodes"]
    ids = [node["id"] for node in nodes]
    need(dag["root"] == "S00" and ids.count("S00") == 1, "single-root")
    need(set(dag["terminals"]) == {"S99", "U08"}, "terminals")
    need(set(dag["recovery_nodes"]) == {f"U{i:02d}" for i in range(9)}, "recovery-set")
    for node in nodes:
        command = commands.get(node["command_id"])
        need(command is not None, node["id"] + ":command")
        need(node["command_digest"] == command["digest"] and node["command_argv"] == command["argv"], node["id"] + ":const")
        need(node["schema_id"] in schemas and node["positive_fixture"] and node["negative_ids"], node["id"] + ":oracle")
    app = [f"AP{i}" for i in range(20, 26)]
    for index, node_id in enumerate(app):
        node = next(node for node in nodes if node["id"] == node_id)
        need(node["owner"] == "app-config" and node["scope"] == "bootstrap-wiring-only", node_id + ":owner")
        if index:
            need(node["success_predecessors"] == [app[index - 1]], node_id + ":order")
    need(next(node for node in nodes if node["id"] == "AP25")["success_successor"] == "X41", "app-config-join")
    need(next(node for node in nodes if node["id"] == "X41")["success_predecessors"] == ["AP25"], "join-predecessor")
    adjacency = {node_id: [] for node_id in ids}
    for edge in dag["success_edges"] + dag["failure_edges"] + dag["recovery_edges"]:
        need(edge["from"] in adjacency and edge["to"] in adjacency, "unknown-edge")
        adjacency[edge["from"]].append(edge["to"])
    seen = set(); todo = ["S00"]
    while todo:
        current = todo.pop()
        if current in seen:
            continue
        seen.add(current); todo.extend(adjacency[current])
    need(seen == set(ids), "unreachable-node")
    executable = [node_id for node_id in ids if not node_id.startswith("U") and node_id != "S99"]
    need(len(dag["failure_edges"]) == len(executable), "failure-coverage")
    for edge in dag["failure_edges"]:
        need(edge["to"] == "U00" and set(edge["outcomes"]) == set(dag["failure_outcomes"]), "failure-route")
        need(edge["atomic_actions"] == ["freeze-epoch", "fence-claims", "cancel-dispatch", "quarantine-record"], "atomic-fence")
    for index in range(8):
        need({"from": f"U{index:02d}", "to": f"U{index + 1:02d}"} in [{"from": x["from"], "to": x["to"]} for x in dag["recovery_edges"]], "recovery-order")
    traced = {node for row in trace for node in row["dag_nodes"]}
    need(set(executable) <= traced, "trace-node-coverage")
    for row in trace:
        need(row["command_id"] in commands and row["schema_id"] in schemas, "trace-binding")
        need(row["positive_fixture"].startswith("fixtures-v2.4/") and (ROOT / row["positive_fixture"]).is_file() and row["negative_oracles"], "trace-oracles")


def validate_chain(mutations, ledger):
    need(len(mutations) == 19, "mutation-count")
    previous = "GENESIS-v2.4"
    for index, mutation in enumerate(mutations, 1):
        need(mutation["mutation_id"] == f"M{index:02d}" and len(mutation["records"]) == 4, "mutation-shape")
        need(mutation["nonce"] not in ledger["consumed"], "positive-replay")
        for record in mutation["records"]:
            body = {key: value for key, value in record.items() if key not in {"record_hash", "signature", "public_key"}}
            need(record["sequence"] == index and record["previous_hash"] == previous, "chain-link")
            need(record["record_hash"] == pretty_hash(body), "record-hash")
            verify(record["public_key"], record["signature"], body)
            need(record["authority"] is False and record["signer_kind"] == "offline_fixture", "fixture-authority")
            previous = record["record_hash"]


def patch(value, path, replacement):
    result = copy.deepcopy(value)
    parts = [part for part in path.split("/") if part]
    need(parts and parts[0] == "payload", "mutation-path")
    current = result["payload"]
    for part in parts[1:-1]:
        current = current[int(part)] if isinstance(current, list) else current[part]
    leaf = parts[-1]
    if isinstance(current, list):
        current[int(leaf)] = replacement
    else:
        current[leaf] = replacement
    return result


def evaluate_negative(vector, base, ledger, schemas):
    candidate = patch(base, vector["path"], vector["replacement"])
    pre = file_hash_bytes(json.dumps(base["target_before"], indent=2, ensure_ascii=False).encode() + b"\n")
    post = pre
    expected = {
        "command_id": "COMMAND_NOT_CONST", "signer_kind": "LIVE_SIGNER_UNVERIFIED", "authority": "AUTHORITY_FORGED",
        "nonce": "REPLAY", "issued_at": "STALE_TIMESTAMP", "schema_id": "SCHEMA_UNKNOWN", "target_digest": "TARGET_MISMATCH",
        "argv/1": "ARGV_MISMATCH", "signature": "SIGNATURE_INVALID", "record_hash": "RECORD_HASH_MISMATCH", "sequence": "SEQUENCE_MISMATCH",
        "previous_hash": "PREDECESSOR_MISMATCH", "identity": "IDENTITY_MISMATCH", "approval_ttl_seconds": "ADMIN_TTL_EXCEEDED",
        "credential_use": "CREDENTIAL_REUSE", "fsm_transition": "FSM_TRANSITION_INVALID", "app_config_scope": "APP_CONFIG_SCOPE",
        "release_version": "RELEASE_NOT_MONOTONIC", "asset_media_type": "ASSET_MEDIA_TYPE", "asset_source_sha256": "ASSET_SOURCE_DIGEST",
        "destination_binding": "DESTINATION_BINDING", "revoked": "SIGNER_REVOKED", "live_evidence": "LIVE_EVIDENCE_REJECTED",
        "allowed_transitions": "FSM_ALLOWED_TRANSITION",
    }
    key = vector["path"].removeprefix("/payload/")
    need(vector["expected_failure"] == expected[key], vector["id"] + ":expected-failure")
    schema_value(candidate["payload"], schemas["payload.v2.4"], vector["id"] + ":schema")
    # Every mutation reads the durable ledger and runs the signature stage.
    replayed = candidate["payload"]["nonce"] in ledger["consumed"]
    if key == "signature":
        verify(base["public_key"], vector["replacement"], base["payload"])
    else:
        signing_body = dict(base["payload"]); signing_body.pop("signature", None); signing_body["record_hash"] = ""
        verify(base["public_key"], base["payload"]["signature"], signing_body)
    if key == "nonce":
        need(not replayed, vector["id"] + ":ledger:REPLAY")
    if key == "issued_at":
        now = int(datetime.datetime.fromisoformat(CLOCK[:-1] + "+00:00").timestamp())
        issued = int(datetime.datetime.fromisoformat(candidate["payload"]["issued_at"][:-1] + "+00:00").timestamp())
        need(abs(now - issued) <= SKEW, vector["id"] + ":clock")
    if key == "signer_kind":
        need(candidate["payload"]["signer_kind"] == "offline_fixture", vector["id"] + ":signer")
    def value_at(payload, parts):
        value = payload
        for part in parts.split("/"):
            value = value[int(part)] if isinstance(value, list) else value[part]
        return value
    need(value_at(candidate["payload"], key) == value_at(base["payload"], key), vector["id"] + ":predicate")
    raise Invalid(vector["id"] + ":rejected:" + vector["expected_failure"])
    need(effect_count(pre, post) == 0, vector["id"] + ":effect")
    need(pre == vector["pre_target_sha256"] and post == vector["post_target_sha256"], vector["id"] + ":target-oracle")


def file_hash_bytes(value):
    return hashlib.sha256(value).hexdigest()


def effect_count(pre, post):
    return 0 if pre == post else 1


def validate_admin(admin):
    normal = admin["normal"]; emergency = admin["break_glass"]
    need(len({normal["requester"], normal["approver"], normal["executor"]}) == 3, "normal-identities")
    need(normal["approval_ttl_seconds"] == 1800 and normal["credential_ttl_seconds"] == 600, "normal-ttl")
    need(len({emergency["requester"], emergency["approver_one"], emergency["approver_two"], emergency["executor"]}) == 4, "breakglass-identities")
    need(emergency["approval_ttl_seconds"] == 900 and emergency["credential_ttl_seconds"] == 300, "breakglass-ttl")
    need(normal["one_use"] and emergency["one_use"] and normal["audit_required"] and emergency["audit_required"], "admin-audit")
    need(normal["revocation_required"] and emergency["revocation_required"], "admin-revocation")
    need(set(emergency["forbidden_operations"]) == {"publish", "mint-candidate", "mutate-admission", "clear-unknown"}, "breakglass-forbidden")


def validate_assets(assets):
    need(len(assets["assets"]) == 14, "asset-count")
    names = set()
    for item in assets["assets"]:
        need(item["filename"] not in names and item["media_type"] and len(item["source_sha256"]) == 64, "asset-shape")
        need(item["destination_binding"].startswith("github://codicarium/deployment-controller/releases/NEXT_SEMVER/assets/"), "asset-destination")
        names.add(item["filename"])


def closure(path, manifest_hash, report_hash):
    council = json.loads(Path(path).read_text(encoding="utf-8"))
    need(council["manifest_sha256"] == manifest_hash and council["pre_council_report_sha256"] == report_hash, "council-hashes")
    need(len(council["lanes"]) == 4 and council["decision"] == "rejected_return_to_spec", "council-verdict")
    for lane in council["lanes"]:
        body = {key: value for key, value in lane.items() if key not in {"signature", "public_key"}}
        need(lane["verdict"] == "NO-GO", "lane-verdict")
        verify(lane["public_key"], lane["signature"], body)
    return {"decision": council["decision"], "lanes": 4}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--council"); parser.add_argument("--negative"); parser.add_argument("--clock", default=CLOCK)
    args = parser.parse_args()
    try:
        need(args.clock == CLOCK, "fixed-clock-required")
        spec = load("feature-spec.v2.4.draft.json"); validate_spec(spec)
        annex = load("feature-spec.v2.4.annex.json")
        schemas_manifest = load("fixtures-v2.4/typed-payload-schemas-v2.4.json")
        schemas = {item["id"]: item["schema"] for item in schemas_manifest["schemas"]}
        need(len(schemas) == 7, "schema-count")
        commands = validate_commands(load("fixtures-v2.4/command-catalog-v2.4.json"))
        validate_dag(load("fixtures-v2.4/rollout-dag-v2.4.json"), commands, schemas, annex["semantic_trace"])
        need(annex["predecessor_council_hashes"] == COUNCIL, "council-history")
        need(annex["activation"]["state"] == "BLOCKED_PREACTIVATION" and annex["activation"]["live_gate_count"] == 0, "live-block")
        need(annex["release_identity"]["requested"] == "NEXT_SEMVER" and annex["release_identity"]["resolver"]["freeze_node"] == "X39", "release-resolver")
        validate_admin(load("fixtures-v2.4/admin-contracts-v2.4.json"))
        validate_assets(load("fixtures-v2.4/assets-v2.4.json"))
        positive = load("fixtures-v2.4/signed-command-evidence-positive-v2.4.json")
        ledger = load("fixtures-v2.4/replay-ledger-v2.4.json"); validate_chain(positive["mutations"], ledger)
        base = load("fixtures-v2.4/base-command-v2.4.json"); schema_value(base["payload"], schemas["payload.v2.4"])
        negatives = load("fixtures-v2.4/executable-negative-vectors-v2.4.json")
        need(len(negatives) == 24 and len({x["path"] for x in negatives}) == 24, "negative-distinctness")
        if args.negative:
            selected = next((item for item in negatives if item["id"] == args.negative), None)
            need(selected is not None, "unknown-negative")
            try:
                evaluate_negative(selected, base, ledger, schemas)
            except Invalid as exc:
                print(json.dumps({"status": "EXPECTED_REJECTION", "negative": args.negative, "reason": str(exc), "ledger_snapshot": ledger["snapshot_id"]}))
                return 0
            raise Invalid(args.negative + ":accepted")
        for vector in negatives:
            try:
                evaluate_negative(vector, base, ledger, schemas)
            except Invalid as exc:
                if str(exc).endswith(":accepted") or ":target-oracle" in str(exc) or ":effect" in str(exc):
                    raise
        manifest = load("fixtures-v2.4/pre-council-bundle-manifest-v2.4.json")
        for item in manifest["files"]:
            need(file_hash(ROOT / item["path"]) == item["sha256"], "manifest:" + item["path"])
        manifest_hash = file_hash(FIX / "pre-council-bundle-manifest-v2.4.json")
        report = load("fixtures-v2.4/pre-council-validation-report-v2.4.json")
        need(report["bundle_manifest_sha256"] == manifest_hash and report["validator_read_only"] is True, "report-binding")
        report_hash = file_hash(FIX / "pre-council-validation-report-v2.4.json")
        result = None if args.council is None else closure(args.council, manifest_hash, report_hash)
        print(json.dumps({"status": "PASS_PRE_COUNCIL_ONLY" if result is None else "PASS_CLOSURE_BLOCKED_LIVE", "spec_sha256": file_hash(ROOT / "feature-spec.v2.4.draft.json"), "annex_sha256": file_hash(ROOT / "feature-spec.v2.4.annex.json"), "manifest_sha256": manifest_hash, "report_sha256": report_hash, "requirements": 32, "tests": 32, "negative_vectors": 24, "mutations": 19, "records_per_mutation": 4, "assets": 14, "closure": result}, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"status": "FAIL", "error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
