#!/usr/bin/env python3
"""Materialize deterministic, non-production RW4 ChoiceGate contract fixtures."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "contracts" / "fixtures"

AUTHORITY = {
    "schema_id": "choicegate.decision-receipt/v1",
    "receipt_schema_sha256": "3d32d4bac2cb9ff78d0249741d74e8572326894435e3bab10bf0f2f7ca7c949d",
    "receipt_schema_source_raw_sha256": "c21949ee1a0fcf80d550d22b541123bbd31c5c424c92f819ee9cfa409827b69f",
    "choicegate_commit": "c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1",
    "choicegate_tree": "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2",
    "choicegate_acceptance_receipt_sha256": "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
    "lifecycle_authority_commit": "d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1",
    "lifecycle_authority_tree": "d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2",
    "lifecycle_authority_state_model": "orthogonal-seven-axis-v1",
    "inventory_fingerprint": "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1",
    "authority_fingerprint": "e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2",
}

COMPONENT_HASHES = [
    {"path": "evals/choicegate/inventory-fixtures.json", "sha256": "ceb003f49e389b033655490e0588baf056c2b93683a7007957be8f1a5875ae4a"},
    {"path": "evals/choicegate/manifest.json", "sha256": "d795d9e4d12ef373fd9c2d0fd9bf3575cd96a9f50f1239c357754229aced54c1"},
    {"path": "evals/choicegate/routing-cases.json", "sha256": "a22b0a9ef68e9faa67e57f30f5182b44456350c2aa88c12fc3675e5a867b8e6c"},
    {"path": "registry/bundles.json", "sha256": "62927a2888b50b8194430d089c0ceb99168e31850ad3d31e42d214c327ed2d2b"},
    {"path": "registry/capabilities.json", "sha256": "f8d34754e68dd9d23686998741b423d4ab297b9c2c407ba31ff027e1d855e144"},
    {"path": "registry/conflicts.json", "sha256": "15a5198a4e0dee1f4e36c0f0c8d945e7fac782f372e23cb76e41acbd06199e18"},
    {"path": "registry/dependencies.json", "sha256": "44b4a99854bca406b313ddb64bee2cabbbea637a2cb6b31764f01f1f1f95d4ad"},
    {"path": "registry/preconditions.json", "sha256": "e93e9e0be91e426b4dc83d4587e82f7e083c06dff1b0e805cb83d8d1dd5f410d"},
    {"path": "registry/schemas/bundle.schema.json", "sha256": "481ddc3d9a3316faf713e0982fea9fc794a22fe3dfb00da70fa72afaf1126f65"},
    {"path": "registry/schemas/capability.schema.json", "sha256": "883330c7e58132f6e96b9210f171d074d47d33ff9f961db1a72b3b6c970adbaf"},
    {"path": "registry/schemas/conflict.schema.json", "sha256": "fded3ff0a65961f1d5d60c2ca187bc26f5af665633e6381253f8da9d260226ca"},
    {"path": "registry/schemas/dependency.schema.json", "sha256": "cc8c32114b87f4e2d7a687d35c864d216993739de7e2a300c53ac6898e8704c9"},
    {"path": "registry/schemas/precondition.schema.json", "sha256": "50953c3e6f0ff5cbdf2ee14eaedbb232d12232d74f5db014e4ddf23ca4edaff2"},
    {"path": "registry/schemas/supersession.schema.json", "sha256": "4edeffaf980b79a77073d510706a09ce88dd30726528686f3d1f9b3d1ba01ebf"},
    {"path": "registry/state-axes.json", "sha256": "666465eeed8ed37d1d294a23af44a4ffb5e9d11b314406d6e46ca8587bbefbfd"},
    {"path": "registry/supersessions.json", "sha256": "e79495bea3a7998fc6f120ce476bd99c0e99c72a78266dd96c2d80fb7f0e6d41"},
]

TEMPLATES = [
    ("CG-RW4-ATOMIC-01", "cg-atomic-01.receipt.json", "rw4-cg-atomic-01.receipt.json", "capability-plan.atomic.json", "capability-plan.rw4-atomic.json"),
    ("CG-RW4-BUNDLE-01", "cg-bundle-01.receipt.json", "rw4-cg-bundle-01.receipt.json", "capability-plan.bundle.json", "capability-plan.rw4-bundle.json"),
    ("CG-RW4-OWNER-GATED-01", "cg-initial-gated-01.receipt.json", "rw4-cg-owner-gated-01.receipt.json", "capability-plan.initial-gated.json", "capability-plan.rw4-owner-gated.json"),
]


def read_json(path: Path) -> Any:
    return json.loads(path.read_bytes().decode("utf-8"))


def pretty_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def compact_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def runsteward_digest(value: Any, field: str | None = None) -> str:
    body = dict(value)
    if field is not None:
        body.pop(field, None)
    return f"sha256:{sha256(compact_bytes(body))}"


def native_receipt_digest(receipt: dict[str, Any]) -> str:
    body = dict(receipt)
    body.pop("receipt_sha256", None)
    return sha256(compact_bytes(body))


def current_receipt(template_name: str) -> dict[str, Any]:
    receipt = copy.deepcopy(read_json(FIXTURES / "choicegate" / template_name))
    receipt["inventory_binding"] = {
        "accepted_lifecycle_authority_commit": AUTHORITY["lifecycle_authority_commit"],
        "component_hashes": copy.deepcopy(COMPONENT_HASHES),
        "manifest_algorithm": "sha256-path-hash-manifest-v1",
        "manifest_fingerprint": AUTHORITY["inventory_fingerprint"],
        "state_model_id": AUTHORITY["lifecycle_authority_state_model"],
    }
    receipt["router_binding"].update(
        {
            "choicegate_commit": AUTHORITY["choicegate_commit"],
            "deterministic_helper_sha256": "3644728a2030180402d88a4859274d2c645c7a3bd3d0b5e6028bf262e16202ba",
            "receipt_schema_sha256": AUTHORITY["receipt_schema_sha256"],
            "request_schema_sha256": "661bf8ecd42ade520aad1789cb8b23db5680a96045ccb6b54499b0fddd529ec1",
            "router_source_sha256": "557fe3fdb16c0f2b3abf42c091c6786a97332b545165db3799c220b11857f7e1",
        }
    )
    receipt["receipt_sha256"] = native_receipt_digest(receipt)
    return receipt


def authority_record() -> dict[str, Any]:
    return {
        "choicegate_commit": AUTHORITY["choicegate_commit"],
        "choicegate_tree": AUTHORITY["choicegate_tree"],
        "choicegate_acceptance_receipt_sha256": AUTHORITY["choicegate_acceptance_receipt_sha256"],
        "lifecycle_authority_commit": AUTHORITY["lifecycle_authority_commit"],
        "lifecycle_authority_tree": AUTHORITY["lifecycle_authority_tree"],
        "lifecycle_inventory_fingerprint": AUTHORITY["inventory_fingerprint"],
        "lifecycle_authority_fingerprint": AUTHORITY["authority_fingerprint"],
        "lifecycle_authority_state_model": AUTHORITY["lifecycle_authority_state_model"],
        "choicegate_receipt_schema_id": AUTHORITY["schema_id"],
        "choicegate_receipt_schema_ref": "contracts/vendor/choicegate/decision-receipt.schema.json",
        "choicegate_receipt_schema_sha256": AUTHORITY["receipt_schema_sha256"],
        "choicegate_receipt_schema_source_raw_sha256": AUTHORITY["receipt_schema_source_raw_sha256"],
    }


def materialize() -> dict[Path, bytes]:
    files: dict[Path, bytes] = {}
    receipts: list[tuple[str, str, str, str, dict[str, Any], bytes]] = []
    for case_id, template_receipt, output_receipt, template_plan, output_plan in TEMPLATES:
        receipt = current_receipt(template_receipt)
        receipt_bytes = pretty_bytes(receipt)
        receipt_ref = f"contracts/fixtures/choicegate/{output_receipt}"
        files[ROOT / receipt_ref] = receipt_bytes
        receipts.append((case_id, receipt_ref, template_plan, output_plan, receipt, receipt_bytes))

    provenance = {
        "schema_version": "runsteward.choicegate-fixture-provenance/v1",
        "authority": authority_record(),
        "native_digest_procedure": {
            "consumer_label": "choicegate-native-sorted-compact-json-sha256-v1",
            "authoritative_name_claimed": False,
            "steps": [
                "Remove only receipt_sha256 from the complete receipt object.",
                "Serialize with Python json.dumps ensure_ascii false, sort_keys true, separators comma-colon, allow_nan false.",
                "Encode the result as UTF-8 without a BOM.",
                "Return the lowercase hexadecimal SHA-256 digest without a sha256 prefix.",
            ],
            "not_rfc8785": True,
        },
        "generator": {
            "module": "packages/runsteward-core/scripts/materialize_rw4_choicegate_fixtures.py",
            "function": "materialize",
            "inventory_source": "accepted local the external lifecycle authority ownership receipt",
            "choicegate_source": "accepted local ChoiceGate CG4 receipt",
            "network_required": False,
            "choicegate_execution_required": False,
        },
        "fixtures": [],
        "local_contract_fixture_policy": {
            "fixture_class": "deterministic-runsteward-rw4-contract-fixture",
            "production_decision": False,
            "selection_authority_claimed": False,
            "preserves_template_selection_without_reranking": True,
            "purpose": "Exercise exact accepted-authority ingestion without invoking or reimplementing ChoiceGate.",
        },
    }
    for case_id, receipt_ref, _template_plan, _output_plan, receipt, receipt_bytes in receipts:
        provenance["fixtures"].append(
            {
                "case_id": case_id,
                "path": receipt_ref,
                "fixture_class": "deterministic-runsteward-rw4-contract-fixture",
                "production_decision": False,
                "request_sha256": receipt["request_sha256"],
                "receipt_sha256": receipt["receipt_sha256"],
                "raw_bytes_sha256": sha256(receipt_bytes),
                "normalized_utf8_lf_sha256": sha256(receipt_bytes),
            }
        )
    provenance_ref = "contracts/fixtures/choicegate/provenance.rw4.json"
    provenance_bytes = pretty_bytes(provenance)
    files[ROOT / provenance_ref] = provenance_bytes

    qualification = {
        "schema_version": "runsteward.choicegate-qualification/v1",
        "verifier": "runsteward-choicegate-python-qualification/v1",
        "receipt_schema_id": AUTHORITY["schema_id"],
        "receipt_schema_ref": "contracts/vendor/choicegate/decision-receipt.schema.json",
        "receipt_schema_sha256": AUTHORITY["receipt_schema_sha256"],
        "receipt_schema_source_raw_sha256": AUTHORITY["receipt_schema_source_raw_sha256"],
        "choicegate_commit": AUTHORITY["choicegate_commit"],
        "choicegate_tree": AUTHORITY["choicegate_tree"],
        "choicegate_acceptance_receipt_sha256": AUTHORITY["choicegate_acceptance_receipt_sha256"],
        "lifecycle_authority_commit": AUTHORITY["lifecycle_authority_commit"],
        "lifecycle_authority_tree": AUTHORITY["lifecycle_authority_tree"],
        "lifecycle_authority_state_model": AUTHORITY["lifecycle_authority_state_model"],
        "lifecycle_inventory_fingerprint": AUTHORITY["inventory_fingerprint"],
        "lifecycle_authority_fingerprint": AUTHORITY["authority_fingerprint"],
        "provenance_ref": {"ref": provenance_ref, "digest": runsteward_digest(provenance)},
        "receipts": [],
    }
    for case_id, receipt_ref, _template_plan, _output_plan, receipt, receipt_bytes in receipts:
        qualification["receipts"].append(
            {
                "case_id": case_id,
                "immutable_ref": receipt_ref,
                "normalized_utf8_lf_sha256": sha256(receipt_bytes),
                "raw_bytes_sha256": sha256(receipt_bytes),
                "receipt_sha256": receipt["receipt_sha256"],
                "request_sha256": receipt["request_sha256"],
                "schema_id": receipt["receipt_version"],
                "choicegate_commit": AUTHORITY["choicegate_commit"],
                "qualification_status": "passed",
            }
        )
    qualification["qualification_digest"] = runsteward_digest(qualification)
    qualification_ref = "contracts/fixtures/choicegate/qualification.rw4.json"
    files[ROOT / qualification_ref] = pretty_bytes(qualification)
    for field in (
        "choicegate_acceptance_receipt_sha256",
        "lifecycle_authority_tree",
        "lifecycle_authority_fingerprint",
    ):
        invalid = copy.deepcopy(qualification)
        del invalid[field]
        invalid["qualification_digest"] = runsteward_digest(invalid, "qualification_digest")
        files[FIXTURES / "invalid" / f"choicegate-qualification.rw4-missing-{field.replace('_', '-')}.json"] = pretty_bytes(invalid)

    receipt_by_ref = {receipt_ref: receipt for _case, receipt_ref, _tp, _op, receipt, _bytes in receipts}
    for _case_id, receipt_ref, template_plan, output_plan, _receipt, _receipt_bytes in receipts:
        plan = copy.deepcopy(read_json(FIXTURES / "valid" / template_plan))
        receipt = receipt_by_ref[receipt_ref]
        plan["choicegate_receipt"].update(
            {
                "immutable_ref": receipt_ref,
                "receipt_sha256": receipt["receipt_sha256"],
                "request_id": receipt["request_id"],
                "request_sha256": receipt["request_sha256"],
                "task_class": receipt["task"]["task_class"],
                "inventory_fingerprint": AUTHORITY["inventory_fingerprint"],
                "accepted_lifecycle_authority_commit": AUTHORITY["lifecycle_authority_commit"],
                "choicegate_commit": AUTHORITY["choicegate_commit"],
                "qualification_ref": {"ref": qualification_ref, "digest": qualification["qualification_digest"]},
            }
        )
        plan["plan_digest"] = runsteward_digest(plan, "plan_digest")
        files[FIXTURES / "valid" / output_plan] = pretty_bytes(plan)
    return files


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--write", action="store_true")
    args = parser.parse_args()

    files = materialize()
    drift: list[str] = []
    for path, expected in sorted(files.items(), key=lambda item: item[0].as_posix()):
        if args.write:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(expected)
        elif not path.is_file() or path.read_bytes() != expected:
            drift.append(path.relative_to(ROOT).as_posix())
    if drift:
        print("RUNSTEWARD_RW4_FIXTURE_DRIFT=" + ",".join(drift))
        return 1
    print(f"RUNSTEWARD_RW4_FIXTURES_PASS={len(files)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
