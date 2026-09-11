#!/usr/bin/env python3
import base64
import hashlib
import io
import json
import pathlib
import subprocess
import tarfile

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from jsonschema import Draft202012Validator


RUN = pathlib.Path("/home/rickebo/.codex/pipeline/runs/2026-08-24T16-21-43-985Z")
FIXTURES = RUN / "fixtures-v1.9"
INTERNAL_ENDPOINT = "https://artifact-capability.artifact-capability.svc.cluster.local:8443"


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise AssertionError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_pairs)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def b64url_decode(value):
    assert isinstance(value, str) and "=" not in value
    return base64.urlsafe_b64decode(value + "=" * ((4 - len(value) % 4) % 4))


def b64url_encode(data):
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def jcs(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def validate_schema(schema, instance, label):
    errors = sorted(Draft202012Validator(schema).iter_errors(instance), key=lambda error: list(error.path))
    if errors:
        rendered = "; ".join(f"{list(error.path)}: {error.message}" for error in errors)
        raise AssertionError(f"{label}: {rendered}")


json_paths = [
    RUN / "feature-spec.v1.9.draft.json",
    RUN / "feature-spec.v1.9.annex.json",
    RUN / "spec-check.v1.9.draft.json",
    *sorted(FIXTURES.rglob("*.json")),
]
parsed = {path: load_json(path) for path in json_paths}

spec_path = RUN / "feature-spec.v1.9.draft.json"
annex_path = RUN / "feature-spec.v1.9.annex.json"
spec = parsed[spec_path]
annex = parsed[annex_path]

schema_names = [
    "artifact-capability-api-v1.schemas.json",
    "candidate-evidence-v1.schema.json",
    "publisher-dispatch-receipt-v1.schema.json",
    "publisher-mutation-receipt-v1.schema.json",
    "release-live-evidence-v1.schema.json",
]
schemas = {name: parsed[FIXTURES / name] for name in schema_names}
for name, schema in schemas.items():
    Draft202012Validator.check_schema(schema)

capability_fixture = parsed[FIXTURES / "artifact-capability-jws-v1.fixture.json"]
api_defs = schemas["artifact-capability-api-v1.schemas.json"]["$defs"]
validate_schema(api_defs["token_header"], capability_fixture["protected_header"], "token header")
validate_schema(api_defs["token_claims"], capability_fixture["claims"], "token claims")
validate_schema(
    schemas["candidate-evidence-v1.schema.json"],
    parsed[FIXTURES / "candidate-evidence-v1.fixture.json"],
    "candidate evidence",
)
validate_schema(
    schemas["publisher-dispatch-receipt-v1.schema.json"],
    parsed[FIXTURES / "publisher-dispatch-receipt-v1.fixture.json"],
    "dispatch receipt",
)
validate_schema(
    schemas["publisher-mutation-receipt-v1.schema.json"],
    parsed[FIXTURES / "publisher-mutation-receipt-v1.fixture.json"],
    "mutation receipt",
)
validate_schema(
    schemas["release-live-evidence-v1.schema.json"],
    parsed[FIXTURES / "release-live-evidence-v1.fixture.json"],
    "live evidence",
)

public_jwk = capability_fixture["public_jwk"]
expected_kid = b64url_encode(hashlib.sha256(jcs(public_jwk)).digest())
assert capability_fixture["kid"] == expected_kid
assert capability_fixture["protected_header"]["kid"] == expected_kid
public_key = Ed25519PublicKey.from_public_bytes(b64url_decode(public_jwk["x"]))

segments = capability_fixture["compact_jws"].split(".")
assert len(segments) == 3
header_segment, claims_segment, signature_segment = segments
assert header_segment == capability_fixture["protected_header_jcs_base64url"]
assert claims_segment == capability_fixture["claims_jcs_base64url"]
assert b64url_decode(header_segment) == jcs(capability_fixture["protected_header"])
assert b64url_decode(claims_segment) == jcs(capability_fixture["claims"])
signing_input = f"{header_segment}.{claims_segment}".encode("ascii")
assert sha256(signing_input) == capability_fixture["signing_input_sha256"]
assert signature_segment == capability_fixture["signature_base64url"]
public_key.verify(b64url_decode(signature_segment), signing_input)

claims = capability_fixture["claims"]
assert claims["iss"] == INTERNAL_ENDPOINT
assert claims["exp"] - claims["iat"] == 1800
assert claims["nbf"] == claims["iat"] - 30
assert claims["jti"] == claims["nonce"] and len(claims["jti"]) == 32

for fixture_name in [
    "publisher-dispatch-receipt-v1.fixture.json",
    "publisher-mutation-receipt-v1.fixture.json",
]:
    receipt = parsed[FIXTURES / fixture_name]
    payload = jcs(receipt["body"])
    signature = receipt["signature"]
    assert signature["format"] == "ed25519-jcs/v1"
    assert signature["kid"] == expected_kid
    assert signature["payload_sha256"] == sha256(payload)
    public_key.verify(b64url_decode(signature["signature_base64url"]), payload)

manifest = annex["files"]
assert len(manifest) == 18
assert len({entry["path"] for entry in manifest}) == 18
for entry in manifest:
    relative = pathlib.PurePosixPath(entry["path"])
    assert not relative.is_absolute() and ".." not in relative.parts
    path = RUN / relative
    data = path.read_bytes()
    assert len(data) == entry["byte_length"], entry["path"]
    assert sha256(data) == entry["sha256"], entry["path"]

annex_sha = sha256(annex_path.read_bytes())
spec_text = spec_path.read_text(encoding="utf-8")
assert annex_sha in spec_text
assert spec["meta"]["version"] == "1.9.0-exact-candidate"
assert len(spec["requirements"]) == 32
assert len(spec["acceptance_criteria"]) == 16
assert len(spec["test_plan"]) == 16
assert len(spec["traceability"]) == 32
assert all(row["acceptance_ids"] and row["test_ids"] for row in spec["traceability"])

combined_policy = json.dumps({"spec": spec, "annex": annex}, sort_keys=True)
assert "artifact-capability.int.codicarium.com" not in combined_policy
assert "Cilium" not in combined_policy
assert annex["capability_protocol"]["base_url"] == INTERNAL_ENDPOINT
runtime = annex["service_runtime"]
assert runtime["endpoint"] == INTERNAL_ENDPOINT
assert runtime["exposure_class"] == "no-ingress"
assert "ClusterIP only" in runtime["service_type"]
assert "TCP 8443" in runtime["network"]
assert "namespaceSelector" in runtime["network"] and "podSelector" in runtime["network"]
assert "one NetworkPolicy to peer containing both" in runtime["network"]
assert "Separate namespace-only or pod-only peers are forbidden" in runtime["network"]
assert "10.43.0.10/32" in runtime["network"]
assert "at least three eligible schedulable nodes" in runtime["infrastructure_prerequisite"]
assert "remaining two" in runtime["infrastructure_prerequisite"]

horizon = parsed[FIXTURES / "history-horizon-1000.json"]
assert len(horizon["requests"]) == 10
suite_ids = [item for request in horizon["requests"] for item in request["check_suite_ids"]]
run_ids = [item for request in horizon["requests"] for item in request["check_run_ids"]]
assert all(len(request["check_suite_ids"]) == 100 for request in horizon["requests"])
assert all(len(request["check_run_ids"]) == 100 for request in horizon["requests"])
assert len(set(suite_ids)) == 1000 and len(set(run_ids)) == 1000
assert horizon["expected"] == {
    "distinct_check_suite_count": "1000",
    "pagination_exhausted": True,
    "history_termination": "CHECK_SUITE_HORIZON",
    "outcome": "UNKNOWN_MANUAL",
    "mutation_count": "0",
}

tar_path = FIXTURES / "canonical-archive-v1.tar"
zstd_path = FIXTURES / "canonical-archive-v1.tar.zst"
tar_bytes = tar_path.read_bytes()
zstd_bytes = zstd_path.read_bytes()
assert len(tar_bytes) == 3072
assert sha256(tar_bytes) == "fb7a260f46a361d9b90bf6371824f0b62dcabf99be09ab984a4fb6fcaeebda31"
assert len(zstd_bytes) == 102
assert sha256(zstd_bytes) == "5858457a000d6f7334053b51ba4f1106f1ee1e683ffc6bcf461af0fe9b3dc64b"
decompressed = subprocess.run(
    ["zstd", "-q", "-d", "-c", str(zstd_path)], check=True, capture_output=True
).stdout
assert decompressed == tar_bytes
assert tar_bytes[-1024:] == b"\x00" * 1024
with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:") as archive:
    members = archive.getmembers()
    assert [member.name for member in members] == ["alpha.txt", "beta.txt"]
    for member in members:
        assert member.isfile()
        assert member.mode == 0o644
        assert member.uid == 0 and member.gid == 0 and member.mtime == 0
        assert member.uname == "" and member.gname == ""

spec_check = parsed[RUN / "spec-check.v1.9.draft.json"]
assert spec_check["ok"] is True
assert spec_check["errors"] == [] and spec_check["warnings"] == []

print(json.dumps({
    "ok": True,
    "json_documents_without_duplicate_keys": len(json_paths),
    "draft_2020_12_schemas": len(schemas),
    "validated_fixtures": 6,
    "verified_ed25519_signatures": 3,
    "manifest_files": len(manifest),
    "history_distinct_suites": len(set(suite_ids)),
    "canonical_tar_sha256": sha256(tar_bytes),
    "canonical_zstd_sha256": sha256(zstd_bytes),
    "annex_sha256": annex_sha,
    "spec_sha256": sha256(spec_path.read_bytes()),
}, indent=2))
