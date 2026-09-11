#!/usr/bin/env python3
import base64
import copy
import datetime
import gzip
import hashlib
import io
import json
import math
import pathlib
import subprocess
import tarfile

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from jsonschema import Draft202012Validator


RUN = pathlib.Path("/home/rickebo/.codex/pipeline/runs/2026-08-24T16-21-43-985Z")
FIXTURES = RUN / "fixtures-v2.0"
SPEC = RUN / "feature-spec.v2.0.draft.json"
ANNEX = RUN / "feature-spec.v2.0.annex.json"
SPEC_CHECK = RUN / "spec-check.v2.0.draft.json"
KUBE_PREFIX = (
    "kubectl --kubeconfig=/home/rickebo/.kube/codicarium-dev.yaml "
    "--context=codicarium-dev "
)
ZERO_SHA256 = "0" * 64
FIXTURE_AUTHORITY_MARKER = {
    "evidence_class": "synthetic-conformance-fixture",
    "publication_authority": False,
    "fixture_set": "issue93-v2.0",
}

EXPECTED_JSON_DOCUMENTS = 35
EXPECTED_SCHEMA_FILES = 13
EXPECTED_SCHEMA_VALIDATIONS = 14
EXPECTED_MANIFEST_FILES = 36
EXPECTED_JOURNAL_ENTRIES = 45
EXPECTED_OPERATION_EVIDENCE = 22
EXPECTED_PUBLICATION_RECEIPTS = 20
EXPECTED_MUTATION_RECEIPTS = 19
EXPECTED_ED25519_SIGNATURES = 66
EXPECTED_REQUIREMENTS = 36
EXPECTED_ACCEPTANCE = 18
EXPECTED_TESTS = 18
EXPECTED_RETIRED_WORKFLOWS = 5
EXPECTED_ASSETS = 14


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise AssertionError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def reject_non_finite_constant(value):
    raise AssertionError(f"non-finite JSON number forbidden: {value}")


def parse_finite_float(value):
    parsed = float(value)
    if not math.isfinite(parsed):
        raise AssertionError(f"non-finite JSON number forbidden: {value}")
    return parsed


def load_json(path):
    data = path.read_bytes()
    assert not data.startswith(b"\xef\xbb\xbf"), f"{path}: UTF-8 BOM forbidden"
    return json.loads(
        data.decode("utf-8"),
        object_pairs_hook=unique_pairs,
        parse_constant=reject_non_finite_constant,
        parse_float=parse_finite_float,
    )


def parse_json_text(value):
    return json.loads(
        value,
        object_pairs_hook=unique_pairs,
        parse_constant=reject_non_finite_constant,
        parse_float=parse_finite_float,
    )


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def b64url_decode(value):
    assert isinstance(value, str) and value and "=" not in value
    return base64.urlsafe_b64decode(value + "=" * ((4 - len(value) % 4) % 4))


def b64url_encode(data):
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def serialize_jcs_float(value):
    """ECMA-262 binary64 rendering required by RFC 8785 section 3.2.2.3."""
    if math.isnan(value) or math.isinf(value):
        raise AssertionError("non-finite numbers are not representable in JCS")
    if value == 0:
        return "0"
    if value < 0:
        return "-" + serialize_jcs_float(-value)

    rendered = str(value)
    exponent = ""
    exponent_value = 0
    exponent_at = rendered.find("e")
    if exponent_at > 0:
        exponent = rendered[exponent_at:]
        if exponent[2:3] == "0":
            exponent = exponent[:2] + exponent[3:]
        rendered = rendered[:exponent_at]
        exponent_value = int(exponent[1:])

    first, dot, last = rendered, "", ""
    dot_at = rendered.find(".")
    if dot_at > 0:
        first, dot, last = rendered[:dot_at], ".", rendered[dot_at + 1 :]
    if last == "0":
        dot, last = "", ""

    if 0 < exponent_value < 21:
        first += last
        dot, last, exponent = "", "", ""
        first += "0" * max(0, exponent_value - len(first) + 1)
    elif -7 < exponent_value < 0:
        last = first + last
        first, dot, exponent = "0", ".", ""
        last = ("0" * (-exponent_value - 1)) + last
    return first + dot + last + exponent


def serialize_jcs_string(value):
    rendered = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    try:
        rendered.encode("utf-8")
    except UnicodeEncodeError as error:
        raise AssertionError("JCS string contains a lone surrogate") from error
    return rendered


def canonicalize_jcs(value, seen):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        if abs(value) <= (2**53 - 1):
            return str(value)
        return serialize_jcs_float(float(value))
    if isinstance(value, float):
        return serialize_jcs_float(value)
    if isinstance(value, str):
        return serialize_jcs_string(value)
    if not isinstance(value, (list, tuple, dict)):
        raise AssertionError(f"unsupported JCS value type: {type(value).__name__}")

    identity = id(value)
    if identity in seen:
        raise AssertionError("JCS value contains a circular reference")
    seen.add(identity)
    try:
        if isinstance(value, (list, tuple)):
            return "[" + ",".join(canonicalize_jcs(item, seen) for item in value) + "]"
        if not all(isinstance(key, str) for key in value):
            raise AssertionError("JCS object keys must be strings")
        try:
            items = sorted(value.items(), key=lambda item: item[0].encode("utf-16be"))
        except UnicodeEncodeError as error:
            raise AssertionError("JCS property name contains a lone surrogate") from error
        return "{" + ",".join(
            f"{serialize_jcs_string(key)}:{canonicalize_jcs(item, seen)}"
            for key, item in items
        ) + "}"
    finally:
        seen.remove(identity)


def jcs(value):
    # Adapted from rfc8785 0.1.4 (MIT), itself based on the Apache-2.0
    # reference implementation. Fixed vectors below protect cross-language use.
    return canonicalize_jcs(value, set()).encode("utf-8")


def validate_schema(schema, instance, label):
    errors = sorted(
        Draft202012Validator(schema).iter_errors(instance),
        key=lambda error: (list(error.absolute_path), list(error.absolute_schema_path)),
    )
    if errors:
        rendered = "; ".join(
            f"{list(error.absolute_path)}: {error.message}" for error in errors
        )
        raise AssertionError(f"{label}: {rendered}")


def walk_objects(value):
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from walk_objects(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk_objects(item)


def assert_fixture_authority(value, identity_digest=None):
    assert {
        key: value[key] for key in FIXTURE_AUTHORITY_MARKER
    } == FIXTURE_AUTHORITY_MARKER
    if identity_digest is not None:
        assert value["fixture_identity_jcs_sha256"] == identity_digest


json_paths = [SPEC, ANNEX, SPEC_CHECK, *sorted(FIXTURES.rglob("*.json"))]
assert len(json_paths) == EXPECTED_JSON_DOCUMENTS
assert EXPECTED_JSON_DOCUMENTS > 0
parsed = {path: load_json(path) for path in json_paths}
assert not (FIXTURES / "release-live-implementation-identity-v1.fixture.json").exists()
assert not any(
    item.get("schema") == "codicarium.release-live-implementation-identity/v1"
    for document in parsed.values()
    for item in walk_objects(document)
)
concrete_publication_authority_objects = [
    item
    for document in parsed.values()
    for item in walk_objects(document)
    if isinstance(item.get("publication_authority"), bool)
]
assert concrete_publication_authority_objects
for item in concrete_publication_authority_objects:
    assert item["publication_authority"] is False
    assert item["evidence_class"] == "synthetic-conformance-fixture"
    assert item["fixture_set"] == "issue93-v2.0"

spec = parsed[SPEC]
annex = parsed[ANNEX]
spec_check = parsed[SPEC_CHECK]

schema_names = [
    "artifact-capability-api-v1.schemas.json",
    "candidate-evidence-v1.schema.json",
    "publisher-dispatch-receipt-v1.schema.json",
    "publisher-mutation-receipt-v1.schema.json",
    "release-live-evidence-v1.schema.json",
    "release-identity-v1.schema.json",
    "release-claim-cas-v1.schema.json",
    "release-live-implementation-identity-v1.schema.json",
    "release-journal-v1.schema.json",
    "recovery-retirement-v1.schema.json",
    "grant-migration-v1.schema.json",
    "network-conformance-v1.schema.json",
    "kube-context-binding-v1.schema.json",
]
assert len(schema_names) == EXPECTED_SCHEMA_FILES
assert EXPECTED_SCHEMA_FILES > 0
schemas = {name: parsed[FIXTURES / name] for name in schema_names}
schema_ids = []
for name, schema in schemas.items():
    Draft202012Validator.check_schema(schema)
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert schema["$id"].startswith("https://schemas.codicarium.com/")
    schema_ids.append(schema["$id"])
assert len(set(schema_ids)) == EXPECTED_SCHEMA_FILES

capability_fixture = parsed[FIXTURES / "artifact-capability-jws-v1.fixture.json"]
candidate_fixture = parsed[FIXTURES / "candidate-evidence-v1.fixture.json"]
claim_fixture = parsed[FIXTURES / "release-claim-cas-v1.fixture.json"]
journal_fixture = parsed[FIXTURES / "release-journal-v1.fixture.json"]
dispatch_receipt = parsed[FIXTURES / "publisher-dispatch-receipt-v1.fixture.json"]
mutation_fixture = parsed[FIXTURES / "publisher-mutation-receipt-v1.fixture.json"]
mutation_receipts = mutation_fixture["receipts"]
live_evidence = parsed[FIXTURES / "release-live-evidence-v1.fixture.json"]
retirement_fixture = parsed[FIXTURES / "recovery-retirement-v1.fixture.json"]
grant_fixture = parsed[FIXTURES / "grant-migration-v1.fixture.json"]
network_fixture = parsed[FIXTURES / "network-conformance-v1.fixture.json"]
kube_fixture = parsed[FIXTURES / "kube-context-binding-v1.fixture.json"]
identity_metadata = parsed[FIXTURES / "canonical-identity-fixtures-v1.json"]
jcs_conformance = parsed[FIXTURES / "jcs-rfc8785-conformance-v1.fixture.json"]
identity_vectors = parsed[
    FIXTURES / "release-identity-negative-vectors-v1.fixture.json"
]

schema_validation_count = 0
api_defs = schemas["artifact-capability-api-v1.schemas.json"]["$defs"]
validate_schema(api_defs["token_header"], capability_fixture["protected_header"], "token")
schema_validation_count += 1
validate_schema(api_defs["token_claims"], capability_fixture["claims"], "claims")
schema_validation_count += 1
for schema_name, fixture, label in [
    ("candidate-evidence-v1.schema.json", candidate_fixture, "candidate evidence"),
    ("publisher-dispatch-receipt-v1.schema.json", dispatch_receipt, "dispatch receipt"),
    ("publisher-mutation-receipt-v1.schema.json", mutation_fixture, "mutations"),
    ("release-live-evidence-v1.schema.json", live_evidence, "live evidence"),
    ("release-claim-cas-v1.schema.json", claim_fixture, "claim CAS"),
    ("release-journal-v1.schema.json", journal_fixture, "journal"),
    ("recovery-retirement-v1.schema.json", retirement_fixture, "retirement"),
    ("grant-migration-v1.schema.json", grant_fixture, "grant migration"),
    ("network-conformance-v1.schema.json", network_fixture, "network"),
    ("kube-context-binding-v1.schema.json", kube_fixture, "kube binding"),
]:
    validate_schema(schemas[schema_name], fixture, label)
    schema_validation_count += 1

handoff_path = FIXTURES / "release-handoff-v1.json"
dispatch_path = FIXTURES / "publisher-dispatch-v1.json"
handoff_raw = handoff_path.read_bytes()
publisher_dispatch_raw = dispatch_path.read_bytes()
handoff = parsed[handoff_path]
publisher_dispatch = parsed[dispatch_path]
identity_schema = schemas["release-identity-v1.schema.json"]
validate_schema(identity_schema["oneOf"][0], handoff, "raw handoff")
schema_validation_count += 1
validate_schema(identity_schema["oneOf"][1], publisher_dispatch, "raw dispatch")
schema_validation_count += 1
assert schema_validation_count == EXPECTED_SCHEMA_VALIDATIONS


def validate_kube_context_binding(instance):
    assert instance["schema"] == "codicarium.kube-context-binding/v1"
    assert instance["kubeconfig"] == (
        "/home/rickebo/.kube/codicarium-dev.yaml"
    )
    assert instance["context"] == "codicarium-dev"
    assert instance["api_server"] == "https://10.99.0.21:6443"
    assert instance["ca_pem_sha256"] == (
        "c73f41a70db74a9e1020ce84bf27227e0523055d3156d8d47ef31d41a3e3b935"
    )
    assert instance["kube_system_uid"] == (
        "03dea961-55e6-4141-bb23-6cb4b9f79681"
    )
    assert instance["kubernetes_service"] == {
        "namespace": "default",
        "service": "kubernetes",
        "cluster_ip": "10.43.0.1",
        "port": 443,
        "accepted_audience": "https://kubernetes.default.svc",
        "accepted_audience_status": (
            "REQUIRED_PREACTIVATION_TOKENREVIEW_PROBE"
        ),
        "ca_pem_sha256": instance["ca_pem_sha256"],
        "certificate_dns_san": "kubernetes.default.svc",
        "tls_san_status": "REQUIRED_PREACTIVATION_TLS_PROBE",
        "discovery_command": (
            KUBE_PREFIX + "--namespace=default get service kubernetes"
        ),
    }
    assert instance["dns"] == {
        "namespace": "kube-system",
        "service": "kube-dns",
        "cluster_ip": "10.43.0.10",
        "port": 53,
        "protocols": ["UDP", "TCP"],
    }
    assert instance["monitoring"] == {
        "namespace": "monitoring",
        "namespace_uid": "f78cd9cb-d069-4bde-bc56-33686eef5968",
        "namespace_labels": ["kubernetes.io/metadata.name=monitoring"],
        "prometheus_pod_labels": [
            "app.kubernetes.io/instance=prometheus-stack-prometheus",
            "app.kubernetes.io/name=prometheus",
            "operator.prometheus.io/name=prometheus-stack-prometheus",
            "operator.prometheus.io/shard=0",
            "prometheus=prometheus-stack-prometheus",
        ],
    }
    expected_commands = [
        KUBE_PREFIX + "config view --minify -o json",
        KUBE_PREFIX + "get --raw=/version",
        KUBE_PREFIX + "get namespace kube-system -o json",
        KUBE_PREFIX + "get namespace monitoring -o json",
    ]
    assert instance["commands"] == expected_commands
    assert len(instance["commands"]) == len(set(instance["commands"])) == 4
    assert all(command.startswith(KUBE_PREFIX) for command in instance["commands"])
    assert instance["mutation_guard"] == (
        "Every cluster command includes the exact --kubeconfig and --context "
        "flags; server, CA PEM SHA-256, context, or kube-system UID mismatch "
        "exits before every mutation."
    )


validate_kube_context_binding(kube_fixture)


def assert_kube_context_rejected(mutator, label):
    altered = copy.deepcopy(kube_fixture)
    mutator(altered)
    try:
        validate_kube_context_binding(altered)
    except (AssertionError, KeyError, TypeError, ValueError):
        return
    raise AssertionError(f"{label}: invalid kube context accepted")


for mutator, label in [
    (lambda item: item.update({"api_server": "https://10.99.0.22:6443"}), "API server"),
    (lambda item: item.update({"ca_pem_sha256": sha256(b"wrong-cluster-ca")}), "cluster CA"),
    (lambda item: item.update({"kube_system_uid": "00000000-0000-4000-8000-000000000000"}), "kube-system UID"),
    (lambda item: item["kubernetes_service"].update({"cluster_ip": "10.43.0.2"}), "Kubernetes Service IP"),
    (lambda item: item["kubernetes_service"].update({"port": 6443}), "Kubernetes Service port"),
    (lambda item: item["kubernetes_service"].update({"accepted_audience": "kubernetes.default.svc"}), "Kubernetes Service audience"),
    (lambda item: item["kubernetes_service"].update({"ca_pem_sha256": sha256(b"wrong-service-ca")}), "Kubernetes Service CA"),
    (lambda item: item["kubernetes_service"].update({"certificate_dns_san": "wrong.default.svc"}), "Kubernetes Service SAN"),
    (lambda item: item["kubernetes_service"].update({"discovery_command": "kubectl get service kubernetes"}), "Kubernetes Service explicit context"),
    (lambda item: item["dns"].update({"cluster_ip": "10.43.0.11"}), "cluster DNS"),
    (lambda item: item["monitoring"]["namespace_labels"].clear(), "monitoring namespace label"),
    (lambda item: item["monitoring"]["prometheus_pod_labels"].pop(), "monitoring Pod label"),
    (lambda item: item["commands"].__setitem__(0, item["commands"][0].replace("--kubeconfig=/home/rickebo/.kube/codicarium-dev.yaml ", "")), "missing kubeconfig flag"),
    (lambda item: item["commands"].__setitem__(1, item["commands"][1].replace("--context=codicarium-dev ", "")), "missing context flag"),
]:
    assert_kube_context_rejected(mutator, label)
assert EXPECTED_SCHEMA_VALIDATIONS > 0

# Both language implementations must match fixed RFC 8785 numeric and Unicode
# byte vectors. Invalid Unicode scalar input must be rejected before hashing.
assert jcs_conformance["schema"] == "codicarium.rfc8785-conformance/v1"
for vector in jcs_conformance["positive_vectors"]:
    value = parse_json_text(vector["input_json"])
    assert jcs(value).decode("utf-8") == vector["expected_jcs"], vector["name"]
for vector in jcs_conformance["negative_vectors"]:
    try:
        if "input_json" in vector:
            jcs(parse_json_text(vector["input_json"]))
        else:
            invalid = "".join(
                chr(int(unit, 16)) for unit in vector["utf16_code_units"]
            )
            jcs({invalid: True} if vector["position"] == "key" else invalid)
    except (AssertionError, UnicodeEncodeError, json.JSONDecodeError):
        pass
    else:
        raise AssertionError(f"{vector['name']}: invalid Unicode accepted by JCS")
try:
    parse_json_text(r'{"a":1,"\u0061":2}')
except AssertionError as error:
    assert "duplicate JSON key" in str(error)
else:
    raise AssertionError("escaped duplicate JSON key accepted")

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
verified_signatures = 1

claims = capability_fixture["claims"]
assert (
    claims["iss"]
    == "https://artifact-capability.artifact-capability.svc.cluster.local:8443"
)
assert claims["exp"] - claims["iat"] == 1800
assert claims["nbf"] == claims["iat"] - 30
assert claims["jti"] == claims["nonce"] and len(claims["jti"]) == 32


def verify_envelope(envelope):
    global verified_signatures
    payload = jcs(envelope["body"])
    signature = envelope["signature"]
    assert signature == {
        "format": "vault-transit-ed25519-jcs/v1",
        "transit_key": "release-journal-v1",
        "transit_key_version": "1",
        "kid": expected_kid,
        "payload_sha256": sha256(payload),
        "signature_base64url": signature["signature_base64url"],
    }
    public_key.verify(b64url_decode(signature["signature_base64url"]), payload)
    verified_signatures += 1
    return sha256(jcs(envelope))


# The two raw identity bodies are byte oracles, not pretty-printed JSON.
assert identity_metadata["authority"] is False
assert identity_metadata["purpose"] == "byte-regression-only"
assert len(handoff_raw) == 697
assert sha256(handoff_raw) == (
    "8abe528bb32aaa47f8fc496c3571d4b91248f3ebfe4c8be29463a25277bd9e88"
)
assert len(publisher_dispatch_raw) == 436
assert sha256(publisher_dispatch_raw) == (
    "b150fa8dad70a207fb7a78f6a41ab1bc1430833ba70b86fdc2f08a13c7c11f3b"
)
assert handoff_raw == jcs(handoff)
assert publisher_dispatch_raw == jcs(publisher_dispatch)
assert handoff["coordinator_check_run_id"] == "9002003"
assert publisher_dispatch["handoff_check_run_id"] == "9004003"
assert identity_metadata["handoff"]["coordinator_check_run_id"] == "9002003"
assert identity_metadata["dispatch"]["handoff_check_run_id"] == "9004003"
for identity, data, metadata, raw in [
    ("handoff", handoff, identity_metadata["handoff"], handoff_raw),
    (
        "dispatch",
        publisher_dispatch,
        identity_metadata["dispatch"],
        publisher_dispatch_raw,
    ),
]:
    assert metadata["json_byte_length"] == len(raw), identity
    assert metadata["json_sha256"] == sha256(raw), identity
    assert metadata["digest_base64url"] == b64url_encode(hashlib.sha256(raw).digest())
    assert metadata["tuple_base64url"] == b64url_encode(
        metadata["tuple"].encode("utf-8")
    )

assert identity_vectors["positive_fixture_count"] == 2
assert identity_vectors["negative_fixture_count"] == 6
assert len(identity_vectors["vectors"]) == 6
expected_identity_hash = {
    "handoff": sha256(handoff_raw),
    "dispatch": sha256(publisher_dispatch_raw),
}
for vector in identity_vectors["vectors"]:
    if vector["failure"] == "DUPLICATE_KEY":
        try:
            parse_json_text(vector["raw"])
        except AssertionError as error:
            assert "duplicate JSON key" in str(error)
        else:
            raise AssertionError(f"{vector['name']}: duplicate key accepted")
    elif vector["failure"] == "UNKNOWN_KEY":
        instance = parse_json_text(vector["raw"])
        branch = 0 if vector["identity"] == "handoff" else 1
        errors = list(Draft202012Validator(identity_schema["oneOf"][branch]).iter_errors(instance))
        assert errors, f"{vector['name']}: unknown key accepted"
    elif vector["failure"] == "DIGEST_MISMATCH":
        instance = parse_json_text(vector["raw"])
        branch = 0 if vector["identity"] == "handoff" else 1
        validate_schema(identity_schema["oneOf"][branch], instance, vector["name"])
        assert sha256(vector["raw"].encode("utf-8")) != expected_identity_hash[
            vector["identity"]
        ]
    else:
        raise AssertionError(f"unknown negative vector: {vector['failure']}")

# Claim key is the exact RFC 8785-compatible JCS digest of the closed identity.
claim_identity_digest = sha256(jcs(claim_fixture["identity"]))
assert_fixture_authority(claim_fixture, claim_identity_digest)
assert_fixture_authority(claim_fixture["identity"])
assert claim_fixture["identity_jcs_sha256"] == claim_identity_digest
assert claim_fixture["claim_key"] == f"rel-v2-sha256:{claim_identity_digest}"
assert claim_fixture["authority"] == {
    "storage": "dedicated-dev-postgresql",
    "transaction_isolation": "SERIALIZABLE",
    "synchronous_commit": "on",
    "first_durable_release_side_effect": True,
}
assert claim_fixture["api"] == {
    "procedure": "release_journal.claim_cas_v1",
    "create_status": 201,
    "exact_replay_status": 200,
    "conflict_status": 409,
    "ambiguity_outcome": "UNKNOWN_MANUAL",
    "automatic_retry": False,
}
assert len(claim_fixture["vectors"]) == 4
assert [item["http_status"] for item in claim_fixture["vectors"]] == [
    201,
    200,
    409,
    None,
]
assert all(item["automatic_retry"] is False for item in claim_fixture["vectors"])
claim_schema = schemas["release-claim-cas-v1.schema.json"]
for field, wrong_value in [
    ("publication_authority", True),
    ("evidence_class", "live-protected-authority"),
    ("fixture_set", "not-issue93"),
    ("fixture_identity_jcs_sha256", sha256(b"wrong-fixture-identity")),
]:
    altered = copy.deepcopy(claim_fixture)
    altered[field] = wrong_value
    assert list(Draft202012Validator(claim_schema).iter_errors(altered)), field

# Claim workflow identities are exact and tied to deterministic reviewed
# workflow fixture bytes; changing a path, ref, or SHA must fail the schema.
workflow_contract = parsed[FIXTURES / "workflow-permissions-v1.json"]
coordinator_path = ".github/workflows/automatic-release-v2.yaml"
verifier_path = ".github/workflows/release-verify-v2.yaml"
publisher_path = ".github/workflows/publish-release-v2.yaml"
reviewed_workflow_object = {
    "schema": "codicarium.issue93-reviewed-workflow-fixture/v1",
    "repository": "codicarium/deployment-controller",
    "workflows": {
        coordinator_path: workflow_contract["workflows"][coordinator_path],
        verifier_path: workflow_contract["workflows"][verifier_path],
        publisher_path: workflow_contract["workflows"][publisher_path],
    },
}
reviewed_workflow_revision = sha256(jcs(reviewed_workflow_object))[:40]
candidate_archive_derivations = {}
for purpose, archive in candidate_fixture["archives"].items():
    for file in archive["files"]:
        body = (
            f"codicarium.issue93/v2 fixture body\n{purpose}\n{file['path']}\n"
        ).encode("utf-8")
        assert file["size"] == str(len(body))
        assert file["sha256"] == sha256(body)
    archive_object = {
        "schema": "codicarium.candidate-archive-object/v1",
        "purpose": purpose,
        "files": archive["files"],
    }
    archive_bytes = jcs(archive_object)
    assert archive["byte_length"] == str(len(archive_bytes))
    assert archive["archive_sha256"] == sha256(archive_bytes)
    candidate_archive_derivations[purpose] = {
        "canonical_object_jcs_sha256": archive["archive_sha256"],
        "canonical_object_byte_length": archive["byte_length"],
    }
candidate_source_revision = sha256(jcs({
    "schema": "codicarium.candidate-source-revision-fixture/v1",
    "repository": "codicarium/deployment-controller",
    "tag": "v0.6.14",
    "archives": candidate_archive_derivations,
}))[:40]
assert candidate_fixture["source_revision"] == candidate_source_revision
assert claims["source_revision"] == candidate_source_revision
assert claim_fixture["identity"]["source_revision"] == candidate_source_revision
assert claim_fixture["identity"]["protected_main_revision"] == reviewed_workflow_revision
assert claim_fixture["identity"]["coordinator_workflow"] == {
    "repository_id": "1303901324",
    "workflow_path": coordinator_path,
    "ref": "refs/heads/main",
    "workflow_sha": reviewed_workflow_revision,
}
assert claim_fixture["identity"]["publisher_workflow"] == {
    "repository_id": "1303901324",
    "workflow_path": publisher_path,
    "ref": "refs/heads/main",
    "workflow_sha": reviewed_workflow_revision,
}

# Live authority is a separately discovered post-merge identity. No positive
# instance is persisted; this in-memory oracle exercises the closed schema and
# the required cross-field/freshness checks without conferring authority.
live_identity_schema = schemas[
    "release-live-implementation-identity-v1.schema.json"
]
live_merge_sha = sha256(b"live-corrective-merge")[:40]
live_candidate_sha = sha256(b"live-candidate-source")[:40]
live_coordinator_blob_sha = sha256(b"live-coordinator-workflow-blob")[:40]
live_publisher_blob_sha = sha256(b"live-publisher-workflow-blob")[:40]
live_signing_kid = b64url_encode(hashlib.sha256(b"live-vault-transit-key").digest())
assert live_signing_kid != expected_kid
live_evaluation_time = datetime.datetime(
    2026, 8, 25, 12, 0, 0, tzinfo=datetime.timezone.utc
)
live_identity = {
    "schema": "codicarium.release-live-implementation-identity/v1",
    "evidence_class": "live-protected-authority",
    "publication_authority": True,
    "repository": {
        "id": "1303901324",
        "full_name": "codicarium/deployment-controller",
    },
    "tag": "v0.6.14",
    "protected_corrective_merge_sha": live_merge_sha,
    "candidate_source_sha": live_candidate_sha,
    "coordinator_workflow": {
        "repository_id": "1303901324",
        "workflow_path": coordinator_path,
        "ref": "refs/heads/main",
        "workflow_sha": live_merge_sha,
    },
    "publisher_workflow": {
        "repository_id": "1303901324",
        "workflow_path": publisher_path,
        "ref": "refs/heads/main",
        "workflow_sha": live_merge_sha,
    },
    "discovery_proof": {
        "captured_after_protected_merge": True,
        "repository_id": "1303901324",
        "base_ref": "refs/heads/main",
        "corrective_pr_merged": True,
        "merge_commit_sha": live_merge_sha,
        "protected_main_sha": live_merge_sha,
        "candidate_run_head_sha": live_candidate_sha,
        "candidate_checks_head_sha": live_candidate_sha,
        "ancestry": "ahead",
        "behind_by": 0,
        "tag_target_sha": live_candidate_sha,
        "compare": {
            "api_version": "2026-03-10",
            "endpoint": (
                "https://api.github.com/repos/codicarium/deployment-controller/compare/"
                + live_merge_sha
                + "..."
                + live_candidate_sha
            ),
            "http_status": 200,
            "base_sha": live_merge_sha,
            "head_sha": live_candidate_sha,
            "status": "ahead",
            "ahead_by": 1,
            "behind_by": 0,
            "merge_base_sha": live_merge_sha,
        },
        "workflow_file_proofs": {
            "coordinator": {
                "workflow_path": coordinator_path,
                "protected_revision": live_merge_sha,
                "candidate_revision": live_candidate_sha,
                "protected_blob_sha": live_coordinator_blob_sha,
                "candidate_blob_sha": live_coordinator_blob_sha,
                "identical": True,
            },
            "publisher": {
                "workflow_path": publisher_path,
                "protected_revision": live_merge_sha,
                "candidate_revision": live_candidate_sha,
                "protected_blob_sha": live_publisher_blob_sha,
                "candidate_blob_sha": live_publisher_blob_sha,
                "identical": True,
            },
        },
        "observed_at": "2026-08-25T11:59:30Z",
        "max_age_seconds": 300,
    },
    "signing_key": {
        "kind": "vault-transit",
        "kid": live_signing_kid,
        "fixture_key_forbidden": True,
    },
}


def validate_live_identity(instance, evaluation_time):
    validate_schema(live_identity_schema, instance, "live implementation identity")
    assert instance["evidence_class"] == "live-protected-authority"
    assert instance["publication_authority"] is True
    assert instance["candidate_source_sha"] not in {
        candidate_source_revision,
        reviewed_workflow_revision,
    }
    proof = instance["discovery_proof"]
    assert instance["protected_corrective_merge_sha"] == proof["merge_commit_sha"]
    assert instance["protected_corrective_merge_sha"] == proof["protected_main_sha"]
    assert instance["candidate_source_sha"] == proof["candidate_run_head_sha"]
    assert instance["candidate_source_sha"] == proof["candidate_checks_head_sha"]
    assert instance["candidate_source_sha"] == proof["tag_target_sha"]
    assert proof["behind_by"] == 0
    compare = proof["compare"]
    assert compare["endpoint"] == (
        "https://api.github.com/repos/codicarium/deployment-controller/compare/"
        + instance["protected_corrective_merge_sha"]
        + "..."
        + instance["candidate_source_sha"]
    )
    assert compare["base_sha"] == instance["protected_corrective_merge_sha"]
    assert compare["head_sha"] == instance["candidate_source_sha"]
    assert compare["status"] == proof["ancestry"]
    assert compare["behind_by"] == proof["behind_by"] == 0
    assert compare["merge_base_sha"] == instance[
        "protected_corrective_merge_sha"
    ]
    if proof["ancestry"] == "identical":
        assert instance["candidate_source_sha"] == instance[
            "protected_corrective_merge_sha"
        ]
        assert compare["ahead_by"] == 0
    else:
        assert proof["ancestry"] == "ahead"
        assert compare["ahead_by"] > 0
    for workflow, path in [
        (instance["coordinator_workflow"], coordinator_path),
        (instance["publisher_workflow"], publisher_path),
    ]:
        assert workflow["repository_id"] == instance["repository"]["id"]
        assert workflow["workflow_path"] == path
        assert workflow["ref"] == "refs/heads/main"
        assert workflow["workflow_sha"] == instance[
            "protected_corrective_merge_sha"
        ]
        assert workflow["workflow_sha"] != reviewed_workflow_revision
    for role, workflow, path in [
        ("coordinator", instance["coordinator_workflow"], coordinator_path),
        ("publisher", instance["publisher_workflow"], publisher_path),
    ]:
        file_proof = proof["workflow_file_proofs"][role]
        assert file_proof["workflow_path"] == path
        assert file_proof["protected_revision"] == workflow["workflow_sha"]
        assert file_proof["candidate_revision"] == instance["candidate_source_sha"]
        assert file_proof["protected_blob_sha"] == file_proof[
            "candidate_blob_sha"
        ]
        assert file_proof["identical"] is True
    observed_at = datetime.datetime.fromisoformat(
        proof["observed_at"].replace("Z", "+00:00")
    )
    age_seconds = (evaluation_time - observed_at).total_seconds()
    assert 0 <= age_seconds <= proof["max_age_seconds"]
    assert instance["signing_key"]["kid"] != expected_kid
    return sha256(jcs(instance))


live_identity_digest = validate_live_identity(live_identity, live_evaluation_time)
assert live_identity_digest != claim_identity_digest
live_claim_binding = {
    "schema": "codicarium.release-live-claim-binding/v1",
    "evidence_class": "live-protected-authority",
    "publication_authority": True,
    "repository_id": "1303901324",
    "live_identity_jcs_sha256": live_identity_digest,
    "claim_key": f"rel-v2-sha256:{live_identity_digest}",
    "signing_kid": live_signing_kid,
    "journal_side_effects_allowed": True,
}
validate_schema(
    live_identity_schema["$defs"]["claim_binding"],
    live_claim_binding,
    "live claim binding",
)
assert live_claim_binding["claim_key"] == (
    "rel-v2-sha256:" + live_identity_digest
)
assert live_claim_binding["signing_kid"] == live_identity["signing_key"]["kid"]

live_receipt_binding = {
    "schema": "codicarium.release-live-receipt-binding/v1",
    "evidence_class": "live-protected-authority",
    "publication_authority": True,
    "repository_id": "1303901324",
    "kind": "publisher-dispatch",
    "sequence": "0",
    "previous_receipt_sha256": ZERO_SHA256,
    "live_identity_jcs_sha256": live_identity_digest,
    "claim_key": live_claim_binding["claim_key"],
    "protected_corrective_merge_sha": live_merge_sha,
    "candidate_source_sha": live_candidate_sha,
    "coordinator_workflow_sha": live_merge_sha,
    "publisher_workflow_sha": live_merge_sha,
    "signing_kid": live_signing_kid,
}


def validate_live_claim_binding(identity, binding, evaluation_time):
    identity_digest = validate_live_identity(identity, evaluation_time)
    validate_schema(
        live_identity_schema["$defs"]["claim_binding"],
        binding,
        "live claim binding",
    )
    assert binding["repository_id"] == identity["repository"]["id"]
    assert binding["live_identity_jcs_sha256"] == identity_digest
    assert binding["claim_key"] == f"rel-v2-sha256:{identity_digest}"
    assert binding["signing_kid"] == identity["signing_key"]["kid"]
    assert binding["journal_side_effects_allowed"] is True
    return identity_digest


def validate_live_receipt_binding(
    identity,
    claim_binding,
    binding,
    evaluation_time,
    expected_previous_receipt_sha256,
):
    identity_digest = validate_live_claim_binding(
        identity, claim_binding, evaluation_time
    )
    validate_schema(
        live_identity_schema["$defs"]["receipt_binding"],
        binding,
        "live receipt binding",
    )
    assert binding["repository_id"] == identity["repository"]["id"]
    assert binding["live_identity_jcs_sha256"] == identity_digest
    assert binding["claim_key"] == claim_binding["claim_key"]
    assert binding["protected_corrective_merge_sha"] == identity[
        "protected_corrective_merge_sha"
    ]
    assert binding["candidate_source_sha"] == identity["candidate_source_sha"]
    assert binding["coordinator_workflow_sha"] == identity[
        "coordinator_workflow"
    ]["workflow_sha"]
    assert binding["publisher_workflow_sha"] == identity["publisher_workflow"][
        "workflow_sha"
    ]
    assert binding["signing_kid"] == identity["signing_key"]["kid"]
    assert binding["previous_receipt_sha256"] == (
        expected_previous_receipt_sha256
    )
    if binding["kind"] == "publisher-dispatch":
        assert binding["sequence"] == "0"
        assert binding["previous_receipt_sha256"] == ZERO_SHA256
    else:
        assert binding["kind"] == "publisher-mutation"
        assert 1 <= int(binding["sequence"]) <= 19
        assert binding["previous_receipt_sha256"] != ZERO_SHA256
    return sha256(jcs(binding))


live_mutation_bindings = []
live_previous_receipt_sha256 = sha256(jcs(live_receipt_binding))
for live_mutation_sequence in range(1, 20):
    live_mutation_binding = copy.deepcopy(live_receipt_binding)
    live_mutation_binding.update(
        {
            "kind": "publisher-mutation",
            "sequence": str(live_mutation_sequence),
            "previous_receipt_sha256": live_previous_receipt_sha256,
        }
    )
    live_mutation_bindings.append(live_mutation_binding)
    live_previous_receipt_sha256 = sha256(jcs(live_mutation_binding))
live_receipt_chain = [live_receipt_binding, *live_mutation_bindings]


def zero_live_side_effect_counters():
    return {
        "claim_creates": 0,
        "dispatches": 0,
        "journal_commits": 0,
        "publication_mutations": 0,
    }


def attempt_live_authorization(
    identity, claim_binding, receipt_bindings, evaluation_time, counters
):
    """Validate the complete chain before permitting any durable side effect."""
    before = copy.deepcopy(counters)
    validate_live_claim_binding(identity, claim_binding, evaluation_time)
    assert len(receipt_bindings) == 20
    expected_previous = ZERO_SHA256
    dispatch_count = 0
    mutation_count = 0
    for index, receipt_binding in enumerate(receipt_bindings):
        if index == 0:
            assert receipt_binding["kind"] == "publisher-dispatch"
        else:
            assert receipt_binding["kind"] == "publisher-mutation"
            assert int(receipt_binding["sequence"]) == index
        expected_previous = validate_live_receipt_binding(
            identity,
            claim_binding,
            receipt_binding,
            evaluation_time,
            expected_previous,
        )
        dispatch_count += receipt_binding["kind"] == "publisher-dispatch"
        mutation_count += receipt_binding["kind"] == "publisher-mutation"
    assert dispatch_count == 1
    assert mutation_count == len(receipt_bindings) - 1
    assert counters == before
    counters["claim_creates"] += 1
    counters["dispatches"] += dispatch_count
    counters["journal_commits"] += len(receipt_bindings)
    counters["publication_mutations"] += mutation_count
    return expected_previous


live_positive_counters = zero_live_side_effect_counters()
live_chain_tip = attempt_live_authorization(
    live_identity,
    live_claim_binding,
    live_receipt_chain,
    live_evaluation_time,
    live_positive_counters,
)
assert live_chain_tip == sha256(jcs(live_mutation_bindings[-1]))
assert live_positive_counters == {
    "claim_creates": 1,
    "dispatches": 1,
    "journal_commits": 20,
    "publication_mutations": 19,
}


def assert_live_authorization_rejected(
    identity, claim_binding, receipt_bindings, label
):
    counters = zero_live_side_effect_counters()
    try:
        attempt_live_authorization(
            identity,
            claim_binding,
            receipt_bindings,
            live_evaluation_time,
            counters,
        )
    except (AssertionError, KeyError, TypeError, ValueError):
        assert counters == zero_live_side_effect_counters(), label
        return
    raise AssertionError(f"{label}: invalid live authorization accepted")


def assert_live_identity_rejected(mutator, label):
    altered = copy.deepcopy(live_identity)
    mutator(altered)
    assert_live_authorization_rejected(
        altered,
        live_claim_binding,
        live_receipt_chain,
        label,
    )


for mutator, label in [
    (lambda item: item.update({"candidate_source_sha": candidate_source_revision}), "synthetic source"),
    (lambda item: item.update({"candidate_source_sha": "1" * 40}), "legacy synthetic source"),
    (lambda item: item["coordinator_workflow"].update({"workflow_sha": reviewed_workflow_revision}), "synthetic workflow"),
    (lambda item: item["coordinator_workflow"].update({"workflow_sha": "2" * 40}), "legacy synthetic workflow"),
    (lambda item: item["repository"].update({"id": "1"}), "repository id"),
    (lambda item: item["discovery_proof"].update({"ancestry": "behind"}), "ancestry"),
    (lambda item: item["publisher_workflow"].update({"workflow_path": ".github/workflows/evil.yaml"}), "workflow path"),
    (lambda item: item["publisher_workflow"].update({"ref": "refs/heads/evil"}), "workflow ref"),
    (lambda item: item.update({"tag": "v0.6.13"}), "tag"),
    (lambda item: item["discovery_proof"].update({"protected_main_sha": sha256(b"other-main")[:40]}), "mixed protected identity"),
    (lambda item: item["discovery_proof"].update({"candidate_checks_head_sha": sha256(b"other-check-head")[:40]}), "mixed candidate identity"),
    (lambda item: item["discovery_proof"]["compare"].update({"base_sha": sha256(b"other-compare-base")[:40]}), "compare base"),
    (lambda item: item["discovery_proof"]["compare"].update({"ahead_by": 0}), "compare ahead count"),
    (lambda item: item["discovery_proof"]["workflow_file_proofs"]["publisher"].update({"candidate_blob_sha": sha256(b"changed-workflow-blob")[:40]}), "candidate workflow drift"),
    (lambda item: item["discovery_proof"].update({"observed_at": "2026-08-25T11:00:00Z"}), "stale discovery"),
    (lambda item: item.pop("discovery_proof"), "missing discovery"),
    (lambda item: item["signing_key"].update({"kid": expected_kid}), "fixture signing key"),
]:
    assert_live_identity_rejected(mutator, label)

for repeated_character in "0123456789abcdef":
    assert_live_identity_rejected(
        lambda item, value=repeated_character * 40: item.update(
            {"candidate_source_sha": value}
        ),
        f"repeated live SHA {repeated_character}",
    )

for field, wrong_value in [
    ("live_identity_jcs_sha256", claim_identity_digest),
    ("claim_key", "rel-v2-sha256:" + sha256(b"wrong-live-claim-key")),
    ("signing_kid", expected_kid),
    ("repository_id", "1"),
]:
    altered_claim = copy.deepcopy(live_claim_binding)
    altered_claim[field] = wrong_value
    assert_live_authorization_rejected(
        live_identity,
        altered_claim,
        live_receipt_chain,
        f"live claim {field}",
    )

for field, wrong_value in [
    ("live_identity_jcs_sha256", sha256(b"mixed-live-identity")),
    ("claim_key", "rel-v2-sha256:" + sha256(b"wrong-receipt-claim")),
    ("candidate_source_sha", candidate_source_revision),
    ("protected_corrective_merge_sha", sha256(b"wrong-live-merge")[:40]),
    ("coordinator_workflow_sha", sha256(b"wrong-live-coordinator")[:40]),
    ("publisher_workflow_sha", sha256(b"wrong-live-publisher")[:40]),
    ("signing_kid", expected_kid),
    ("repository_id", "1"),
]:
    altered_receipt = copy.deepcopy(live_receipt_binding)
    altered_receipt[field] = wrong_value
    assert_live_authorization_rejected(
        live_identity,
        live_claim_binding,
        [altered_receipt, *live_mutation_bindings],
        f"live receipt {field}",
    )

for binding, field, wrong_value, label in [
    (live_receipt_binding, "sequence", "1", "dispatch sequence one"),
    (
        live_receipt_binding,
        "previous_receipt_sha256",
        sha256(b"non-genesis-dispatch"),
        "dispatch non-genesis previous receipt",
    ),
    (live_mutation_bindings[0], "sequence", "0", "mutation sequence zero"),
    (
        live_mutation_bindings[0],
        "previous_receipt_sha256",
        sha256(b"broken-live-receipt-chain"),
        "broken receipt chain",
    ),
]:
    altered_binding = copy.deepcopy(binding)
    altered_binding[field] = wrong_value
    chain = (
        [altered_binding, *live_mutation_bindings]
        if binding is live_receipt_binding
        else [live_receipt_binding, altered_binding, *live_mutation_bindings[1:]]
    )
    assert_live_authorization_rejected(
        live_identity, live_claim_binding, chain, label
    )

for invalid_chain, label in [
    ([], "empty live receipt plan"),
    (live_receipt_chain[:-1], "nineteen-receipt incomplete plan"),
    (
        [*live_receipt_chain, copy.deepcopy(live_mutation_bindings[-1])],
        "twenty-one-receipt oversized plan",
    ),
    (
        [
            *live_receipt_chain[:6],
            copy.deepcopy(live_receipt_chain[5]),
            *live_receipt_chain[7:],
        ],
        "duplicate mutation sequence",
    ),
    (
        [
            *live_receipt_chain[:5],
            live_receipt_chain[6],
            live_receipt_chain[5],
            *live_receipt_chain[7:],
        ],
        "reordered mutation sequence",
    ),
]:
    assert_live_authorization_rejected(
        live_identity, live_claim_binding, invalid_chain, label
    )

for role, changed_path in [
    ("coordinator_workflow", ".github/workflows/evil.yaml"),
    ("publisher_workflow", ".github/workflows/evil.yaml"),
]:
    altered = copy.deepcopy(claim_fixture)
    altered["identity"][role]["workflow_path"] = changed_path
    assert list(Draft202012Validator(claim_schema).iter_errors(altered)), role
for role in ("coordinator_workflow", "publisher_workflow"):
    altered = copy.deepcopy(claim_fixture)
    altered["identity"][role]["workflow_sha"] = sha256(role.encode("utf-8"))[:40]
    assert list(Draft202012Validator(claim_schema).iter_errors(altered)), role


def assert_not_repeated_hash(value, label):
    normalized = value.removeprefix("sha256:")
    if len(normalized) in (40, 64) and all(char in "0123456789abcdef" for char in normalized):
        assert len(set(normalized)) != 1, f"{label}: repeated-character hash"


# The detector rejects every possible repeated hexadecimal placeholder, not
# only the four values observed in review. Genesis zero is checked separately.
for repeated_char in "0123456789abcdef":
    for length in (40, 64):
        try:
            assert_not_repeated_hash(repeated_char * length, "negative-vector")
        except AssertionError as error:
            assert "repeated-character hash" in str(error)
        else:
            raise AssertionError(f"repeated {repeated_char} x {length} accepted")


def walk_repeated_hashes(value, path=()):
    if isinstance(value, dict):
        for key, item in value.items():
            yield from walk_repeated_hashes(item, (*path, key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from walk_repeated_hashes(item, (*path, index))
    elif isinstance(value, str):
        normalized = value.removeprefix("sha256:")
        if (
            len(normalized) in (40, 64)
            and all(char in "0123456789abcdef" for char in normalized)
            and len(set(normalized)) == 1
        ):
            yield path, normalized


# Scan every parsed document. Repeated values are legal only at exact frozen
# byte-oracle fields or at one of the five structural chain genesis sentinels.
raw_oracle_exceptions = {
    (FIXTURES / "release-handoff-v1.json", ("authorization_sha256",)): "b" * 64,
    (FIXTURES / "release-handoff-v1.json", ("candidate_evidence_sha256",)): "a" * 64,
    (FIXTURES / "release-handoff-v1.json", ("publisher_revision",)): "2" * 40,
    (FIXTURES / "release-handoff-v1.json", ("source_revision",)): "1" * 40,
    (FIXTURES / "publisher-dispatch-v1.json", ("publisher_revision",)): "2" * 40,
    (FIXTURES / "publisher-dispatch-v1.json", ("source_revision",)): "1" * 40,
}
zero_hash_sentinel_paths = {
    (
        FIXTURES / "publisher-dispatch-receipt-v1.fixture.json",
        ("body", "previous_receipt_sha256"),
    ),
    (
        FIXTURES / "publisher-dispatch-receipt-v1.schema.json",
        (
            "properties",
            "body",
            "properties",
            "previous_receipt_sha256",
            "const",
        ),
    ),
    (
        FIXTURES / "release-journal-v1.fixture.json",
        ("entries", 0, "entry", "body", "previous_entry_sha256"),
    ),
    (
        FIXTURES / "release-live-evidence-v1.fixture.json",
        ("publication_receipts", 0, "body", "previous_receipt_sha256"),
    ),
    (
        FIXTURES / "release-live-evidence-v1.schema.json",
        (
            "properties",
            "publication_receipts",
            "items",
            "oneOf",
            0,
            "properties",
            "body",
            "properties",
            "previous_receipt_sha256",
            "const",
        ),
    ),
}
repeated_hash_exceptions = {
    **raw_oracle_exceptions,
    **{path: ZERO_SHA256 for path in zero_hash_sentinel_paths},
}


def assert_repeated_hash_policy(document_path, document):
    observed_zero_paths = set()
    for value_path, repeated in walk_repeated_hashes(document):
        if (
            document_path
            == FIXTURES / "release-live-implementation-identity-v1.schema.json"
            and len(value_path) >= 3
            and value_path[-3:-1] == ("not", "enum")
            and isinstance(value_path[-1], int)
        ):
            assert repeated in {
                character * length
                for character in "0123456789abcdef"
                for length in (40, 64)
            }
            continue
        if (
            document_path
            == FIXTURES / "release-live-implementation-identity-v1.schema.json"
            and value_path[:2] == ("$defs", "receipt_binding")
            and "previous_receipt_sha256" in value_path
            and value_path[-1] == "const"
        ):
            assert repeated == ZERO_SHA256
            continue
        exception_key = (document_path, value_path)
        assert repeated_hash_exceptions.get(exception_key) == repeated, (
            f"{document_path}:{value_path}: unscoped repeated-character hash "
            f"{repeated}"
        )
        if repeated == ZERO_SHA256:
            observed_zero_paths.add(exception_key)
    return observed_zero_paths


observed_zero_hash_sentinels = set()
for document_path, document in parsed.items():
    observed_zero_hash_sentinels.update(
        assert_repeated_hash_policy(document_path, document)
    )
assert observed_zero_hash_sentinels == zero_hash_sentinel_paths

altered_zero_hash = copy.deepcopy(candidate_fixture)
altered_zero_hash["archives"]["deployment-controller-verified-image"][
    "archive_sha256"
] = ZERO_SHA256
try:
    assert_repeated_hash_policy(
        FIXTURES / "candidate-evidence-v1.fixture.json", altered_zero_hash
    )
except AssertionError as error:
    assert "unscoped repeated-character hash" in str(error)
else:
    raise AssertionError("all-zero digest outside a chain sentinel was accepted")
for purpose, archive in candidate_fixture["archives"].items():
    assert_not_repeated_hash(archive["archive_sha256"], f"{purpose}.archive")
    for file in archive["files"]:
        assert_not_repeated_hash(file["sha256"], f"{purpose}.{file['path']}")

# Every operation carries actual canonical target/readback bodies and their hashes.
operations = journal_fixture["operations"]
assert len(operations) == EXPECTED_OPERATION_EVIDENCE
assert EXPECTED_OPERATION_EVIDENCE > 0
for operation in operations:
    request = operation["request"]
    target = parse_json_text(request["target_jcs"])
    assert request["target_jcs"].encode("utf-8") == jcs(target)
    assert request["target_sha256"] == sha256(request["target_jcs"].encode("utf-8"))
    assert operation["request_sha256"] == sha256(jcs(request))
    readback = operation["readback"]
    state = parse_json_text(readback["state_jcs"])
    assert readback["state_jcs"].encode("utf-8") == jcs(state)
    assert readback["state_sha256"] == sha256(readback["state_jcs"].encode("utf-8"))
    assert readback["target_sha256"] == request["target_sha256"]
    assert operation["readback_sha256"] == sha256(jcs(readback))
    # Every authority-bearing target, including active publisher dispatch, uses
    # derived values. Frozen raw identities remain non-authoritative oracles.
    repeated_target_hashes = list(walk_repeated_hashes(target))
    assert not repeated_target_hashes, (
        operation["operation"],
        repeated_target_hashes,
    )

expected_verifier_target = {
    **FIXTURE_AUTHORITY_MARKER,
    "fixture_identity_jcs_sha256": claim_identity_digest,
    "workflow": (
        "codicarium/deployment-controller/"
        ".github/workflows/release-verify-v2.yaml"
    ),
    "ref": "refs/heads/main",
    "workflow_sha": reviewed_workflow_revision,
    "tag": "v0.6.14",
    "source_revision": candidate_source_revision,
}


def validate_verifier_target(target):
    assert_fixture_authority(target, claim_identity_digest)
    assert target == expected_verifier_target


verifier_target = parse_json_text(operations[0]["request"]["target_jcs"])
validate_verifier_target(verifier_target)
for mutator, label in [
    (
        lambda target: target.update({"publication_authority": True}),
        "verifier target authority marker",
    ),
    (
        lambda target: target.update({"evidence_class": "live-protected-authority"}),
        "verifier target evidence marker",
    ),
    (
        lambda target: target.update(
            {"fixture_identity_jcs_sha256": sha256(b"wrong-verifier-fixture")}
        ),
        "verifier target fixture identity",
    ),
    (
        lambda target: target.update({"source_revision": sha256(b"wrong-source")[:40]}),
        "verifier target source",
    ),
    (
        lambda target: target.update({"workflow_sha": sha256(b"wrong-workflow")[:40]}),
        "verifier target workflow SHA",
    ),
    (
        lambda target: target.update(
            {"workflow": "codicarium/deployment-controller/.github/workflows/evil.yaml"}
        ),
        "verifier target workflow path",
    ),
    (
        lambda target: target.update({"ref": "refs/heads/evil"}),
        "verifier target ref",
    ),
    (lambda target: target.update({"tag": "v0.6.13"}), "verifier target tag"),
]:
    altered_verifier_target = copy.deepcopy(verifier_target)
    mutator(altered_verifier_target)
    try:
        validate_verifier_target(altered_verifier_target)
    except AssertionError:
        pass
    else:
        raise AssertionError(f"{label}: invalid target accepted")

assert [item["operation"] for item in operations[:3]] == [
    "verifier-dispatch",
    "verification-authorization",
    "publisher-dispatch",
]
mutation_operations = operations[3:]
assert len(mutation_operations) == EXPECTED_MUTATION_RECEIPTS
assert [item["sequence"] for item in mutation_operations] == [
    str(index) for index in range(1, 20)
]
assert [item["operation"] for item in mutation_operations] == [
    "tag-create",
    "draft-release-create",
    "image-publish",
    "chart-publish",
    *(["release-asset-create"] * 14),
    "release-finalize",
]

expected_publisher_request = {
    "schema": "codicarium.publisher-dispatch-request/v2",
    **FIXTURE_AUTHORITY_MARKER,
    "fixture_identity_jcs_sha256": claim_identity_digest,
    "claim_key": claim_fixture["claim_key"],
    "claim_identity_jcs_sha256": claim_identity_digest,
    "active_source_revision": candidate_source_revision,
    "protected_main_revision": claim_fixture["identity"]["protected_main_revision"],
    "publisher_workflow_path": publisher_path,
    "publisher_workflow_sha": claim_fixture["identity"]["publisher_workflow"][
        "workflow_sha"
    ],
    "legacy_raw_identity": {
        "authority": False,
        "handoff_sha256": sha256(handoff_raw),
        "dispatch_sha256": sha256(publisher_dispatch_raw),
    },
}


def assert_publisher_request_binding(request):
    assert request == expected_publisher_request


publisher_target = parse_json_text(operations[2]["request"]["target_jcs"])
assert_fixture_authority(publisher_target, claim_identity_digest)
assert_publisher_request_binding(publisher_target)
for mutate in (
    lambda request: request.update({"publication_authority": True}),
    lambda request: request.update({"evidence_class": "live-protected-authority"}),
    lambda request: request.update(
        {"fixture_identity_jcs_sha256": sha256(b"wrong-fixture")}
    ),
    lambda request: request.update(
        {"claim_key": "rel-v2-sha256:" + sha256(b"wrong-claim")}
    ),
    lambda request: request.update(
        {"claim_identity_jcs_sha256": sha256(b"wrong-identity")}
    ),
    lambda request: request.update(
        {"active_source_revision": sha256(b"wrong-source")[:40]}
    ),
    lambda request: request.update(
        {"protected_main_revision": sha256(b"wrong-protected-main")[:40]}
    ),
    lambda request: request.update(
        {"publisher_workflow_path": ".github/workflows/evil.yaml"}
    ),
    lambda request: request.update(
        {"publisher_workflow_sha": sha256(b"wrong-workflow")[:40]}
    ),
    lambda request: request["legacy_raw_identity"].update({"authority": True}),
):
    altered_request = copy.deepcopy(publisher_target)
    mutate(altered_request)
    try:
        assert_publisher_request_binding(altered_request)
    except AssertionError:
        pass
    else:
        raise AssertionError("altered active publisher binding was accepted")

# GitHub dispatch identity comes only from the pinned direct response. A 204
# response is terminal UNKNOWN_MANUAL and never causes a second dispatch.
dispatch_transport = {
    "api_version_header": "X-GitHub-Api-Version",
    "api_version": "2026-03-10",
    "accept": "application/vnd.github+json",
    "return_run_details": True,
}
assert operations[0]["request"]["github_api"] == dispatch_transport
assert operations[2]["request"]["github_api"] == dispatch_transport
assert all(
    operation["request"]["github_api"] is None
    for index, operation in enumerate(operations)
    if index not in (0, 2)
)
dispatch_contract = journal_fixture["github_dispatch_contract"]
assert dispatch_contract["request"] == dispatch_transport
assert_publisher_request_binding(dispatch_contract["publisher_request"])
assert dispatch_contract["positive"] == {
    "http_status": 200,
    "response": {
        "workflow_run_id": "9005001",
        "workflow_run_url": "https://api.github.com/repos/codicarium/deployment-controller/actions/runs/9005001",
        "workflow_run_html_url": "https://github.com/codicarium/deployment-controller/actions/runs/9005001",
    },
    "identity_source": "direct-response.workflow_run_id",
    "outcome": "DIRECT_RUN_ID_ACCEPTED",
    "journal_commit": True,
    "automatic_retry": False,
}
assert dispatch_contract["no_body"] == {
    "http_status": 204,
    "response": None,
    "outcome": "UNKNOWN_MANUAL",
    "journal_commit": False,
    "automatic_retry": False,
}
publisher_response = parse_json_text(operations[2]["readback"]["state_jcs"])
assert {
    key: publisher_response[key]
    for key in ("workflow_run_id", "workflow_run_url", "workflow_run_html_url")
} == dispatch_contract["positive"]["response"]
journal_schema = schemas["release-journal-v1.schema.json"]
for mutate in (
    lambda fixture: fixture["operations"][0]["request"]["github_api"].update(
        {"return_run_details": False}
    ),
    lambda fixture: fixture["github_dispatch_contract"]["request"].update(
        {"api_version": "2022-11-28"}
    ),
    lambda fixture: fixture["github_dispatch_contract"]["no_body"].update(
        {"automatic_retry": True}
    ),
):
    altered = copy.deepcopy(journal_fixture)
    mutate(altered)
    assert list(Draft202012Validator(journal_schema).iter_errors(altered))

authorization_target = parse_json_text(operations[1]["request"]["target_jcs"])
assert_fixture_authority(authorization_target, claim_identity_digest)
authorization_core = dict(authorization_target)
authorization_digest = authorization_core.pop("authorization_sha256")
assert authorization_digest == sha256(jcs(authorization_core))
image_target = parse_json_text(operations[5]["request"]["target_jcs"])
chart_target = parse_json_text(operations[6]["request"]["target_jcs"])
assert image_target["digest"] == "sha256:" + sha256(jcs({
    "schema": "codicarium.published-image-fixture/v1",
    "source_revision": candidate_source_revision,
    "candidate_archive_sha256": candidate_fixture["archives"]
        ["deployment-controller-verified-image"]["archive_sha256"],
}))
assert chart_target["digest"] == "sha256:" + sha256(jcs({
    "schema": "codicarium.published-chart-fixture/v1",
    "source_revision": candidate_source_revision,
    "candidate_archive_sha256": candidate_fixture["archives"]
        ["deployment-controller-verified-chart"]["archive_sha256"],
}))

# Journal rows are immutable, signed, and strictly previous-hash linked.
records = journal_fixture["entries"]
assert_fixture_authority(journal_fixture, claim_identity_digest)
assert len(records) == EXPECTED_JOURNAL_ENTRIES
assert EXPECTED_JOURNAL_ENTRIES > 0
previous_entry_sha = ZERO_SHA256
event_names = []
for index, record in enumerate(records, start=1):
    entry_sha = verify_envelope(record["entry"])
    assert record["entry_sha256"] == entry_sha
    body = record["entry"]["body"]
    assert_fixture_authority(body, claim_identity_digest)
    assert body["ordinal"] == str(index)
    assert body["claim_key"] == claim_fixture["claim_key"]
    assert body["previous_entry_sha256"] == previous_entry_sha
    assert body["actor"]["can_mutate_targets"] is False
    assert body["actor"]["can_sign"] is False
    if body["payload"]["phase"] == "commit":
        assert body["actor"]["role"] == "committer"
        assert body["actor"]["can_commit"] is True
    else:
        assert body["actor"]["can_commit"] is (
            body["payload"]["phase"] == "complete"
        )
    previous_entry_sha = entry_sha
    event_names.append(body["event"])

expected_events = [
    "claim",
    "verifier-dispatch-reserve",
    "verifier-dispatch-commit",
    "verification-authorization",
    "publisher-dispatch-reserve",
    "publisher-dispatch-commit",
    *sum(
        (["mutation-reserve", "mutation-commit"] for _ in range(19)),
        [],
    ),
    "complete",
]
assert event_names == expected_events
assert journal_fixture["terminal_state"] == "complete"
assert records[0]["entry"]["body"]["payload"]["phase"] == "claim"
assert records[-1]["entry"]["body"]["payload"]["phase"] == "complete"

verifier_reserve = records[1]
verifier_commit = records[2]
assert (
    verifier_commit["entry"]["body"]["payload"]["reservation_entry_sha256"]
    == verifier_reserve["entry_sha256"]
)
publisher_reserve = records[4]
publisher_commit = records[5]
assert (
    publisher_commit["entry"]["body"]["payload"]["reservation_entry_sha256"]
    == publisher_reserve["entry_sha256"]
)
for index in range(19):
    reserve = records[6 + index * 2]
    commit = records[7 + index * 2]
    sequence = str(index + 1)
    assert reserve["entry"]["body"]["publication_sequence"] == sequence
    assert commit["entry"]["body"]["publication_sequence"] == sequence
    assert (
        commit["entry"]["body"]["payload"]["reservation_entry_sha256"]
        == reserve["entry_sha256"]
    )
assert journal_fixture["storage"]["authority"] == "dedicated-dev-postgresql-not-s3"
assert journal_fixture["storage"]["transactions"] == "SERIALIZABLE"
assert journal_fixture["storage"]["synchronous_commit"] == "on"
assert journal_fixture["storage"]["synchronous_replicas"] == (
    "REQUIRED_PREACTIVATION_NOT_PROVEN"
)
assert journal_fixture["storage"]["append_only"] is True
assert journal_fixture["storage"]["constraints"] == [
    "PRIMARY KEY entry_id",
    "UNIQUE claim_key+ordinal",
    "UNIQUE claim_key+event+publication_sequence",
    "NOT NULL and CHECK closed enums",
]
assert journal_fixture["storage"]["write_api"] == "stored-procedures-only"
assert journal_fixture["storage"]["update_endpoint"] is False
assert journal_fixture["storage"]["delete_endpoint"] is False
assert "INSERT" in journal_fixture["storage"]["runtime_revocations"]
assert "UPDATE" in journal_fixture["storage"]["runtime_revocations"]
assert "DELETE" in journal_fixture["storage"]["runtime_revocations"]
assert journal_fixture["role_separation"] == {
    "target_writer_can_sign_or_commit": False,
    "signer_can_mutate_or_commit": False,
    "committer_can_mutate_or_sign": False,
}

# The migration contains self-contained, executable SECURITY DEFINER deny stubs.
# They prove the ACL boundary without pretending that CAS/FSM database behavior
# exists before implementation and PostgreSQL integration evidence are available.
procedure_migration = journal_fixture["procedure_migration"]
expected_procedures = [
    "release_journal.claim_cas_v1",
    "release_journal.reserve_v1",
    "release_journal.commit_v1",
    "release_journal.authorize_v1",
    "release_journal.complete_v1",
]
assert procedure_migration["implementation_status"] == (
    "BLOCKED_PREACTIVATION_FAIL_CLOSED"
)
assert procedure_migration["migration_transactional"] is True
assert procedure_migration["owner_role"] == "release_journal_owner"
assert procedure_migration["owner_role_login"] is False
assert procedure_migration["runtime_role"] == "release_journal_runtime"
assert procedure_migration["runtime_is_owner"] is False
assert procedure_migration["runtime_inherits_owner"] is False
assert procedure_migration["runtime_schema_create_privilege"] is False
assert procedure_migration["public_schema_create_privilege"] is False
assert procedure_migration["runtime_database_temp_privilege"] is False
assert procedure_migration["public_database_temp_privilege"] is False
assert procedure_migration["public_database_connect_privilege"] is False
assert procedure_migration["runtime_procedure_privileges"] == ["EXECUTE"]
assert procedure_migration["runtime_direct_table_privileges"] == []
assert procedure_migration["public_procedure_privileges"] == []
assert procedure_migration["owner_default_public_execute_revoked"] is True
assert procedure_migration["persistent_relation_references_fully_qualified"] is True
assert procedure_migration["non_builtin_function_references_fully_qualified"] is True
assert procedure_migration["builtin_function_references_pg_catalog_qualified"] is True
database_connect_public_revoke_sql = (
    "REVOKE CONNECT ON DATABASE runner_platform_journal FROM PUBLIC;"
)
database_temp_public_revoke_sql = (
    "REVOKE TEMPORARY ON DATABASE runner_platform_journal FROM PUBLIC;"
)
database_temp_runtime_revoke_sql = (
    "REVOKE TEMPORARY ON DATABASE runner_platform_journal "
    "FROM release_journal_runtime;"
)
schema_create_public_revoke_sql = (
    "REVOKE CREATE ON SCHEMA release_journal FROM PUBLIC;"
)
schema_create_runtime_revoke_sql = (
    "REVOKE CREATE ON SCHEMA release_journal FROM release_journal_runtime;"
)
default_privileges_sql = (
    "ALTER DEFAULT PRIVILEGES FOR ROLE release_journal_owner IN SCHEMA "
    "release_journal REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;"
)
assert procedure_migration["default_privileges_sql"] == default_privileges_sql
assert procedure_migration["database_connect_public_revoke_sql"] == (
    database_connect_public_revoke_sql
)
assert procedure_migration["database_temp_public_revoke_sql"] == (
    database_temp_public_revoke_sql
)
assert procedure_migration["database_temp_runtime_revoke_sql"] == (
    database_temp_runtime_revoke_sql
)
assert procedure_migration["schema_create_public_revoke_sql"] == (
    schema_create_public_revoke_sql
)
assert procedure_migration["schema_create_runtime_revoke_sql"] == (
    schema_create_runtime_revoke_sql
)
assert [item["name"] for item in procedure_migration["procedures"]] == expected_procedures
procedure_definitions = []
deny_body = (
    "BEGIN\n"
    "  RAISE EXCEPTION USING ERRCODE = '0A000', MESSAGE = "
    "'release journal implementation not installed';\n"
    "END;"
)
for procedure in procedure_migration["procedures"]:
    name = procedure["name"]
    signature = f"{name}(jsonb)"
    create_signature = f"{name}(request jsonb)"
    expected_definition = "\n".join(
        [
            f"CREATE OR REPLACE FUNCTION {create_signature}",
            "RETURNS jsonb",
            "LANGUAGE plpgsql",
            "SECURITY DEFINER",
            "SET search_path = pg_catalog, release_journal, pg_temp",
            "AS $procedure$",
            deny_body,
            "$procedure$;",
            f"ALTER FUNCTION {signature} OWNER TO release_journal_owner;",
            f"REVOKE ALL ON FUNCTION {signature} FROM PUBLIC;",
            f"GRANT EXECUTE ON FUNCTION {signature} TO release_journal_runtime;",
        ]
    )
    definition = procedure["definition_sql"]
    assert procedure["signature"] == signature
    assert procedure["create_signature"] == create_signature
    assert procedure["implemented"] is False
    assert procedure["failure_sqlstate"] == "0A000"
    assert procedure["writes_on_call"] == 0
    assert procedure["security_definer"] is True
    assert procedure["search_path"] == [
        "pg_catalog",
        "release_journal",
        "pg_temp",
    ]
    assert procedure["persistent_relation_references"] == (
        "fully-qualified-release_journal-only"
    )
    assert procedure["non_builtin_function_references"] == (
        "fully-qualified-release_journal-only"
    )
    assert procedure["builtin_function_references"] == (
        "fully-qualified-pg_catalog-only"
    )
    assert procedure["owner_role"] == "release_journal_owner"
    assert procedure["runtime_privileges"] == ["EXECUTE"]
    assert procedure["public_execute_revoked"] is True
    assert definition == expected_definition
    assert "_impl_v1" not in definition
    assert "RETURN " not in deny_body
    assert procedure["definition_sha256"] == sha256(definition.encode("utf-8"))
    procedure_definitions.append(definition)
expected_migration_sql = "\n\n".join(
    [
        "BEGIN;",
        database_connect_public_revoke_sql,
        database_temp_public_revoke_sql,
        database_temp_runtime_revoke_sql,
        schema_create_public_revoke_sql,
        schema_create_runtime_revoke_sql,
        default_privileges_sql,
        *procedure_definitions,
        "COMMIT;",
    ]
)
assert procedure_migration["migration_sql"] == expected_migration_sql
assert procedure_migration["migration_sha256"] == sha256(
    expected_migration_sql.encode("utf-8")
)
temp_shadow = procedure_migration["temp_shadow_attack_vector"]
assert temp_shadow["name"] == "pg-temp-relation-and-function-shadow"
assert temp_shadow["attacker_role"] == "release_journal_runtime"
assert temp_shadow["attempted_objects"] == [
    "pg_temp.release_claims relation",
    "pg_temp.digest(jsonb) function",
]
assert temp_shadow["runtime_create_result"] == "DENY_SQLSTATE_42501"
assert temp_shadow["privileged_test_harness_precreates_shadows"] is True
assert temp_shadow["procedure_search_path"] == [
    "pg_catalog",
    "release_journal",
    "pg_temp",
]
assert temp_shadow["expected_resolution"] == {
    "persistent_relations": "explicit release_journal qualification",
    "non_builtin_functions": "explicit release_journal qualification",
    "builtin_functions": "explicit pg_catalog qualification",
    "pg_temp_objects": "never selected",
}
assert temp_shadow["unauthorized_writes"] == 0
assert temp_shadow["activation_result"] == (
    "REQUIRED_POSTGRES_INTEGRATION_EVIDENCE"
)
for mutate in (
    lambda fixture: fixture["procedure_migration"]["procedures"][0].update(
        {"security_definer": False}
    ),
    lambda fixture: fixture["procedure_migration"]["procedures"][1].update(
        {"search_path": ["pg_catalog", "pg_temp", "release_journal"]}
    ),
    lambda fixture: fixture["procedure_migration"]["procedures"][2].update(
        {"public_execute_revoked": False}
    ),
    lambda fixture: fixture["procedure_migration"]["procedures"][3].update(
        {"implemented": True}
    ),
    lambda fixture: fixture["procedure_migration"]["procedures"][4].update(
        {"writes_on_call": 1}
    ),
    lambda fixture: fixture["procedure_migration"].update(
        {"runtime_is_owner": True}
    ),
    lambda fixture: fixture["procedure_migration"].update(
        {"owner_default_public_execute_revoked": False}
    ),
    lambda fixture: fixture["procedure_migration"].update(
        {"runtime_database_temp_privilege": True}
    ),
    lambda fixture: fixture["procedure_migration"].update(
        {"public_database_temp_privilege": True}
    ),
    lambda fixture: fixture["procedure_migration"].update(
        {"public_schema_create_privilege": True}
    ),
    lambda fixture: fixture["procedure_migration"].update(
        {"persistent_relation_references_fully_qualified": False}
    ),
    lambda fixture: fixture["procedure_migration"].update(
        {"builtin_function_references_pg_catalog_qualified": False}
    ),
    lambda fixture: fixture["procedure_migration"][
        "temp_shadow_attack_vector"
    ].update({"unauthorized_writes": 1}),
):
    altered = copy.deepcopy(journal_fixture)
    mutate(altered)
    assert list(Draft202012Validator(journal_schema).iter_errors(altered))

# Publication receipts are a separate exact 0..19 chain and bind real operations.
expected_dispatch_receipt_bindings = {
    "claim_key": claim_fixture["claim_key"],
    "active_source_revision": candidate_source_revision,
    "claim_identity_jcs_sha256": claim_identity_digest,
    "protected_main_revision": claim_fixture["identity"]["protected_main_revision"],
    "legacy_raw_identity_authority": False,
    "handoff_sha256": sha256(handoff_raw),
    "publisher_workflow": "codicarium/deployment-controller/" + publisher_path,
    "publisher_workflow_sha": claim_fixture["identity"]["publisher_workflow"][
        "workflow_sha"
    ],
    "publisher_revision": claim_fixture["identity"]["protected_main_revision"],
}


def assert_dispatch_receipt_binding(body):
    for key, expected in expected_dispatch_receipt_bindings.items():
        assert body[key] == expected, key


assert len(mutation_receipts) == EXPECTED_MUTATION_RECEIPTS
assert EXPECTED_MUTATION_RECEIPTS > 0
assert_fixture_authority(mutation_fixture, claim_identity_digest)
publication_receipts = [dispatch_receipt, *mutation_receipts]
assert len(publication_receipts) == EXPECTED_PUBLICATION_RECEIPTS
assert EXPECTED_PUBLICATION_RECEIPTS > 0
previous_receipt_sha = ZERO_SHA256
receipt_hashes = []
for sequence, receipt in enumerate(publication_receipts):
    receipt_sha = verify_envelope(receipt)
    receipt_hashes.append(receipt_sha)
    body = receipt["body"]
    assert_fixture_authority(body, claim_identity_digest)
    assert body["sequence"] == str(sequence)
    assert body["claim_key"] == claim_fixture["claim_key"]
    assert body["previous_receipt_sha256"] == previous_receipt_sha
    assert body["issuer"] == {
        "kind": "vault-transit",
        "principal": "release-journal-signer",
        "vault_role": "release-journal-sign-v1",
        "can_mutate_targets": False,
        "can_commit_journal": False,
    }
    if sequence == 0:
        operation = operations[2]
        commit = records[5]
        assert body["kind"] == "publisher-dispatch"
        assert_dispatch_receipt_binding(body)
        assert body["reservation_entry_sha256"] == records[4]["entry_sha256"]
        assert body["dispatch_request_sha256"] == operation["request_sha256"]
        assert body["dispatch_readback_sha256"] == operation["readback_sha256"]
    else:
        operation = mutation_operations[sequence - 1]
        reserve = records[6 + (sequence - 1) * 2]
        commit = records[7 + (sequence - 1) * 2]
        assert body["kind"] == "publisher-mutation"
        assert body["mutation"] == operation["operation"]
        assert body["reservation_entry_sha256"] == reserve["entry_sha256"]
        assert body["request_sha256"] == operation["request_sha256"]
        assert body["readback_sha256"] == operation["readback_sha256"]
        assert body["target"] == parse_json_text(operation["request"]["target_jcs"])
    assert (
        commit["entry"]["body"]["payload"]["publication_receipt_sha256"]
        == receipt_sha
    )
    previous_receipt_sha = receipt_sha

wrong_dispatch_receipt_bindings = {
    "claim_key": "rel-v2-sha256:" + sha256(b"wrong-receipt-claim"),
    "active_source_revision": sha256(b"wrong-receipt-source")[:40],
    "claim_identity_jcs_sha256": sha256(b"wrong-receipt-identity"),
    "protected_main_revision": sha256(b"wrong-receipt-protected")[:40],
    "legacy_raw_identity_authority": True,
    "handoff_sha256": sha256(b"wrong-receipt-handoff"),
    "publisher_workflow": "codicarium/deployment-controller/.github/workflows/evil.yaml",
    "publisher_workflow_sha": sha256(b"wrong-receipt-workflow")[:40],
    "publisher_revision": sha256(b"wrong-receipt-revision")[:40],
}
for key, wrong_value in wrong_dispatch_receipt_bindings.items():
    altered_body = copy.deepcopy(dispatch_receipt["body"])
    altered_body[key] = wrong_value
    try:
        assert_dispatch_receipt_binding(altered_body)
    except AssertionError:
        pass
    else:
        raise AssertionError(f"altered dispatch receipt binding accepted: {key}")

placeholder_receipt_hashes = {
    sha256(f"publisher-mutation-receipt-{sequence}".encode("utf-8"))
    for sequence in range(1, 20)
}
assert not placeholder_receipt_hashes.intersection(receipt_hashes)
assert len(set(receipt_hashes)) == EXPECTED_PUBLICATION_RECEIPTS

# The live fixture embeds exactly the same twenty signed envelopes and commit rows.
assert_fixture_authority(live_evidence, claim_identity_digest)
assert_fixture_authority(live_evidence["claim"], claim_identity_digest)
assert live_evidence["publication_receipts"] == publication_receipts
assert len(live_evidence["publication_commit_entries"]) == 20
assert live_evidence["claim"]["claim_key"] == claim_fixture["claim_key"]
assert live_evidence["check_run_observations"] == {
    "authority": False,
    "handoff_coordinator_check_run_id": "9002003",
    "dispatch_handoff_check_run_id": "9004003",
    "handoff_sha256": sha256(handoff_raw),
    "dispatch_sha256": sha256(publisher_dispatch_raw),
}
assert live_evidence["journal"] == {
    "authority": "dedicated-dev-postgresql-not-s3",
    "journal_id": records[0]["entry"]["body"]["journal_id"],
    "entry_count": 45,
    "first_entry_sha256": records[0]["entry_sha256"],
    "last_entry_sha256": records[-1]["entry_sha256"],
    "terminal_state": "complete",
}
for index, summary in enumerate(live_evidence["publication_commit_entries"]):
    commit_index = 5 if index == 0 else 7 + (index - 1) * 2
    assert summary == {
        "sequence": str(index),
        "journal_commit_entry_sha256": records[commit_index]["entry_sha256"],
        "receipt_sha256": receipt_hashes[index],
    }
assert live_evidence["publication_receipts"][1]["body"]["mutation"] == "tag-create"
assert live_evidence["publication_receipts"][1]["body"]["sequence"] == "1"
assert len(live_evidence["assets"]) == EXPECTED_ASSETS
assert live_evidence["release"]["draft"] is False

# All Ed25519 fixtures are real and independently verified.
assert verified_signatures == EXPECTED_ED25519_SIGNATURES
assert EXPECTED_ED25519_SIGNATURES > 0

# Retirement is an exact five-ID/path set and includes all credential fences.
expected_retired = [
    ("341194538", ".github/workflows/automatic-release.yaml"),
    ("318365668", ".github/workflows/release.yaml"),
    ("318365667", ".github/workflows/publish-release.yaml"),
    ("333279414", ".github/workflows/recover-release-attestations.yaml"),
    ("340335357", ".github/workflows/recover-release-v068.yaml"),
]
assert len(retirement_fixture["workflows"]) == EXPECTED_RETIRED_WORKFLOWS
assert [
    (item["id"], item["path"]) for item in retirement_fixture["workflows"]
] == expected_retired
assert all(item["workflow_state"] == "disabled_manually" for item in retirement_fixture["workflows"])
assert all(item["path_state"] == "deleted-before-v0.6.14" for item in retirement_fixture["workflows"])
assert all(item["old_outputs_accepted"] is False for item in retirement_fixture["workflows"])
assert all(item["reruns_accepted"] is False for item in retirement_fixture["workflows"])
assert retirement_fixture["legacy_secret_authorities"] == [
    "ACTIONS_STORAGE_OVH_ACCESS_KEY_ID",
    "ACTIONS_STORAGE_OVH_ACCESS_KEY_SECRET",
    "CODICARIUM_PACKAGE_REGISTRY_PASSWORD",
    "CODICARIUM_PACKAGE_REGISTRY_USERNAME",
    "NEXUS_PASSWORD",
    "NEXUS_USERNAME",
]
assert retirement_fixture["recovery_authorities"]["v068_s3_credentials"] == [
    "V068_RECOVERY_S3_READ_ACCESS_KEY_ID",
    "V068_RECOVERY_S3_READ_ACCESS_KEY_SECRET",
]
assert retirement_fixture["recovery_authorities"]["revoked"] is True
assert retirement_fixture["replacement"]["target_count"] == 1
assert retirement_fixture["replacement"]["contents_write"] is False
assert retirement_fixture["replacement"]["broad_token"] is False
assert retirement_fixture["replacement"]["reusable_secret"] is False
assert retirement_fixture["replacement"]["signing_key"] is False

# The active map contains no retired path and no Check Run writer.
workflow_contract = parsed[FIXTURES / "workflow-permissions-v1.json"]
assert workflow_contract["check_runs"]["authority"] is False
assert workflow_contract["check_runs"]["use"] == "observation-only"
assert set(workflow_contract["workflows"]) == {
    ".github/workflows/automatic-release-v2.yaml",
    ".github/workflows/release-verify-v2.yaml",
    ".github/workflows/publish-release-v2.yaml",
    ".github/workflows/ci.yaml",
}
workflow_text = json.dumps(workflow_contract, sort_keys=True)
for workflow_id, retired_path in expected_retired:
    assert retired_path not in workflow_contract["workflows"], workflow_id
assert '"checks": "write"' not in workflow_text
automatic_jobs = workflow_contract["workflows"][
    ".github/workflows/automatic-release-v2.yaml"
]["jobs"]
assert not any("tag" in name for name in automatic_jobs)
publisher_jobs = workflow_contract["workflows"][
    ".github/workflows/publish-release-v2.yaml"
]["jobs"]
assert len(publisher_jobs) == 1 + 19 * 3
assert "01-tag-create-target-write" in publisher_jobs

# Grant migration cannot patch immutable profileRef or introduce PollOnly/dev.
assert grant_fixture["current_grant"] == {
    "name": "runner-config-dev",
    "uid": "60cf8514-cbc3-4659-ba5c-22c4d4658bae",
    "resource_version": "27561715",
    "profile_ref": "arc-path-helm",
    "profile_ref_immutable": True,
    "profile_uid": "868dbd03-3a59-43bd-9c70-e393eb69d8eb",
    "duplicate_repo_environment_grant_allowed": False,
}
assert grant_fixture["new_profile"]["create_before_grant_retirement"] is True
assert grant_fixture["new_profile"]["preserve_existing_arc_scopes"] is True
assert grant_fixture["new_profile"]["resources"] == [
    "Certificate",
    "Deployment",
    "Issuer",
    "Job",
    "NetworkPolicy",
    "PodDisruptionBudget",
    "PrometheusRule",
    "Service",
    "ServiceAccount",
    "ServiceMonitor",
]
assert grant_fixture["new_profile"]["destinations"] == [
    "arc-runners",
    "arc-systems",
    "artifact-capability",
]
assert grant_fixture["preserved_objects"] == [
    {
        "kind": "AppProject",
        "namespace": "argocd",
        "name": "repo-runner-config-dev",
        "uid": "59f950a3-11f2-49c7-bd38-90948df75872",
        "resource_version": "26616740",
        "spec_sha256": (
            "78f44d4efdc2ea55c1ea7b527d863fb8c8c15170909750bb17d3e84b8670e468"
        ),
    },
    {
        "kind": "Application",
        "namespace": "argocd",
        "name": "actions-runner-controller-codicarium",
        "uid": "ff536ac7-51db-4256-8c81-6b8ef3ffda26",
        "resource_version": "43334823",
        "spec_sha256": (
            "8f0e23deb6dd6c99879342af99c967ac2289834af9f989088c335cc33b7612fd"
        ),
    },
    {
        "kind": "Application",
        "namespace": "argocd",
        "name": "actions-runner-scale-set-codicarium",
        "uid": "586b3e1e-c5bb-4bf0-b7a9-fcaa9446ded7",
        "resource_version": "43335012",
        "spec_sha256": (
            "b33e3502fd7b12cbb4f72b8524a2db97b8b2232e0b7d2363b8bd22cd6c0d9553"
        ),
    },
    {
        "kind": "AutoscalingRunnerSet",
        "namespace": "arc-runners",
        "name": "codicarium-linux",
        "uid": "4ef54624-27dc-464a-9215-54cc0b4b1eb9",
        "resource_version": "43332160",
        "spec_sha256": (
            "1bd8af51c30bd7204cf1aec21684566fa3c5f4a28d3fa1c66477d7bf35d0809e"
        ),
    },
    {
        "kind": "AutoscalingListener",
        "namespace": "arc-systems",
        "name": "codicarium-linux-5b84bf57-listener",
        "uid": "c79f2712-6e1b-49d4-988c-ca1e73873ce1",
        "resource_version": "26616851",
        "spec_sha256": (
            "9c1ed0b3dbf84e2a4b51adf583b76aa9d04a44251aba11cc5305703ee06a9d69"
        ),
    },
]
activation = grant_fixture["activation_compatibility"]
assert activation["chosen_runtime_mode"] == "event-driven"
assert activation["environment"] == "dev"
assert activation["deployment_activation_source"] is None
assert activation["request_ref_required"] is True
assert activation["kafka_required"] is True
assert activation["poll_only_admissible"] is False
assert "PollOnly remains prod-only" in activation["current_main_impact"]
steps = grant_fixture["steps"]
assert steps.index("create artifact-capability-path-helm before touching runner-config-dev") < steps.index(
    "delete old runner-config-dev with exact UID and resourceVersion preconditions"
)
assert steps.index(
    "delete old runner-config-dev with exact UID and resourceVersion preconditions"
) < steps.index(
    "recreate runner-config-dev with the same name and new profile as a new authorization epoch"
)
assert "preactivation-only" in grant_fixture["rollback"]

# Every cluster command binds the exact kubeconfig/context and immutable identity.
assert kube_fixture["kubeconfig"] == "/home/rickebo/.kube/codicarium-dev.yaml"
assert kube_fixture["context"] == "codicarium-dev"
assert kube_fixture["api_server"] == "https://10.99.0.21:6443"
assert kube_fixture["ca_pem_sha256"] == (
    "c73f41a70db74a9e1020ce84bf27227e0523055d3156d8d47ef31d41a3e3b935"
)
assert kube_fixture["kube_system_uid"] == (
    "03dea961-55e6-4141-bb23-6cb4b9f79681"
)
assert kube_fixture["dns"]["cluster_ip"] == "10.43.0.10"
assert kube_fixture["monitoring"]["namespace_uid"] == (
    "f78cd9cb-d069-4bde-bc56-33686eef5968"
)
assert len(kube_fixture["commands"]) >= 4
assert all(command.startswith(KUBE_PREFIX) for command in kube_fixture["commands"])
assert "mismatch exits before every mutation" in kube_fixture["mutation_guard"]

# Network policy is exact and deliberately reports the missing live prerequisites.
assert network_fixture["activation"] == "BLOCKED_PREACTIVATION"
assert network_fixture["broker"]["type"] == "ClusterIP"
assert network_fixture["broker"]["endpoint"] == (
    "https://artifact-capability.artifact-capability.svc.cluster.local:8443"
)
assert network_fixture["broker"]["tls"] is True
assert network_fixture["broker"]["certificate_dns_san"] == (
    "artifact-capability.artifact-capability.svc.cluster.local"
)
assert network_fixture["broker"]["ingress_or_public_route"] is False
assert network_fixture["broker"]["direct_public_egress"] is False
assert network_fixture["broker"]["public_egress_via"] == (
    "codicarium-private-egress-proxy.platform-egress.svc:8444-only"
)
assert network_fixture["broker"]["journal_database"] == {
    "desired_service": (
        "runner-platform-journal-rw.runner-platform-journal-dev.svc.cluster.local"
    ),
    "port": 5432,
    "direct_internal": True,
    "live_status": "PREACTIVATION_NOT_MATERIALIZED",
    "tls_status": "BLOCKED_UNTIL_VERIFY_FULL_CA_CONTRACT_EXISTS",
}
assert network_fixture["candidate"]["execution"] == "separate-destroyed-after-use-Kata-Job"
assert network_fixture["candidate"]["allowed_egress"] == [
    "DNS 10.43.0.10 TCP/UDP 53",
    "artifact-capability.artifact-capability.svc.cluster.local TCP 8443",
]
for forbidden in [
    "default_or_kubernetes_api_service_account_token",
    "github_egress",
    "proxy_egress",
    "public_egress",
]:
    assert network_fixture["candidate"][forbidden] is False
assert network_fixture["trusted_control"]["executes_candidate_source"] is False
assert network_fixture["trusted_control"]["proxy_required"] is True
assert network_fixture["trusted_control"]["proxy_listener"] == (
    "codicarium-private-egress-proxy.platform-egress.svc:8443-only"
)
assert network_fixture["proxies"]["live_status"] == "ABSENT_BLOCKER"
assert network_fixture["proxies"]["separate_listeners"] is True
assert network_fixture["proxies"]["github_listener"] != network_fixture["proxies"][
    "broker_artifact_listener"
]
assert network_fixture["vault_direct"] == {
    "owner": "vault-config/infra",
    "status": "MISSING_VERIFIED_INTERNAL_IP_PORT_SNI_CA_BLOCKER",
    "ip": None,
    "port": None,
    "sni": None,
    "ca_sha256": None,
    "proxy": False,
}
infra = network_fixture["infra"]
assert infra == {
    "generic_eligible_workers_live": 1,
    "kata_v2_eligible_workers_live": 0,
    "required_eligible_workers": 3,
    "additional_workers_required": 2,
    "control_node": "NoSchedule",
    "remaining_two_node_capacity_proven": False,
    "kata_runtime_present": False,
    "proxy_present": False,
}
flows = network_fixture["ingress_flows"]
assert [(flow["purpose"], flow["port"]) for flow in flows] == [
    ("candidate-broker", 8443),
    ("trusted-control-broker", 8443),
    ("prometheus-metrics", 9090),
    ("broker-journal-database", 5432),
    ("migration-journal-database", 5432),
]
for flow in flows:
    assert flow["source"]["selector_combination"] == (
        "same-peer-namespaceSelector-AND-podSelector-plus-exact-ServiceAccount"
    )
    assert flow["destination"]["selector_combination"] == (
        "same-peer-namespaceSelector-AND-podSelector-plus-exact-ServiceAccount"
    )
vault_policy = network_fixture["vault_reserved_path_policy"]
assert vault_policy["evidence_schema"] == "2"
assert vault_policy["kv_metadata_inventory_access"] == "reconciled"
assert "kv/data/<path>" in vault_policy["deny_rule_pairs"]
assert "kv/metadata/<path>" in vault_policy["deny_rule_pairs"]
assert vault_policy["partial_or_ancestor_only_evidence"] == "REJECT"
assert "no Bitwarden" in vault_policy["secret_seed"]

# Candidate source delivery is an exact protected-control -> immutable broker
# -> Kata path. The only candidate credential is the typed, Pod-bound one-read
# broker token; it is neither a default Kubernetes API token nor a proxy token.
network_schema = schemas["network-conformance-v1.schema.json"]
candidate_runtime = network_fixture["candidate"]
assert candidate_runtime["typed_broker_read_token"] is True
assert candidate_runtime["proxy_token_projection"] is False
delivery = candidate_runtime["input_delivery"]
assert_fixture_authority(delivery, claim_identity_digest)
assert delivery["schema"] == "codicarium.candidate-input-delivery/v1"
assert delivery["repository_id"] == "1303901324"
assert delivery["repository"] == "codicarium/deployment-controller"
assert delivery["commit_sha"] == candidate_source_revision
assert delivery["source_url"] == (
    "https://codeload.github.com/codicarium/deployment-controller/tar.gz/"
    + candidate_source_revision
)
synthetic_candidate_tar = (FIXTURES / "canonical-archive-v1.tar").read_bytes()


def validate_candidate_archive_oracle(candidate_delivery):
    assert_fixture_authority(candidate_delivery, claim_identity_digest)
    assert candidate_delivery["archive_bytes_evidence_class"] == (
        "synthetic-conformance-byte-oracle-not-live-codeload-response"
    )
    assert candidate_delivery["archive_bytes_live_codeload_response"] is False
    assert candidate_delivery["archive_format"] == "gzip-compressed-posix-ustar"
    archive_bytes = base64.b64decode(
        candidate_delivery["archive_bytes_base64"], validate=True
    )
    assert len(archive_bytes) == int(candidate_delivery["byte_length"])
    assert sha256(archive_bytes) == candidate_delivery["archive_sha256"]
    assert archive_bytes[:4] == b"\x1f\x8b\x08\x00"
    assert int.from_bytes(archive_bytes[4:8], "little") == 0
    tar_bytes = gzip.decompress(archive_bytes)
    assert tar_bytes == synthetic_candidate_tar
    assert len(tar_bytes) == int(
        candidate_delivery["uncompressed_tar_byte_length"]
    )
    assert sha256(tar_bytes) == candidate_delivery["uncompressed_tar_sha256"]
    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:") as archive:
        assert archive.pax_headers == {}
        members = archive.getmembers()
        assert [member.name for member in members] == ["alpha.txt", "beta.txt"]
        for member in members:
            path = pathlib.PurePosixPath(member.name)
            assert not path.is_absolute()
            assert ".." not in path.parts
            assert "\\" not in member.name
            assert all(ord(character) >= 32 for character in member.name)
            assert member.isfile()
            assert not member.islnk() and not member.issym()
            assert not member.isdev() and not member.isfifo()
            assert not getattr(member, "sparse", None)
            assert member.pax_headers == {}
    return archive_bytes, tar_bytes


candidate_archive_bytes, candidate_tar_bytes = validate_candidate_archive_oracle(
    delivery
)
expected_candidate_source_archive_sha = sha256(candidate_archive_bytes)
assert delivery["archive_sha256"] == expected_candidate_source_archive_sha
assert delivery["byte_length"] == str(len(candidate_archive_bytes))
assert delivery["uncompressed_tar_sha256"] == sha256(candidate_tar_bytes)
assert delivery["uncompressed_tar_byte_length"] == str(len(candidate_tar_bytes))
assert delivery["content_type"] == "application/gzip"
assert delivery["object_key"] == (
    "candidate-inputs/v1/repos/1303901324/commits/"
    + candidate_source_revision
    + "/sha256/"
    + expected_candidate_source_archive_sha
    + ".tar.gz"
)
assert delivery["live_delivery_requirements"] == {
    "status": "PENDING_LIVE_CANDIDATE_SOURCE_DISCOVERY",
    "source_url_template": (
        "https://codeload.github.com/codicarium/deployment-controller/"
        "tar.gz/{live_candidate_source_sha}"
    ),
    "fetch_exact_raw_response_bytes": True,
    "compute_archive_sha256_and_byte_length_from_raw_response": True,
    "fixture_archive_bytes_forbidden": True,
    "verify_repository_commit_and_response_before_broker_create": True,
    "persist_create_receipt_and_one_read_binding": True,
}
assert delivery["image_digest_evidence"] == {
    "evidence_class": "synthetic-conformance-image-digest-fixture",
    "live_registry_manifest_digest_and_all_kata_node_preload_readback_required": True,
    "status": "REQUIRED_PREACTIVATION",
}
control_delivery = delivery["control"]
assert control_delivery["repository_identity_request"] == (
    "GET https://api.github.com/repositories/1303901324"
)
assert control_delivery["commit_identity_request"] == (
    "GET https://api.github.com/repos/codicarium/deployment-controller/commits/"
    + candidate_source_revision
)
assert control_delivery["allowed_hosts"] == [
    "api.github.com",
    "codeload.github.com",
]
assert control_delivery["fetch_mode"] == "opaque-stream-no-archive-parser"
assert control_delivery["extracts_archive"] is False
assert control_delivery["executes_archive"] is False
assert control_delivery["child_execve_allowed"] is False
assert control_delivery["image_pull_policy"] == "Never"
assert control_delivery["image_preloaded"] is True
assert control_delivery["single_pid"] is True
assert control_delivery["shell_present"] is False
assert control_delivery["tls_verified"] is True
assert "@sha256:" in control_delivery["fetcher_image"]
candidate_object_binding_fields = [
    "repository_id",
    "commit_sha",
    "source_url",
    "purpose",
    "object_key",
    "archive_sha256",
    "byte_length",
    "content_type",
]
assert control_delivery["verifies"] == candidate_object_binding_fields
broker_delivery = delivery["broker"]
assert broker_delivery["purpose"] == "deployment-controller-candidate-source"
assert broker_delivery["operations"] == ["create", "read"]
assert broker_delivery["one_time"] is True
assert broker_delivery["create_only"] is True
assert broker_delivery["conflict_status"] == 409
assert broker_delivery["mismatch_status"] == 422
assert broker_delivery["read_replay_status"] == 410
assert broker_delivery["cross_digest_status"] == 403
assert broker_delivery["one_successful_read"] is True
assert broker_delivery["capability_ttl_seconds"] == 300
assert broker_delivery["create_request_binds"] == candidate_object_binding_fields
assert broker_delivery["create_receipt_echoes"] == candidate_object_binding_fields
assert broker_delivery["read_capability_binds"] == [
    "token_jti",
    "pod_uid",
    "service_account_uid",
    "namespace",
    *candidate_object_binding_fields,
    "candidate_run_id",
    "candidate_run_attempt",
    "expires_at",
]
assert broker_delivery["candidate_token_review"] == (
    "authentication.k8s.io/v1 exact audience artifact-capability-candidate-read "
    "plus live source Pod UID/name/namespace/SA match"
)
kata_delivery = delivery["kata"]
assert kata_delivery["runtime_class_name"] == "kata-clh-runtime-rs"
assert kata_delivery["automount_service_account_token"] is False
assert kata_delivery["backoff_limit"] == 0
assert kata_delivery["active_deadline_seconds"] == 1800
assert kata_delivery["ttl_seconds_after_finished"] == 0
assert kata_delivery["image_pull_policy"] == "Never"
assert kata_delivery["images_preloaded_on_all_kata_nodes"] is True
assert kata_delivery["image_pull_secrets"] is False
assert kata_delivery["candidate_selected_image"] is False
assert kata_delivery["capability_reusable"] is False
assert kata_delivery["capability_volume_init_only"] is True
assert kata_delivery["capability_volume_removed_with_pod"] is True
assert kata_delivery["host_path"] is False
assert kata_delivery["persistent_volume"] is False
assert kata_delivery["github_egress"] is False
assert kata_delivery["registry_egress"] is False
assert kata_delivery["proxy_egress"] is False
assert "@sha256:" in kata_delivery["fetcher_image"]
assert "@sha256:" in kata_delivery["bootstrap_image"]
assert "memory emptyDir" in kata_delivery["input_volume"]
assert "main-read-only" in kata_delivery["input_volume"]
assert "memory emptyDir" in kata_delivery["work_volume"]
assert kata_delivery["archive_scan_before_extract"] is True
assert kata_delivery["extraction_location"] == "inside-Kata-/work-only"
assert kata_delivery["exec_started_only_after_verified_extract"] is True
assert kata_delivery["rejects_archive_entries"] == [
    "absolute",
    "dot-dot",
    "backslash",
    "control-character",
    "duplicate",
    "hardlink",
    "symlink",
    "device",
    "fifo",
    "sparse",
    "extension-header",
]
candidate_identity = kata_delivery["capability_identity"]
assert candidate_identity["mechanism"] == (
    "projected-bound-service-account-token"
)
assert candidate_identity["audience"] == "artifact-capability-candidate-read"
assert candidate_identity["expiration_seconds"] == 300
assert candidate_identity["token_request_bound_object"] == "Pod"
assert candidate_identity["projected_token_mode"] == "0400"
assert candidate_identity["projected_token_path"] == (
    "/var/run/secrets/codicarium/candidate-read/token"
)
assert candidate_identity["broker_ca_mode"] == "0400"
assert candidate_identity["broker_ca_path"] == (
    "/var/run/secrets/codicarium/candidate-read/ca.crt"
)
assert candidate_identity["automount_default_token"] is False
assert candidate_identity["kubernetes_api_audience"] is False
assert candidate_identity["egress_proxy_audience"] is False
assert candidate_identity["token_review_required"] is True
assert candidate_identity["live_source_pod_match_required"] is True
assert candidate_identity["one_object_digest_grant_registered_by_control"] is True
assert candidate_identity["bound_claims"] == [
    "token_jti",
    "namespace",
    "serviceaccount.name",
    "serviceaccount.uid",
    "pod.name",
    "pod.uid",
]
assert candidate_identity["deleted_pod_expired_or_replayed"] == "DENY"


def validate_kubernetes_identity_verifier(
    verifier, expected_name, service_account_namespace, service_account_name, pod_namespaces
):
    service_account = f"{service_account_namespace}/{service_account_name}"
    assert verifier["schema"] == (
        "codicarium.kubernetes-tokenreview-pod-verifier/v1"
    )
    assert verifier["name"] == expected_name
    assert verifier["service_account"] == {
        "namespace": service_account_namespace,
        "name": service_account_name,
    }
    assert verifier["api_client_identity"] == {
        "automount_service_account_token": False,
        "mechanism": "projected-bound-service-account-token",
        "audience": "https://kubernetes.default.svc",
        "expiration_seconds": 600,
        "bound_object": "Pod",
        "path": "/var/run/secrets/codicarium/kubernetes-api/token",
        "mode": "0400",
        "tokenrequest_api_permission": False,
    }
    assert verifier["tokenreview_cluster_role"] == {
        "name": f"{expected_name}-tokenreview",
        "rules": [
            {
                "api_groups": ["authentication.k8s.io"],
                "resources": ["tokenreviews"],
                "verbs": ["create"],
            }
        ],
    }
    assert verifier["tokenreview_cluster_role_binding"] == {
        "name": f"{expected_name}-tokenreview",
        "service_account": service_account,
    }
    assert verifier["pod_namespace_roles"] == [
        {
            "namespace": namespace,
            "role": f"{expected_name}-pod-identity",
            "rules": [
                {
                    "api_groups": [""],
                    "resources": ["pods"],
                    "verbs": ["get", "list", "watch"],
                }
            ],
            "role_binding": f"{expected_name}-pod-identity",
            "bound_service_account": service_account,
        }
        for namespace in pod_namespaces
    ]
    assert verifier["forbidden_rbac"] == {
        "rbac_rules_exact_set": True,
        "secret_access": False,
        "tokenrequest_create": False,
        "pod_exec_attach_or_log_access": False,
        "pod_mutation": False,
        "wildcard_api_groups_resources_or_verbs": False,
    }
    assert verifier["authorization_inventory"] == {
        "exact_subject": (
            "system:serviceaccount:"
            + service_account_namespace
            + ":"
            + service_account_name
        ),
        "no_other_role_or_cluster_role_binding_subject_references": True,
        "self_subject_rules_review_exact_match": True,
        "status": "REQUIRED_PREACTIVATION_LIVE_EVIDENCE",
    }
    kubernetes_service = kube_fixture["kubernetes_service"]
    assert verifier["kubernetes_api_egress"] == {
        "kube_context_binding_sha256": sha256(jcs(kube_fixture)),
        "service_discovery_command": kubernetes_service["discovery_command"],
        "service_namespace": "default",
        "service_name": "kubernetes",
        "destination_cidr": "10.43.0.1/32",
        "endpoint": "https://10.43.0.1:443",
        "protocol": "TCP",
        "port": 443,
        "accepted_audience": "https://kubernetes.default.svc",
        "accepted_audience_status": (
            "REQUIRED_PREACTIVATION_TOKENREVIEW_PROBE"
        ),
        "ca_path": "/var/run/secrets/codicarium/kubernetes-api/ca.crt",
        "ca_pem_sha256": kube_fixture["ca_pem_sha256"],
        "certificate_dns_san": "kubernetes.default.svc",
        "tls_san_status": "REQUIRED_PREACTIVATION_TLS_PROBE",
        "tls_verify": True,
        "network_policy_default_deny": True,
        "other_api_destination_or_port_allowed": False,
    }


candidate_identity_verifier = broker_delivery["candidate_identity_verifier"]
validate_kubernetes_identity_verifier(
    candidate_identity_verifier,
    "artifact-capability-candidate-identity-verifier",
    "artifact-capability",
    "artifact-capability",
    ["arc-runners-v2-untrusted"],
)
teardown = delivery["teardown"]
assert teardown["applies_after_success_or_failure"] is True
for absent_field in [
    "job_absent",
    "pod_absent",
    "projected_token_volume_absent",
    "broker_object_absent",
    "input_and_work_volumes_absent",
    "exec_marker_absent_on_verification_failure",
]:
    assert teardown[absent_field] is True
assert teardown["broker_get_after_teardown_status"] == 410
assert delivery["negative_outcome"] == {
    "exec_started": False,
    "publication_mutations": 0,
    "broker_read_committed": False,
    "job_pod_token_object_and_memory_volumes_absent": True,
}


def assert_network_mutation_rejected(mutator, label):
    altered = copy.deepcopy(network_fixture)
    mutator(altered)
    assert list(Draft202012Validator(network_schema).iter_errors(altered)), label


for mutator, label in [
    (lambda item: item["candidate"]["input_delivery"].update({"repository_id": "1"}), "candidate repository"),
    (lambda item: item["candidate"]["input_delivery"].update({"commit_sha": sha256(b"wrong-input")[:40]}), "candidate commit"),
    (lambda item: item["candidate"]["input_delivery"].update({"source_url": "https://example.invalid/source.tar.gz"}), "candidate URL"),
    (lambda item: item["candidate"]["input_delivery"].update({"object_key": "candidate-inputs/substituted.tar.gz"}), "candidate object key"),
    (lambda item: item["candidate"]["input_delivery"].update({"archive_sha256": sha256(b"substituted-bytes")}), "candidate digest"),
    (lambda item: item["candidate"]["input_delivery"].update({"byte_length": "8193"}), "candidate length"),
    (lambda item: item["candidate"]["input_delivery"].update({"content_type": "application/octet-stream"}), "candidate content type"),
    (lambda item: item["candidate"]["input_delivery"]["broker"].update({"purpose": "other"}), "candidate purpose"),
    (lambda item: item["candidate"]["input_delivery"]["broker"].update({"one_time": False}), "candidate one-time"),
    (lambda item: item["candidate"]["input_delivery"]["kata"]["capability_identity"].update({"audience": "kubernetes.default.svc"}), "candidate token audience"),
    (lambda item: item["candidate"]["input_delivery"]["kata"]["capability_identity"]["bound_claims"].remove("pod.uid"), "candidate Pod UID binding"),
    (lambda item: item["candidate"]["input_delivery"]["kata"]["capability_identity"].update({"live_source_pod_match_required": False}), "candidate live Pod binding"),
    (lambda item: item["candidate"]["input_delivery"]["broker"].update({"read_replay_status": 200}), "candidate token replay"),
    (lambda item: item["candidate"]["input_delivery"]["broker"].update({"conflict_status": 200}), "candidate immutable conflict"),
    (lambda item: item["candidate"]["input_delivery"]["broker"].update({"mismatch_status": 200}), "candidate immutable mismatch"),
    (lambda item: item["candidate"]["input_delivery"]["broker"].update({"cross_digest_status": 200}), "candidate cross-digest token"),
    (lambda item: item["candidate"]["input_delivery"]["control"].update({"fetch_mode": "archive-parser"}), "control archive parse"),
    (lambda item: item["candidate"]["input_delivery"]["control"].update({"extracts_archive": True}), "control archive extract"),
    (lambda item: item["candidate"]["input_delivery"]["control"].update({"executes_archive": True}), "control archive execution"),
    (lambda item: item["candidate"]["input_delivery"]["control"].update({"child_execve_allowed": True}), "control execve"),
    (lambda item: item["candidate"]["input_delivery"]["teardown"].update({"broker_object_absent": False}), "candidate teardown"),
]:
    assert_network_mutation_rejected(mutator, label)

for archive_entry_category in kata_delivery["rejects_archive_entries"]:
    assert_network_mutation_rejected(
        lambda item, category=archive_entry_category: item["candidate"][
            "input_delivery"
        ]["kata"]["rejects_archive_entries"].remove(category),
        f"candidate archive category {archive_entry_category}",
    )

for teardown_field in [
    "job_absent",
    "pod_absent",
    "projected_token_volume_absent",
    "broker_object_absent",
    "input_and_work_volumes_absent",
    "exec_marker_absent_on_verification_failure",
]:
    assert_network_mutation_rejected(
        lambda item, field=teardown_field: item["candidate"]["input_delivery"][
            "teardown"
        ].update({field: False}),
        f"candidate residue {teardown_field}",
    )
assert_network_mutation_rejected(
    lambda item: item["candidate"]["input_delivery"]["teardown"].update(
        {"broker_get_after_teardown_status": 200}
    ),
    "candidate broker object readable after teardown",
)
assert_network_mutation_rejected(
    lambda item: item["candidate"]["input_delivery"]["teardown"].update(
        {"applies_after_success_or_failure": False}
    ),
    "candidate failure-path teardown",
)
for outcome_field, wrong_value in [
    ("exec_started", True),
    ("publication_mutations", 1),
    ("broker_read_committed", True),
    ("job_pod_token_object_and_memory_volumes_absent", False),
]:
    assert_network_mutation_rejected(
        lambda item, field=outcome_field, value=wrong_value: item["candidate"][
            "input_delivery"
        ]["negative_outcome"].update({field: value}),
        f"candidate rejection side effect {outcome_field}",
    )

for binding_list in [
    "create_request_binds",
    "create_receipt_echoes",
]:
    for binding_field in candidate_object_binding_fields:
        assert_network_mutation_rejected(
            lambda item, list_name=binding_list, field=binding_field: item[
                "candidate"
            ]["input_delivery"]["broker"][list_name].remove(field),
            f"candidate {binding_list} missing {binding_field}",
        )
for binding_field in broker_delivery["read_capability_binds"]:
    assert_network_mutation_rejected(
        lambda item, field=binding_field: item["candidate"]["input_delivery"][
            "broker"
        ]["read_capability_binds"].remove(field),
        f"candidate read capability missing {binding_field}",
    )


def assert_candidate_archive_oracle_rejected(mutator, label):
    altered = copy.deepcopy(delivery)
    mutator(altered)
    try:
        validate_candidate_archive_oracle(altered)
    except (AssertionError, KeyError, TypeError, ValueError):
        return
    raise AssertionError(f"{label}: invalid candidate archive oracle accepted")


substituted_candidate_bytes = bytearray(candidate_archive_bytes)
substituted_candidate_bytes[-1] ^= 1
for mutator, label in [
    (
        lambda item: item.update(
            {
                "archive_bytes_base64": base64.b64encode(
                    bytes(substituted_candidate_bytes)
                ).decode("ascii")
            }
        ),
        "returned candidate byte mismatch",
    ),
    (
        lambda item: item.update({"archive_sha256": sha256(b"wrong-archive")}),
        "candidate archive digest mismatch",
    ),
    (
        lambda item: item.update({"byte_length": str(len(candidate_archive_bytes) + 1)}),
        "candidate archive length mismatch",
    ),
    (
        lambda item: item.update(
            {"uncompressed_tar_sha256": sha256(b"wrong-candidate-tar")}
        ),
        "candidate tar digest mismatch",
    ),
    (
        lambda item: item.update(
            {"uncompressed_tar_byte_length": str(len(candidate_tar_bytes) + 1)}
        ),
        "candidate tar length mismatch",
    ),
    (
        lambda item: item.update({"archive_bytes_live_codeload_response": True}),
        "synthetic archive asserted live",
    ),
    (
        lambda item: item.update({"archive_bytes_evidence_class": "live"}),
        "synthetic archive evidence class",
    ),
]:
    assert_candidate_archive_oracle_rejected(mutator, label)

for live_requirement in [
    "fetch_exact_raw_response_bytes",
    "compute_archive_sha256_and_byte_length_from_raw_response",
    "fixture_archive_bytes_forbidden",
    "verify_repository_commit_and_response_before_broker_create",
    "persist_create_receipt_and_one_read_binding",
]:
    assert_network_mutation_rejected(
        lambda item, field=live_requirement: item["candidate"]["input_delivery"][
            "live_delivery_requirements"
        ].update({field: False}),
        f"candidate live replacement requirement {live_requirement}",
    )

# The proxy authenticates projected Pod-bound tokens with TokenReview and exact
# listener principals/ACLs. NetworkPolicy remains transport confinement only.
proxy_identity = network_fixture["proxies"]["identity_authentication"]
assert proxy_identity["schema"] == "codicarium.egress-proxy-identity/v1"
assert proxy_identity["mode"] == "projected-bound-service-account-token"
assert proxy_identity["audience"] == "codicarium-egress-proxy"
assert proxy_identity["expiration_seconds"] == 600
assert proxy_identity["tls_only"] is True
assert proxy_identity["token_review"] == {
    "api_version": "authentication.k8s.io/v1",
    "required_audience": "codicarium-egress-proxy",
    "require_authenticated": True,
    "error_timeout_or_unauthenticated": "DENY_NO_UPSTREAM",
}
assert proxy_identity["bound_claims"] == [
    "sub",
    "kubernetes.io.namespace",
    "kubernetes.io.serviceaccount.name",
    "kubernetes.io.serviceaccount.uid",
    "kubernetes.io.pod.name",
    "kubernetes.io.pod.uid",
]
assert proxy_identity["server_certificate"] == {
    "dns_san": "codicarium-private-egress-proxy.platform-egress.svc",
    "duration_hours": 24,
    "renew_before_hours": 8,
    "plaintext_listener": False,
}
assert proxy_identity["rotation"] == {
    "refresh_before_expiry_seconds": 120,
    "reject_expired": True,
    "delete_with_pod": True,
}
assert proxy_identity["replay"] == {
    "request_nonce_header": "X-Codicarium-Proxy-Request-Nonce",
    "duplicate_nonce": "DENY_NO_UPSTREAM",
    "different_or_recreated_pod": "DENY_NO_UPSTREAM",
    "token_jti_pod_uid_cache_seconds_max": 60,
    "same_live_pod_unique_nonce_reuse_until_expiry": True,
}
assert proxy_identity["candidate_projection"] is False
assert proxy_identity["network_policy_role"] == (
    "transport-confinement-only-not-identity-proof"
)
assert "live Pod" in proxy_identity["source_pod_check"]
assert proxy_identity["replay"]["duplicate_nonce"] == "DENY_NO_UPSTREAM"
assert proxy_identity["replay"]["different_or_recreated_pod"] == (
    "DENY_NO_UPSTREAM"
)
control_proxy_binding = proxy_identity["bindings"]["8443"]
broker_proxy_binding = proxy_identity["bindings"]["8444"]
assert network_fixture["trusted_control"]["proxy_identity"] == control_proxy_binding
assert network_fixture["broker"]["proxy_identity"] == broker_proxy_binding
for listener, binding, expected_namespace, expected_sa in [
    ("8443", control_proxy_binding, "arc-runners-v2-control", "release-control"),
    ("8444", broker_proxy_binding, "artifact-capability", "artifact-capability"),
]:
    assert binding["namespace"] == expected_namespace
    assert binding["service_account"] == expected_sa
    assert binding["automount_service_account_token"] is False
    assert binding["projected_token"] == {
        "audience": "codicarium-egress-proxy",
        "expiration_seconds": 600,
        "path": "/var/run/secrets/codicarium/proxy/token",
        "mode": "0400",
        "bound_object": "Pod",
    }
    assert proxy_identity["listeners"][listener]["principal"] == binding["username"]
assert proxy_identity["listeners"]["8443"]["host_methods"] == {
    "api.github.com": ["GET", "POST"],
    "codeload.github.com": ["GET"],
    "github.com": ["GET"],
    "objects.githubusercontent.com": ["GET"],
    "raw.githubusercontent.com": ["GET"],
    "release-assets.githubusercontent.com": ["GET"],
}
assert proxy_identity["listeners"]["8444"]["host_methods"] == {
    "s3.sbg.io.cloud.ovh.net": ["GET", "HEAD", "PUT"],
    "token.actions.githubusercontent.com": ["GET"],
}
assert proxy_identity["listener_host_method_confusion"] == "DENY_BEFORE_UPSTREAM"
assert proxy_identity["direct_upstream_or_proxy_bypass"] is False
assert proxy_identity["negative_outcome"] == {
    "upstream_requests": 0,
    "dns_connection_and_http_forwarding": False,
}
assert proxy_identity["negative_cases"] == [
    "wrong-namespace-service-account-or-username",
    "pod-uid-name-namespace-or-source-ip-mismatch",
    "wrong-audience-expired-rotated-or-replayed-token",
    "tokenreview-error-timeout-or-unauthenticated",
    "plaintext-listener",
    "listener-host-or-method-confusion",
    "direct-upstream-or-proxy-bypass",
]
proxy_identity_verifier = proxy_identity["identity_verifier"]
validate_kubernetes_identity_verifier(
    proxy_identity_verifier,
    "codicarium-egress-proxy-identity-verifier",
    "platform-egress",
    "codicarium-private-egress-proxy",
    ["arc-runners-v2-control", "artifact-capability"],
)


def nested_value(value, path):
    for key in path:
        value = value[key]
    return value


verifier_paths = {
    "broker": (
        "candidate",
        "input_delivery",
        "broker",
        "candidate_identity_verifier",
    ),
    "proxy": ("proxies", "identity_authentication", "identity_verifier"),
}
verifier_negative_mutators = [
    (
        lambda verifier: verifier["service_account"].update({"name": "wrong"}),
        "service account",
    ),
    (
        lambda verifier: verifier["api_client_identity"].update(
            {"audience": "https://wrong.invalid"}
        ),
        "projected API audience",
    ),
    (
        lambda verifier: verifier["api_client_identity"].update(
            {"tokenrequest_api_permission": True}
        ),
        "TokenRequest permission",
    ),
    (
        lambda verifier: verifier["tokenreview_cluster_role"]["rules"][0][
            "verbs"
        ].append("get"),
        "broader TokenReview verb",
    ),
    (
        lambda verifier: verifier["tokenreview_cluster_role"]["rules"][0].update(
            {"resources": ["secrets"]}
        ),
        "broader TokenReview resource",
    ),
    (
        lambda verifier: verifier["pod_namespace_roles"][0].update(
            {"namespace": "default"}
        ),
        "broader Pod namespace",
    ),
    (
        lambda verifier: verifier["pod_namespace_roles"][0]["rules"][0][
            "verbs"
        ].append("create"),
        "Pod mutation verb",
    ),
    (
        lambda verifier: verifier["pod_namespace_roles"][0]["rules"][0].update(
            {"resources": ["pods", "secrets"]}
        ),
        "Pod Role secret resource",
    ),
    (
        lambda verifier: verifier["pod_namespace_roles"].append(
            copy.deepcopy(verifier["pod_namespace_roles"][0])
        ),
        "extra RoleBinding",
    ),
    (
        lambda verifier: verifier["forbidden_rbac"].update(
            {"wildcard_api_groups_resources_or_verbs": True}
        ),
        "wildcard RBAC",
    ),
    (
        lambda verifier: verifier["authorization_inventory"].update(
            {"no_other_role_or_cluster_role_binding_subject_references": False}
        ),
        "extra binding inventory",
    ),
    (
        lambda verifier: verifier["authorization_inventory"].pop("status"),
        "missing authorization inventory proof",
    ),
    (
        lambda verifier: verifier["kubernetes_api_egress"].update(
            {"kube_context_binding_sha256": sha256(b"wrong-context")}
        ),
        "Kubernetes context digest",
    ),
    (
        lambda verifier: verifier["kubernetes_api_egress"].update(
            {"destination_cidr": "10.43.0.0/16"}
        ),
        "Kubernetes API destination CIDR",
    ),
    (
        lambda verifier: verifier["kubernetes_api_egress"].update(
            {"endpoint": "https://10.43.0.2:443"}
        ),
        "Kubernetes API endpoint",
    ),
    (
        lambda verifier: verifier["kubernetes_api_egress"].update({"port": 6443}),
        "Kubernetes API port",
    ),
    (
        lambda verifier: verifier["kubernetes_api_egress"].update(
            {"accepted_audience": "kubernetes.default.svc"}
        ),
        "Kubernetes API accepted audience",
    ),
    (
        lambda verifier: verifier["kubernetes_api_egress"].update(
            {"ca_pem_sha256": sha256(b"wrong-api-ca")}
        ),
        "Kubernetes API CA",
    ),
    (
        lambda verifier: verifier["kubernetes_api_egress"].update(
            {"certificate_dns_san": "wrong.default.svc"}
        ),
        "Kubernetes API SAN",
    ),
    (
        lambda verifier: verifier["kubernetes_api_egress"].update(
            {"tls_verify": False}
        ),
        "Kubernetes API TLS verification",
    ),
    (
        lambda verifier: verifier["kubernetes_api_egress"].update(
            {"other_api_destination_or_port_allowed": True}
        ),
        "other Kubernetes API destination",
    ),
]
for verifier_label, verifier_path in verifier_paths.items():
    for verifier_mutator, negative_label in verifier_negative_mutators:
        assert_network_mutation_rejected(
            lambda item, path=verifier_path, mutator=verifier_mutator: mutator(
                nested_value(item, path)
            ),
            f"{verifier_label} verifier {negative_label}",
        )
for mutator, label in [
    (lambda item: item["proxies"]["identity_authentication"].update({"audience": "wrong"}), "proxy audience"),
    (lambda item: item["proxies"]["identity_authentication"]["bindings"]["8443"].update({"namespace": "wrong"}), "proxy namespace"),
    (lambda item: item["proxies"]["identity_authentication"]["bindings"]["8443"].update({"service_account": "wrong"}), "proxy service account"),
    (lambda item: item["proxies"]["identity_authentication"]["bindings"]["8443"].update({"username": "system:serviceaccount:arc-runners-v2-control:wrong"}), "proxy listener username"),
    (lambda item: item["proxies"]["identity_authentication"]["bindings"]["8443"]["projected_token"].update({"path": "/wrong/token"}), "proxy token path"),
    (lambda item: item["proxies"]["identity_authentication"]["bindings"]["8443"]["projected_token"].update({"mode": "0644"}), "proxy token mode"),
    (lambda item: item["proxies"]["identity_authentication"].update({"source_pod_check": "token only"}), "proxy source Pod"),
    (lambda item: item["proxies"]["identity_authentication"]["bound_claims"].remove("kubernetes.io.pod.uid"), "proxy Pod UID claim"),
    (lambda item: item["proxies"]["identity_authentication"]["bound_claims"].remove("kubernetes.io.pod.name"), "proxy Pod name claim"),
    (lambda item: item["proxies"]["identity_authentication"]["replay"].update({"duplicate_nonce": "ALLOW"}), "proxy replay"),
    (lambda item: item["proxies"]["identity_authentication"]["replay"].update({"different_or_recreated_pod": "ALLOW"}), "proxy recreated Pod"),
    (lambda item: item["proxies"]["identity_authentication"]["replay"].update({"request_nonce_header": "X-Wrong-Nonce"}), "proxy nonce header"),
    (lambda item: item["proxies"]["identity_authentication"]["replay"].update({"token_jti_pod_uid_cache_seconds_max": 601}), "proxy replay cache"),
    (lambda item: item["proxies"]["identity_authentication"]["rotation"].update({"reject_expired": False}), "proxy expired token"),
    (lambda item: item["proxies"]["identity_authentication"]["rotation"].update({"delete_with_pod": False}), "proxy deleted Pod token"),
    (lambda item: item["proxies"]["identity_authentication"]["rotation"].update({"refresh_before_expiry_seconds": 0}), "proxy token rotation"),
    (lambda item: item["proxies"]["identity_authentication"]["token_review"].update({"require_authenticated": False}), "proxy TokenReview authentication"),
    (lambda item: item["proxies"]["identity_authentication"]["token_review"].update({"error_timeout_or_unauthenticated": "ALLOW"}), "proxy TokenReview failure"),
    (lambda item: item["proxies"]["identity_authentication"]["server_certificate"].update({"plaintext_listener": True}), "proxy plaintext"),
    (lambda item: item["proxies"]["identity_authentication"]["listeners"]["8443"].update({"principal": control_proxy_binding["username"] + ":wrong"}), "proxy listener principal"),
    (lambda item: item["proxies"]["identity_authentication"]["listeners"]["8443"]["host_methods"]["api.github.com"].append("PUT"), "proxy method"),
    (lambda item: item["proxies"]["identity_authentication"]["listeners"]["8444"]["host_methods"].update({"api.github.com": ["GET"]}), "proxy listener confusion"),
    (lambda item: item["proxies"]["identity_authentication"].update({"direct_upstream_or_proxy_bypass": True}), "proxy bypass"),
]:
    assert_network_mutation_rejected(mutator, label)

# PostgreSQL accepts only broker/migrator 5432 clients, transfers the CNPG
# runtime-generated bootstrap credential to Vault exactly once, and retires all
# bootstrap/migration authority before runtime activation.
postgres_access = network_fixture["postgres_access"]
assert postgres_access["activation"] == "BLOCKED_PREACTIVATION"
assert postgres_access["database_name"] == "runner_platform_journal"
assert postgres_access["tls_mode"] == "verify-full"
postgres_network = postgres_access["network_policy"]
assert postgres_network["client_ingress_flows"] == flows[-2:]
assert postgres_network["default_deny_all_other_clients"] is True
assert postgres_network["database_pod_ingress_default_deny"] is True
assert postgres_network["database_pod_egress_default_deny"] is True
assert postgres_network["client_pod_egress_default_deny"] is True
assert [flow["purpose"] for flow in postgres_network["preserved_platform_flows"]] == [
    "streaming-replication",
    "cnpg-operator-management",
    "cluster-dns",
    "kubernetes-api",
]
bootstrap_credential = postgres_access["cnpg_bootstrap_credential"]
assert bootstrap_credential["created_by"] == "cloudnative-pg-operator"
assert bootstrap_credential["generated_at_runtime"] is True
assert bootstrap_credential["rendered_by_helm"] is False
assert bootstrap_credential["committed_to_git"] is False
assert bootstrap_credential["external_secret_or_push_secret"] is False
assert bootstrap_credential["exact_reader_service_account"] == (
    "release-journal-bootstrap-transfer"
)
assert bootstrap_credential["exact_namespace"] == "runner-platform-journal-dev"
assert bootstrap_credential["uid_and_resource_version_preconditions_required"] is True
assert bootstrap_credential["projected_volume_mode"] == "0400"
assert bootstrap_credential["read_count"] == 1
assert bootstrap_credential["reusable"] is False
vault_transfer = postgres_access["vault_transfer"]
assert vault_transfer["write_semantics"] == "KV-v2 create-only version 1"
assert vault_transfer["source_secret_uid_and_resource_version_match_required"] is True
assert vault_transfer["memory_only_transfer"] is True
assert vault_transfer["log_or_artifact_value"] is False
assert vault_transfer["delete_kubernetes_secret_after_verified_readback"] is True
assert vault_transfer["prevent_operator_regeneration"] is True
assert postgres_access["database_privileges"] == {
    "public_connect": False,
    "public_temp": False,
    "runtime_connect": True,
    "runtime_temp": False,
    "runtime_schema_usage": True,
    "runtime_schema_create": False,
    "runtime_direct_dml": False,
    "migrator_connect_after_migration": False,
}
assert postgres_access["roles"]["owner"]["login"] is False
assert postgres_access["roles"]["runtime"]["database_temp"] is False
assert postgres_access["roles"]["runtime"]["schema_create"] is False
assert postgres_access["roles"]["runtime"]["direct_table_privileges"] == []
assert postgres_access["roles"]["migrator"]["owner_membership_after_migration"] is False
assert postgres_access["roles"]["migrator"]["login_after_migration"] is False
assert postgres_access["roles"]["migrator"]["connect_after_migration"] is False
assert all(postgres_access["retirement"].values())
assert set(postgres_access["negative_cases"]) >= {
    "unauthorized-client-denied",
    "bootstrap-secret-second-read-denied",
    "bootstrap-secret-regeneration-denied",
    "runtime-direct-dml-denied",
    "runtime-or-public-database-temp-denied",
    "runtime-or-public-schema-create-denied",
    "temp-relation-and-function-shadow-denied",
    "migration-identity-persistence-denied",
    "retired-bootstrap-or-migrator-credential-reuse-denied",
}
for mutator, label in [
    (lambda item: item["postgres_access"]["network_policy"].update({"default_deny_all_other_clients": False}), "postgres unauthorized client"),
    (lambda item: item["postgres_access"]["cnpg_bootstrap_credential"].update({"read_count": 2}), "postgres bootstrap reuse"),
    (lambda item: item["postgres_access"]["cnpg_bootstrap_credential"].update({"reusable": True}), "postgres reusable bootstrap"),
    (lambda item: item["postgres_access"]["vault_transfer"].update({"prevent_operator_regeneration": False}), "postgres bootstrap regeneration"),
    (lambda item: item["postgres_access"]["roles"]["runtime"].update({"direct_table_privileges": ["INSERT"]}), "postgres runtime DML"),
    (lambda item: item["postgres_access"]["roles"]["runtime"].update({"database_temp": True}), "postgres runtime TEMP"),
    (lambda item: item["postgres_access"]["roles"]["migrator"].update({"login_after_migration": True}), "postgres migrator persistence"),
    (lambda item: item["postgres_access"]["retirement"].update({"migration_vault_auth_role_deleted": False}), "postgres migration Vault role"),
]:
    assert_network_mutation_rejected(mutator, label)

# Baselines and current-main focused impact are exact.
assert annex["baselines"] == {
    "codicarium/deployment-controller": "74defd205658b8db4b90a80cc7f8aa05dfe8a193",
    "codicarium/codicarium-actions": "9545b5a66498f67667e57d021507ac060fd016b6",
    "codicarium/runner-config": "9625e442a12c721e89250812f3d079b09833ccb0",
    "codicarium/vault-config": "59b06ef256b5f3a5956f630240e95f00b22a9d07",
    "codicarium/app-config": "e085a399bedc830b537431e3bcd5e41b677c2812",
    "codicarium/infra": "40073c068a9cf8ff4c1e625b97e09fda31b40637",
    "codicarium/postgres-config": "d5ccccfcfc5bae4d099f1848b68e07dcaa679d62",
}
impact = annex["current_main_focused_impact"]
assert impact["deployment_controller_103"]["choice"] == (
    "runner-config-dev remains dev/event-driven"
)
assert impact["vault_config_258"]["evidence_schema"] == "2"
live_authority_contract = annex["live_authority_contract"]
assert live_authority_contract["status"] == (
    "PENDING_PROTECTED_MERGE_DISCOVERY"
)
assert live_authority_contract["schema_file"] == (
    "fixtures-v2.0/release-live-implementation-identity-v1.schema.json"
)
assert live_authority_contract["positive_live_identity_fixture_present"] is False
assert live_authority_contract["synthetic_fixture"] == {
    **FIXTURE_AUTHORITY_MARKER,
    "fixture_identity_jcs_sha256": claim_identity_digest,
}
assert live_authority_contract["required_live_evidence_class"] == (
    "live-protected-authority"
)
assert live_authority_contract["required_publication_authority"] is True
assert set(live_authority_contract["prohibited_live_inputs"]) == {
    "synthetic candidate source SHA",
    "synthetic reviewed workflow SHA",
    "fixture identity digest",
    "fixture Ed25519 signing kid",
}
assert live_authority_contract["negative_outcome"] == {
    "claim_creates": 0,
    "dispatches": 0,
    "journal_commits": 0,
    "publication_mutations": 0,
}
assert annex["journal_contract"]["live_status"] == "PREACTIVATION_NOT_MATERIALIZED"
assert "never S3" in annex["journal_contract"]["authority"]
assert annex["journal_contract"]["forbidden_endpoints"] == ["update", "delete"]
assert annex["journal_contract"]["procedure_execution_authority"] is False
assert annex["journal_contract"]["procedure_activation_status"] == (
    "BLOCKED_PREACTIVATION_FAIL_CLOSED"
)
assert annex["journal_contract"]["protocol_model_fixture_entries"] == 45
assert "NOLOGIN" in annex["journal_contract"]["database_roles"]["owner"]
assert "not owner" in annex["journal_contract"]["database_roles"]["runtime"]
assert "pg_catalog, release_journal, pg_temp" in annex["journal_contract"][
    "function_resolution"
]
assert annex["journal_contract"]["temp_shadow_attack_vector"] == temp_shadow
assert annex["raw_identity_contract"] == {
    "authority": False,
    "purpose": "byte-regression-only",
    "fixture": identity_metadata,
}
assert annex["candidate_input_delivery"] == delivery
assert annex["proxy_identity_contract"] == proxy_identity
assert annex["postgres_access_contract"] == postgres_access
assert annex["service_runtime"]["postgres_access"] == postgres_access
assert len(annex["service_runtime"]["activation_blockers"]) == 7
assert any(
    "replace fail-closed journal procedure stubs" in blocker
    for blocker in annex["service_runtime"]["activation_blockers"]
)
assert annex["postgres_gitops"] == {
    "repository_id": "1285126920",
    "profile": "postgres-config-dev-path-helm",
    "grant": "postgres-config-dev",
    "app_project": "repo-postgres-config-dev",
    "activation_label": "post-retirement",
    "component_id": "runner-platform-journal",
    "application_name": "runner-platform-journal-dev",
    "chart_path": "charts/postgres-platform",
    "release_name": "runner-platform-journal",
    "destination_namespace": "runner-platform-journal-dev",
    "values_file": ".codicarium/dev/values.yaml",
    "cnpg_cluster": "runner-platform-journal",
    "desired_endpoint": (
        "runner-platform-journal-rw.runner-platform-journal-dev.svc.cluster.local:5432"
    ),
    "namespace_owner": "central platform; namespace.create=false",
    "exact_profile_resources": [
        "networking.k8s.io/NetworkPolicy",
        "postgresql.cnpg.io/Cluster",
    ],
    "forbidden_rendered_resources": [
        "Namespace",
        "ExternalSecret",
        "PushSecret",
        "plaintext Secret",
    ],
    "required_values": [
        "externalSecrets.enabled=false",
        "no Bitwarden",
        "immutable PostgreSQL image",
        "ceph-rbd-replicated storage",
        "dedicated runtime/migrator roles",
        "verify-full TLS",
        "synchronous replicas/N-1",
    ],
    "access_bootstrap_contract": postgres_access,
}

# Manifest is exact-set, traversal-safe, and independently hashed.
manifest = annex["files"]
assert len(manifest) == EXPECTED_MANIFEST_FILES
assert EXPECTED_MANIFEST_FILES > 0
assert len({entry["path"] for entry in manifest}) == EXPECTED_MANIFEST_FILES
manifest_paths = []
for entry in manifest:
    relative = pathlib.PurePosixPath(entry["path"])
    assert not relative.is_absolute() and ".." not in relative.parts
    path = RUN / relative
    data = path.read_bytes()
    assert len(data) == entry["byte_length"], entry["path"]
    assert sha256(data) == entry["sha256"], entry["path"]
    manifest_paths.append(entry["path"])
actual_fixture_paths = sorted(
    path.relative_to(RUN).as_posix()
    for path in FIXTURES.rglob("*")
    if path.is_file()
)
assert sorted(manifest_paths) == actual_fixture_paths

counts = annex["fixture_counts"]
assert counts == {
    "manifest_files": 36,
    "draft_2020_12_schemas": 13,
    "raw_identity_positive_vectors": 2,
    "raw_identity_negative_vectors": 6,
    "claim_cas_vectors": 4,
    "journal_entries": 45,
    "journal_operation_evidence": 22,
    "signed_publication_receipts": 20,
    "publisher_mutations": 19,
    "protected_checks": 5,
    "retired_workflows": 5,
    "release_assets": 14,
}
assert all(isinstance(value, int) and value > 0 for value in counts.values())

# Archive bytes remain the exact immutable v1.9 oracles.
tar_path = FIXTURES / "canonical-archive-v1.tar"
zstd_path = FIXTURES / "canonical-archive-v1.tar.zst"
tar_bytes = tar_path.read_bytes()
zstd_bytes = zstd_path.read_bytes()
assert len(tar_bytes) == 3072
assert sha256(tar_bytes) == (
    "fb7a260f46a361d9b90bf6371824f0b62dcabf99be09ab984a4fb6fcaeebda31"
)
assert len(zstd_bytes) == 102
assert sha256(zstd_bytes) == (
    "5858457a000d6f7334053b51ba4f1106f1ee1e683ffc6bcf461af0fe9b3dc64b"
)
decompressed = subprocess.run(
    ["zstd", "-q", "-d", "-c", str(zstd_path)],
    check=True,
    capture_output=True,
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

# Traceability is exact, total, and tied to the final annex hash.
annex_sha = sha256(ANNEX.read_bytes())
assert annex_sha in SPEC.read_text(encoding="utf-8")
assert spec["meta"]["version"] == "2.0.0-exact-candidate"
assert len(spec["requirements"]) == EXPECTED_REQUIREMENTS
assert len(spec["acceptance_criteria"]) == EXPECTED_ACCEPTANCE
assert len(spec["test_plan"]) == EXPECTED_TESTS
assert len(spec["traceability"]) == EXPECTED_REQUIREMENTS
requirement_ids = {item["id"] for item in spec["requirements"]}
acceptance_ids = {item["id"] for item in spec["acceptance_criteria"]}
test_ids = {item["id"] for item in spec["test_plan"]}
assert requirement_ids == {
    f"REQ-{index:03d}" for index in range(1, EXPECTED_REQUIREMENTS + 1)
}
assert acceptance_ids == {
    f"AC-{index:03d}" for index in range(1, EXPECTED_ACCEPTANCE + 1)
}
assert test_ids == {f"TST-{index:03d}" for index in range(1, EXPECTED_TESTS + 1)}
trace_ids = {item["requirement_id"] for item in spec["traceability"]}
assert trace_ids == requirement_ids
for row in spec["traceability"]:
    assert row["acceptance_ids"]
    assert row["test_ids"]
    assert set(row["acceptance_ids"]).issubset(acceptance_ids)
    assert set(row["test_ids"]).issubset(test_ids)
    assert annex_sha in row["review_checks"][0]
for criterion in spec["acceptance_criteria"]:
    assert all(word in criterion["scenario"] for word in ["Given", "When", "Then"])

protected_gate = annex["protected_gate"]
assert protected_gate == {
    "check_names": ["chart", "integration", "lint", "supply-chain", "test"],
    "app_id": "15368",
    "same_current_head": True,
    "repository_self_authorization": False,
}
follow_up = parsed[FIXTURES / "follow-up-order-v1.json"]["total_order"]
assert follow_up.index("issue-98-new-workflow-id-v0.6.8-one-target-broker-recovery-success") < follow_up.index(
    "pr-99-merged"
)
assert follow_up.index("pr-99-merged") < follow_up.index("pr-94-merged")
assert "never restore five old workflows" in annex["rollback"]
assert annex["forward_only"]["next"] == "v0.6.14"
assert annex["forward_only"]["retag_or_resume_allowed"] is False

assert spec_check["ok"] is True
assert spec_check["errors"] == []
assert spec_check["warnings"] == []

print(
    json.dumps(
        {
            "ok": True,
            "activation_status": network_fixture["activation"],
            "preactivation_blockers": len(
                annex["service_runtime"]["activation_blockers"]
            ),
            "json_documents_without_duplicate_keys": len(json_paths),
            "draft_2020_12_schemas": len(schemas),
            "positive_schema_validations": schema_validation_count,
            "verified_ed25519_signatures": verified_signatures,
            "journal_entries": len(records),
            "journal_operation_evidence": len(operations),
            "signed_publication_receipts": len(publication_receipts),
            "publisher_mutations": len(mutation_receipts),
            "retired_workflows": len(retirement_fixture["workflows"]),
            "manifest_files": len(manifest),
            "requirements_traced": len(spec["traceability"]),
            "raw_handoff_sha256": sha256(handoff_raw),
            "raw_dispatch_sha256": sha256(publisher_dispatch_raw),
            "canonical_tar_sha256": sha256(tar_bytes),
            "canonical_zstd_sha256": sha256(zstd_bytes),
            "annex_sha256": annex_sha,
            "spec_sha256": sha256(SPEC.read_bytes()),
        },
        indent=2,
    )
)
