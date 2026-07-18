# RunSteward P0 Contracts

This directory contains the RW-1 lifecycle contracts consumed by the RW-2 scheduler and RW-3 thin provider adapters, bound by RW-4 receipt ingestion, and fault-qualified offline by RW-5. It does not activate a provider runtime, contact a provider, install a capability, or change any remote.

## Authority boundary

- The external lifecycle authority owns capability identity, inventory, provenance, lifecycle state, policy, priority, promotion, and evaluation contracts.
- ChoiceGate owns atomic-capability and approved-bundle selection. Its receipt is the immutable selection authority.
- RunSteward owns execution lifecycle. It binds a qualified ChoiceGate receipt into a capability plan and may dispatch only an executable original atomic or bundle decision whose owner gates are satisfied.

RunSteward does not rerank selection alternatives, copy ChoiceGate scoring fields, substitute a capability, or treat a handoff as a fresh selection. A handoff is non-chainable and must preserve a reference to its original atomic or bundle selection.

The accepted P0 fixture binding pins ChoiceGate commit `c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0`, the external lifecycle authority commit `d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0`, state model `orthogonal-seven-axis-v1`, and inventory fingerprint `e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0`. The fixture provenance and qualification artifacts are evidence, not a second inventory or selection authority.

## Contract map

RunSteward has seven primary lifecycle contracts: run, state event, capability plan, worktree lease, checkpoint, handoff, and report. Common definitions support those contracts. The ChoiceGate qualification schema is a RunSteward evidence envelope for a foreign authority; it is not an eighth lifecycle contract and does not make RunSteward a receipt or selection owner.

| Contract | Schema | Purpose |
|---|---|---|
| Run | [`runsteward/v1/run.schema.json`](runsteward/v1/run.schema.json) | Current deterministic projection of a complete event chain |
| State event | [`runsteward/v1/state-event.schema.json`](runsteward/v1/state-event.schema.json) | Ordered, digest-linked lifecycle fact with a typed projection |
| Capability plan | [`runsteward/v1/capability-plan.schema.json`](runsteward/v1/capability-plan.schema.json) | Frozen execution binding to a qualified ChoiceGate receipt |
| Worktree lease | [`runsteward/v1/worktree-lease.schema.json`](runsteward/v1/worktree-lease.schema.json) | Run, branch, worktree, state, evidence, lock, and epoch reservation identity |
| Checkpoint | [`runsteward/v1/checkpoint.schema.json`](runsteward/v1/checkpoint.schema.json) | Bounded resumable state and provider resume identity evidence |
| Handoff | [`runsteward/v1/handoff.schema.json`](runsteward/v1/handoff.schema.json) | Bounded continuation packet tied to a checkpoint and original selection |
| Report | [`runsteward/v1/report.schema.json`](runsteward/v1/report.schema.json) | Attempt-closing outcome and literal final-status proof |
| Provider evidence | [`runsteward/v1/provider-evidence.schema.json`](runsteward/v1/provider-evidence.schema.json) | Typed nonconvertible provider metrics with bounded raw-evidence references |
| Wrap plan | [`runsteward/v1/wrap-plan.schema.json`](runsteward/v1/wrap-plan.schema.json) | Coordinator-only delegation to checkpoint, stop, and report with closed-action proof |
| ChoiceGate qualification envelope | [`runsteward/v1/choicegate-qualification.schema.json`](runsteward/v1/choicegate-qualification.schema.json) | RunSteward evidence envelope proving that an immutable foreign receipt matches the accepted ChoiceGate and the external lifecycle authority authorities |
| Common definitions | [`runsteward/v1/common.schema.json`](runsteward/v1/common.schema.json) | Shared identifiers, references, paths, hashes, states, and policies |

Schema `$id` values use the private `https://runsteward.local/contracts/runsteward/v1/` namespace. They are stable identifiers, not public URLs. Validators must resolve them from the repository-local schema registry and must never dereference them over a network.

[`fixtures/manifest.json`](fixtures/manifest.json) is the exhaustive local schema/fixture inventory used by validation. It also pins the normalized bytes of the vendored [`ChoiceGate decision-receipt schema`](vendor/choicegate/decision-receipt.schema.json). That vendored file is an immutable validation snapshot owned by ChoiceGate, not a fork, local schema namespace member, or transfer of selection authority.

## Digest contracts

RunSteward and ChoiceGate digests are deliberately distinct.

### RunSteward canonical JSON SHA-256 v1

RunSteward artifacts use `runsteward-canonical-json-sha256-v1`:

1. Accept only null, booleans, Unicode-scalar strings, arrays, plain objects, and finite safe integers.
2. Reject floats, nonfinite numbers, unsafe integers, negative zero, unpaired surrogates, non-plain objects, and object keys outside `[A-Za-z_$][A-Za-z0-9_.:$-]*`.
3. Sort object keys ordinally, preserve array order, emit compact JSON, and encode UTF-8 without a byte-order mark.
4. For a digest-bearing artifact, remove only that artifact's own digest field before canonicalization.
5. Return lowercase SHA-256 with the `sha256:` prefix.

The digest fields are `run_digest`, `event_digest`, `plan_digest`, `lease_digest`, `checkpoint_digest`, `handoff_digest`, `report_digest`, and `evidence_digest` for their corresponding artifacts. A wrap plan also uses `plan_digest` under its distinct schema version. [`fixtures/hash-vectors/runsteward-canonical-json-v1.json`](fixtures/hash-vectors/runsteward-canonical-json-v1.json) is the cross-language byte and digest contract.

### ChoiceGate native receipt digest

A ChoiceGate receipt keeps ChoiceGate's native procedure:

1. Remove only `receipt_sha256` from the complete receipt.
2. Serialize with Python-compatible sorted keys, compact separators, UTF-8, `ensure_ascii=false`, and `allow_nan=false`.
3. Return lowercase SHA-256 as bare hexadecimal, without the `sha256:` prefix.

RunSteward verifies and preserves that native receipt digest. It must not relabel a RunSteward digest as a ChoiceGate receipt digest or recanonicalize the receipt into a different authority.

A ChoiceGate receipt has no `issued_at` field. RunSteward may record its own `bound_at` lifecycle time when it binds the receipt, but it must never fabricate a receipt timestamp.

## Lifecycle proof

The event log, not a mutable status file, is authoritative. A run projection is valid only when it exactly equals the fold of the complete ordered event chain. Each event binds its predecessor digest, sequence, transition, typed event payload, and resulting projection. See [`docs/contracts.md`](../docs/contracts.md) for the transition, checkpoint, resume, lease, and final-report rules.

`stopped` closes an execution attempt without claiming success and may be followed only by an explicitly validated restart/resume path. Its report is bound in `stopped_report_ref`; `final_status_report_ref` remains empty, and a valid resume acquisition clears the stopped-attempt reference. `completed`, `failed`, and `cancelled` are terminal run outcomes whose reports are bound in `final_status_report_ref`. In every closing case, the run is not proven complete to an observer until a report containing `RUNSTEWARD_FINAL_STATUS` is digest-bound by `report.finalized`. The attempt lease must be released before report finalization, but release is not a substitute for report proof.

## Phase boundary

- RW-1: these contracts and provider-neutral core primitives.
- RW-2: implemented local scheduler, isolation allocation, collision enforcement, and proof-bound child wait/join.
- RW-3: implemented local typed sensors, thin adapters, checkpoint production, limits, resume, and wrap orchestration; no provider execution.
- RW-4: runtime ChoiceGate ingestion, drift-triggered stop/reselection, and dispatch.
- RW-5: implemented deterministic offline crash, fault, concurrency, recovery, and cross-surface qualification over the unchanged lifecycle contracts.

RW-1 contracts, the RW-2 provider-neutral scheduler, and the RW-3 local consumer layer are represented locally. Any remote write, provider call, or runtime activation remains separately authorized.

## Offline validation

From the repository root, the intended no-network gate is:

```powershell
node packages/runsteward-core/scripts/run-all-tests.mjs
$env:PYTHONDONTWRITEBYTECODE = "1"
python tests/contract-compat/python_hash_vectors.py
```

The Node and Python commands must cover schema self-validation, every valid and invalid fixture, complete event folds, ChoiceGate receipt qualification and tamper rejection, JS/Python digest parity, invariant mutants, and atomic-write fault behavior. A passing schema example alone is not lifecycle evidence.
