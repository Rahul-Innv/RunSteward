"""Deterministic offline contract, fixture, and receipt verification for RunSteward."""
from __future__ import annotations

import hashlib
import json
import re
import copy
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource


ROOT = Path.cwd()
SCHEMA_ROOT = ROOT / "contracts" / "runsteward" / "v1"
FIXTURE_ROOT = ROOT / "contracts" / "fixtures"


def configure_root(root: Path) -> None:
    """Point the verifier at a repository checkout root."""
    global ROOT, SCHEMA_ROOT, FIXTURE_ROOT
    ROOT = Path(root).resolve()
    SCHEMA_ROOT = ROOT / "contracts" / "runsteward" / "v1"
    FIXTURE_ROOT = ROOT / "contracts" / "fixtures"
KEY_PATTERN = re.compile(r"^[A-Za-z_$][A-Za-z0-9_.:$-]*$")
SAFE_INTEGER = 9_007_199_254_740_991


def read_json(path: Path) -> Any:
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raise AssertionError(f"UTF-8 BOM is forbidden: {path}")
    return json.loads(raw.decode("utf-8", errors="strict"))


def _parse_runsteward_int(token: str) -> int:
    if token == "-0":
        raise ValueError("RunSteward v1 forbids the raw JSON integer token -0")
    value = int(token)
    if abs(value) > SAFE_INTEGER:
        raise ValueError("RunSteward v1 integer exceeds the safe domain")
    return value


def parse_runsteward_json(text: str) -> Any:
    def reject_constant(token: str) -> Any:
        raise ValueError(f"RunSteward v1 forbids non-finite token {token}")

    value = json.loads(text, parse_int=_parse_runsteward_int, parse_constant=reject_constant)
    _assert_runsteward_domain(value)
    return value


def read_runsteward_json(path: Path) -> Any:
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        raise AssertionError(f"UTF-8 BOM is forbidden: {path}")
    return parse_runsteward_json(raw.decode("utf-8", errors="strict"))


def _assert_scalar_string(value: str, label: str) -> None:
    if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
        raise AssertionError(f"{label} contains an unpaired surrogate")


def _assert_runsteward_domain(value: Any, label: str = "$") -> None:
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, str):
        _assert_scalar_string(value, label)
        return
    if isinstance(value, int):
        if abs(value) > SAFE_INTEGER:
            raise AssertionError(f"{label} exceeds the safe integer domain")
        return
    if isinstance(value, float):
        raise AssertionError(f"{label} contains a float outside the RunSteward v1 domain")
    if isinstance(value, list):
        for index, item in enumerate(value):
            _assert_runsteward_domain(item, f"{label}[{index}]")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or KEY_PATTERN.fullmatch(key) is None:
                raise AssertionError(f"{label} has a key outside the ASCII contract domain: {key!r}")
            _assert_runsteward_domain(item, f"{label}.{key}")
        return
    raise AssertionError(f"{label} contains unsupported type {type(value).__name__}")


def canonical_runsteward(value: Any) -> str:
    _assert_runsteward_domain(value)
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def runsteward_digest(value: Any) -> str:
    payload = canonical_runsteward(value).encode("utf-8")
    return f"sha256:{hashlib.sha256(payload).hexdigest()}"


def choicegate_native_digest(receipt: dict[str, Any]) -> str:
    body = {key: value for key, value in receipt.items() if key != "receipt_sha256"}
    payload = json.dumps(
        body,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def normalized_utf8_lf_sha256(path: Path) -> str:
    text = path.read_bytes().decode("utf-8", errors="strict")
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def build_schema_registry() -> tuple[dict[str, dict[str, Any]], Registry]:
    schemas: dict[str, dict[str, Any]] = {}
    registry = Registry()
    for path in sorted(SCHEMA_ROOT.glob("*.schema.json")):
        schema = read_runsteward_json(path)
        Draft202012Validator.check_schema(schema)
        schemas[path.name] = schema
        registry = registry.with_resource(schema["$id"], Resource.from_contents(schema))
    return schemas, registry


def verify_schema_fixtures() -> tuple[int, int]:
    schemas, registry = build_schema_registry()
    manifest = read_runsteward_json(FIXTURE_ROOT / "manifest.json")
    valid_count = 0
    invalid_count = 0
    for fixture in manifest["valid"]:
        instance = read_runsteward_json(ROOT / fixture["path"])
        validator = Draft202012Validator(
            schemas[fixture["schema"]],
            registry=registry,
            format_checker=FormatChecker(),
        )
        validator.validate(instance)
        valid_count += 1
    for fixture in manifest["invalid"]:
        try:
            instance = read_runsteward_json(ROOT / fixture["path"])
        except (AssertionError, ValueError):
            invalid_count += 1
            continue
        validator = Draft202012Validator(
            schemas[fixture["schema"]],
            registry=registry,
            format_checker=FormatChecker(),
        )
        errors = list(validator.iter_errors(instance))
        if not errors:
            raise AssertionError(f"invalid fixture unexpectedly passed: {fixture['path']}")
        invalid_count += 1
    event_validator = Draft202012Validator(
        schemas["state-event.schema.json"], registry=registry, format_checker=FormatChecker()
    )
    for chain in manifest["event_chains"]:
        if "chain_path" not in chain:
            continue
        wrapper = read_runsteward_json(ROOT / chain["chain_path"])
        if wrapper.get("chain_id") != chain["chain_id"] or not isinstance(wrapper.get("events"), list):
            raise AssertionError(f"invalid event chain wrapper: {chain['chain_id']}")
        for event in wrapper["events"]:
            event_validator.validate(event)
    return valid_count, invalid_count


def verify_runsteward_vectors() -> int:
    document = read_runsteward_json(FIXTURE_ROOT / "hash-vectors" / "runsteward-canonical-json-v1.json")
    if document["algorithm"] != "runsteward-canonical-json-sha256-v1":
        raise AssertionError("unexpected RunSteward canonical algorithm")
    for vector in document["vectors"]:
        if canonical_runsteward(vector["value"]) != vector["canonical_utf8"]:
            raise AssertionError(f"canonical bytes drift: {vector['id']}")
        if runsteward_digest(vector["value"]) != vector["digest"]:
            raise AssertionError(f"digest drift: {vector['id']}")
    return len(document["vectors"])


def verify_choicegate_fixtures() -> int:
    provenance = read_runsteward_json(FIXTURE_ROOT / "choicegate" / "provenance.json")
    qualification = read_runsteward_json(FIXTURE_ROOT / "choicegate" / "qualification.json")
    authority = provenance["authority"]
    if authority["choicegate_commit"] != "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0":
        raise AssertionError("ChoiceGate authority drift")
    if authority["lifecycle_inventory_fingerprint"] != "e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0":
        raise AssertionError("the external lifecycle authority inventory authority drift")
    receipt_schema_path = ROOT / authority["choicegate_receipt_schema_ref"]
    receipt_schema_bytes = receipt_schema_path.read_bytes()
    if normalized_utf8_lf_sha256(receipt_schema_path) != authority["choicegate_receipt_schema_sha256"]:
        raise AssertionError("vendored ChoiceGate receipt schema bytes drift")
    receipt_schema_crlf_bytes = receipt_schema_bytes.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r\n").encode("utf-8")
    if hashlib.sha256(receipt_schema_crlf_bytes).hexdigest() != authority["choicegate_receipt_schema_source_raw_sha256"]:
        raise AssertionError("ChoiceGate source raw schema evidence drift")
    receipt_schema = read_json(receipt_schema_path)
    Draft202012Validator.check_schema(receipt_schema)
    if receipt_schema.get("$id") != authority["choicegate_receipt_schema_id"]:
        raise AssertionError("vendored ChoiceGate receipt schema id drift")
    qualification_body = {key: value for key, value in qualification.items() if key != "qualification_digest"}
    if runsteward_digest(qualification_body) != qualification["qualification_digest"]:
        raise AssertionError("ChoiceGate qualification digest drift")
    if qualification["provenance_ref"]["digest"] != runsteward_digest(provenance):
        raise AssertionError("ChoiceGate qualification provenance digest drift")
    if qualification["choicegate_commit"] != authority["choicegate_commit"]:
        raise AssertionError("ChoiceGate qualification commit drift")
    if qualification["lifecycle_authority_commit"] != authority["lifecycle_authority_commit"]:
        raise AssertionError("the external lifecycle authority qualification commit drift")
    if qualification["lifecycle_authority_state_model"] != authority["lifecycle_authority_state_model"]:
        raise AssertionError("the external lifecycle authority qualification state-model drift")
    if qualification["lifecycle_inventory_fingerprint"] != authority["lifecycle_inventory_fingerprint"]:
        raise AssertionError("the external lifecycle authority qualification inventory drift")
    if qualification["receipt_schema_ref"] != authority["choicegate_receipt_schema_ref"] or qualification["receipt_schema_sha256"] != authority["choicegate_receipt_schema_sha256"] or qualification["receipt_schema_source_raw_sha256"] != authority["choicegate_receipt_schema_source_raw_sha256"]:
        raise AssertionError("ChoiceGate qualification schema evidence drift")
    receipts: list[dict[str, Any]] = []
    for fixture in provenance["fixtures"]:
        path = ROOT / fixture["path"]
        receipt = read_json(path)
        Draft202012Validator(receipt_schema, format_checker=FormatChecker()).validate(receipt)
        if hashlib.sha256(path.read_bytes()).hexdigest() != fixture["raw_bytes_sha256"]:
            raise AssertionError(f"ChoiceGate fixture raw bytes drift: {fixture['case_id']}")
        if normalized_utf8_lf_sha256(path) != fixture["normalized_utf8_lf_sha256"]:
            raise AssertionError(f"ChoiceGate fixture bytes drift: {fixture['case_id']}")
        native = choicegate_native_digest(receipt)
        if native != fixture["receipt_sha256"] or native != receipt["receipt_sha256"]:
            raise AssertionError(f"ChoiceGate native digest drift: {fixture['case_id']}")
        if receipt["request_sha256"] != fixture["request_sha256"]:
            raise AssertionError(f"ChoiceGate request digest drift: {fixture['case_id']}")
        if receipt["router_binding"]["choicegate_commit"] != authority["choicegate_commit"]:
            raise AssertionError(f"ChoiceGate commit drift: {fixture['case_id']}")
        if receipt["inventory_binding"]["accepted_lifecycle_authority_commit"] != authority["lifecycle_authority_commit"]:
            raise AssertionError(f"the external lifecycle authority commit drift: {fixture['case_id']}")
        if receipt["inventory_binding"]["manifest_fingerprint"] != authority["lifecycle_inventory_fingerprint"]:
            raise AssertionError(f"the external lifecycle authority fingerprint drift: {fixture['case_id']}")
        try:
            _assert_runsteward_domain(receipt["task"]["preconditions"], "$.task.preconditions")
        except AssertionError as error:
            raise AssertionError(f"ChoiceGate precondition is outside the RunSteward v1 digest domain: {fixture['case_id']}: {error}") from error
        qualified = next((item for item in qualification["receipts"] if item["immutable_ref"] == fixture["path"]), None)
        if qualified is None or qualified["qualification_status"] != "passed":
            raise AssertionError(f"missing Python qualification: {fixture['case_id']}")
        for key in ("normalized_utf8_lf_sha256", "receipt_sha256", "request_sha256"):
            if qualified[key] != fixture[key]:
                raise AssertionError(f"qualification {key} drift: {fixture['case_id']}")
        if qualified["raw_bytes_sha256"] != fixture["raw_bytes_sha256"]:
            raise AssertionError(f"qualification raw bytes drift: {fixture['case_id']}")
        if qualified["schema_id"] != authority["choicegate_receipt_schema_id"] or qualified["choicegate_commit"] != authority["choicegate_commit"]:
            raise AssertionError(f"qualification authority drift: {fixture['case_id']}")
        receipts.append(receipt)
    tampered = copy.deepcopy(receipts[0])
    tampered["decision"]["route_id"] = "tampered-route"
    if choicegate_native_digest(tampered) == receipts[0]["receipt_sha256"]:
        raise AssertionError("tampered ChoiceGate body was not killed by native hash qualification")
    local_provenance = read_runsteward_json(FIXTURE_ROOT / "choicegate" / "provenance.initial-gated.json")
    local_qualification = read_runsteward_json(FIXTURE_ROOT / "choicegate" / "qualification.initial-gated.json")
    policy = local_provenance.get("local_contract_fixture_policy", {})
    if policy.get("fixture_class") != "deterministic-runsteward-contract-fixture" or policy.get("production_decision") is not False or policy.get("selection_authority_claimed") is not False:
        raise AssertionError("local owner-gated receipt is not clearly labeled as a non-production contract fixture")
    if local_provenance["authority"] != provenance["authority"]:
        raise AssertionError("local owner-gated receipt changed ChoiceGate or the external lifecycle authority authority")
    if local_qualification["provenance_ref"]["digest"] != runsteward_digest(local_provenance):
        raise AssertionError("local owner-gated qualification provenance digest drift")
    local_body = {key: value for key, value in local_qualification.items() if key != "qualification_digest"}
    if local_qualification["qualification_digest"] != runsteward_digest(local_body):
        raise AssertionError("local owner-gated qualification digest drift")
    if len(local_provenance["fixtures"]) != 1 or len(local_qualification["receipts"]) != 1:
        raise AssertionError("local owner-gated qualification must be a single bounded fixture")
    local_fixture = local_provenance["fixtures"][0]
    local_qualified = local_qualification["receipts"][0]
    if local_fixture.get("fixture_class") != "deterministic-runsteward-contract-fixture" or local_fixture.get("production_decision") is not False:
        raise AssertionError("local owner-gated provenance entry overclaims production authority")
    request = read_runsteward_json(ROOT / local_fixture["request_ref"])
    request_payload = json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if hashlib.sha256(request_payload).hexdigest() != local_fixture["request_sha256"]:
        raise AssertionError("local owner-gated request digest drift")
    local_path = ROOT / local_fixture["path"]
    local_receipt = read_json(local_path)
    Draft202012Validator(receipt_schema, format_checker=FormatChecker()).validate(local_receipt)
    if hashlib.sha256(local_path.read_bytes()).hexdigest() != local_fixture["raw_bytes_sha256"] or normalized_utf8_lf_sha256(local_path) != local_fixture["normalized_utf8_lf_sha256"]:
        raise AssertionError("local owner-gated receipt byte qualification drift")
    if choicegate_native_digest(local_receipt) != local_receipt["receipt_sha256"] or local_receipt["receipt_sha256"] != local_fixture["receipt_sha256"]:
        raise AssertionError("local owner-gated native receipt digest drift")
    if local_receipt["request_sha256"] != local_fixture["request_sha256"] or local_receipt["approvals_required"] != ["approval:initial-local"] or local_receipt["task"]["authorization_required"] is not True:
        raise AssertionError("local owner-gated receipt authority contract drift")
    for key in ("immutable_ref", "normalized_utf8_lf_sha256", "raw_bytes_sha256", "receipt_sha256", "request_sha256"):
        expected = local_fixture["path"] if key == "immutable_ref" else local_fixture[key]
        if local_qualified[key] != expected:
            raise AssertionError(f"local owner-gated qualification {key} drift")
    receipts.append(local_receipt)
    return len(receipts)


def verify_rw4_choicegate_fixtures() -> int:
    provenance = read_runsteward_json(FIXTURE_ROOT / "choicegate" / "provenance.rw4.json")
    qualification = read_runsteward_json(FIXTURE_ROOT / "choicegate" / "qualification.rw4.json")
    authority = provenance["authority"]
    expected = {
        "choicegate_commit": "c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1",
        "choicegate_tree": "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2",
        "choicegate_acceptance_receipt_sha256": "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
        "lifecycle_authority_commit": "d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1",
        "lifecycle_authority_tree": "d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2",
        "lifecycle_inventory_fingerprint": "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1",
        "lifecycle_authority_fingerprint": "e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2",
        "lifecycle_authority_state_model": "orthogonal-seven-axis-v1",
        "choicegate_receipt_schema_id": "choicegate.decision-receipt/v1",
        "choicegate_receipt_schema_ref": "contracts/vendor/choicegate/decision-receipt.schema.json",
        "choicegate_receipt_schema_sha256": "3d32d4bac2cb9ff78d0249741d74e8572326894435e3bab10bf0f2f7ca7c949d",
        "choicegate_receipt_schema_source_raw_sha256": "c21949ee1a0fcf80d550d22b541123bbd31c5c424c92f819ee9cfa409827b69f",
    }
    if authority != expected:
        raise AssertionError("RW4 accepted authority drift")
    policy = provenance.get("local_contract_fixture_policy", {})
    if policy.get("production_decision") is not False or policy.get("selection_authority_claimed") is not False or policy.get("preserves_template_selection_without_reranking") is not True:
        raise AssertionError("RW4 fixtures overclaim ChoiceGate selection authority")
    if qualification["provenance_ref"] != {"ref": "contracts/fixtures/choicegate/provenance.rw4.json", "digest": runsteward_digest(provenance)}:
        raise AssertionError("RW4 qualification provenance drift")
    qualification_body = {key: value for key, value in qualification.items() if key != "qualification_digest"}
    if qualification["qualification_digest"] != runsteward_digest(qualification_body):
        raise AssertionError("RW4 qualification digest drift")
    qualification_authority = {
        "choicegate_commit": qualification["choicegate_commit"],
        "choicegate_tree": qualification["choicegate_tree"],
        "choicegate_acceptance_receipt_sha256": qualification["choicegate_acceptance_receipt_sha256"],
        "lifecycle_authority_commit": qualification["lifecycle_authority_commit"],
        "lifecycle_authority_tree": qualification["lifecycle_authority_tree"],
        "lifecycle_inventory_fingerprint": qualification["lifecycle_inventory_fingerprint"],
        "lifecycle_authority_fingerprint": qualification["lifecycle_authority_fingerprint"],
        "lifecycle_authority_state_model": qualification["lifecycle_authority_state_model"],
        "choicegate_receipt_schema_id": qualification["receipt_schema_id"],
        "choicegate_receipt_schema_ref": qualification["receipt_schema_ref"],
        "choicegate_receipt_schema_sha256": qualification["receipt_schema_sha256"],
        "choicegate_receipt_schema_source_raw_sha256": qualification["receipt_schema_source_raw_sha256"],
    }
    if qualification_authority != expected:
        raise AssertionError("RW4 qualification accepted authority drift")
    receipt_schema = read_json(ROOT / authority["choicegate_receipt_schema_ref"])
    fixtures_by_ref = {item["immutable_ref"]: item for item in qualification["receipts"]}
    if len(provenance["fixtures"]) != 3 or len(fixtures_by_ref) != 3:
        raise AssertionError("RW4 receipt matrix must contain exactly three fixtures")
    for fixture in provenance["fixtures"]:
        path = ROOT / fixture["path"]
        receipt = read_json(path)
        Draft202012Validator(receipt_schema, format_checker=FormatChecker()).validate(receipt)
        raw_digest = hashlib.sha256(path.read_bytes()).hexdigest()
        normalized_digest = normalized_utf8_lf_sha256(path)
        if raw_digest != fixture["raw_bytes_sha256"] or normalized_digest != fixture["normalized_utf8_lf_sha256"]:
            raise AssertionError(f"RW4 receipt byte drift: {fixture['case_id']}")
        if choicegate_native_digest(receipt) != receipt["receipt_sha256"] or receipt["receipt_sha256"] != fixture["receipt_sha256"]:
            raise AssertionError(f"RW4 native receipt digest drift: {fixture['case_id']}")
        if receipt["router_binding"]["choicegate_commit"] != expected["choicegate_commit"]:
            raise AssertionError(f"RW4 ChoiceGate commit drift: {fixture['case_id']}")
        if receipt["inventory_binding"]["accepted_lifecycle_authority_commit"] != expected["lifecycle_authority_commit"] or receipt["inventory_binding"]["manifest_fingerprint"] != expected["lifecycle_inventory_fingerprint"]:
            raise AssertionError(f"RW4 the external lifecycle authority authority drift: {fixture['case_id']}")
        qualified = fixtures_by_ref.get(fixture["path"])
        if qualified is None or qualified["qualification_status"] != "passed":
            raise AssertionError(f"RW4 receipt lacks qualification: {fixture['case_id']}")
        for key in ("raw_bytes_sha256", "normalized_utf8_lf_sha256", "receipt_sha256", "request_sha256"):
            if qualified[key] != fixture[key]:
                raise AssertionError(f"RW4 qualification {key} drift: {fixture['case_id']}")
        if qualified["choicegate_commit"] != expected["choicegate_commit"]:
            raise AssertionError(f"RW4 qualified commit drift: {fixture['case_id']}")
    return len(provenance["fixtures"])


def verify_runsteward_parse_rejections() -> int:
    corpus = read_runsteward_json(FIXTURE_ROOT / "hash-vectors" / "runsteward-canonical-json-v1-rejected.json")
    if corpus["algorithm"] != "runsteward-canonical-json-sha256-v1" or len(corpus["cases"]) != 6:
        raise AssertionError("unexpected shared RunSteward rejection corpus")
    for vector in corpus["cases"]:
        try:
            parse_runsteward_json(vector["raw_json"])
        except (AssertionError, ValueError):
            continue
        raise AssertionError(f"Python RunSteward loader accepted {vector['reason']}: {vector['id']}")
    return len(corpus["cases"])


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        description="Deterministic offline RunSteward contract verification."
    )
    parser.add_argument(
        "--root", type=Path, default=Path.cwd(),
        help="repository checkout root (default: current directory)",
    )
    args = parser.parse_args(argv)
    configure_root(args.root)
    vector_count = verify_runsteward_vectors()
    receipt_count = verify_choicegate_fixtures() + verify_rw4_choicegate_fixtures()
    rejection_count = verify_runsteward_parse_rejections()
    valid_count, invalid_count = verify_schema_fixtures()
    print(f"RUNSTEWARD_HASH_VECTORS_PASS={vector_count}")
    print(f"CHOICEGATE_NATIVE_RECEIPTS_PASS={receipt_count}")
    print(f"RUNSTEWARD_STRICT_JSON_REJECTIONS_PASS={rejection_count}")
    print(f"RUNSTEWARD_SCHEMA_VALID_FIXTURES_PASS={valid_count}")
    print(f"RUNSTEWARD_SCHEMA_INVALID_FIXTURES_REJECTED={invalid_count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
