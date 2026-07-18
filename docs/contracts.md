# RunSteward P0 Contract Semantics

This document explains the provider-neutral behavior implemented through the RW-5 candidate. The schemas are indexed in [`contracts/README.md`](../contracts/README.md); the ownership boundary is described in [`docs/architecture.md`](architecture.md).

The seven primary lifecycle contracts are run, state event, capability plan, worktree lease, checkpoint, handoff, and report. The shared common schema supports them. [`choicegate-qualification.schema.json`](../contracts/runsteward/v1/choicegate-qualification.schema.json) is only a RunSteward evidence envelope around an immutable foreign receipt, and the [`vendored ChoiceGate receipt schema`](../contracts/vendor/choicegate/decision-receipt.schema.json) is a hash-pinned validation snapshot. Neither is an additional lifecycle owner. [`fixtures/manifest.json`](../contracts/fixtures/manifest.json) is the exhaustive local validation inventory.

## Authority flow

1. The external lifecycle authority declares capability identity, provenance, lifecycle state, policy, priority, and evaluation truth.
2. ChoiceGate evaluates the request against that accepted inventory and produces one hash-bound atomic, bundle, handoff, or no-safe-route decision receipt.
3. RunSteward verifies the immutable receipt and its qualification evidence, freezes the exact decision and owner gates into a capability plan, and owns only the subsequent execution lifecycle.

RunSteward never searches the inventory, reranks selection alternatives, copies ranking evidence into its plan, or turns a fallback into an executable selection. If scope, permission, availability, source, or risk changes materially, execution stops for an owner/ChoiceGate decision rather than silently selecting again.

ChoiceGate receipts use their native bare hexadecimal digest. RunSteward artifacts use the restricted `runsteward-canonical-json-sha256-v1` digest with a `sha256:` prefix. The procedures are not interchangeable. The receipt contains no `issued_at`; `bound_at` is a RunSteward lifecycle fact only.

## Event fold

[`event-fold.mjs`](../packages/runsteward-core/src/event-fold.mjs) accepts one non-empty event list and enforces:

- sequence starts at one and is contiguous;
- every event has the same `run_id`;
- each `previous_event_digest` equals the preceding event digest;
- `from_state`, event type, `to_state`, and projected status form an allowed transition;
- `event_data.kind` equals `event_type`;
- immutable projection fields do not drift;
- only event-specific mutable fields change; and
- the final run digest covers the exact folded projection and last-event position.

The first event is `run.created` from no state to `planned`. The P0 transition families are:

| Event | Allowed effect |
|---|---|
| `capability-plan.bound` | Bind the frozen plan without changing lifecycle state |
| `run.queued` | Move a planned or owner-released run to `queued` |
| `lease.acquired` | Bind an isolated lease and move to `allocated` |
| `run.started`, `run.resumed` | Enter `running` from an allocated lease |
| `run.waiting`, `run.approval_required` | Stop active progress while preserving explicit wait/gate evidence |
| `run.checkpointed`, `checkpoint.finalized` | Close active work into a checkpoint and bind the finalized checkpoint reference |
| `run.stop_requested` | Move active work to `stopping` |
| `run.stopped` | Close the current attempt without claiming objective completion |
| `run.completed`, `run.failed`, `run.cancelled` | Record a terminal run outcome |
| `report.finalized` | Bind final-report proof without changing the closed status |
| `lease.released` | Clear the active lease reference after closure |

State schemas and event folding are both required. Schema validity alone does not establish a legal sequence or a faithful projection.

## Capability-plan binding

[`invariants.mjs`](../packages/runsteward-core/src/invariants.mjs) requires the plan, receipt, qualification, and fixture provenance to agree on schema identity, accepted ChoiceGate and the external lifecycle authority authorities, request and receipt digests, task class, inventory fingerprint, scope, preconditions, owner gates, selected route, ordered bundle members, and fallback.

Dispatch is narrower than plan validity. Only an original executable `atomic` or `bundle` receipt may dispatch, and only when the receipt and plan both show that authorization and owner gates are satisfied. A `handoff` or `no-safe-route` decision can be recorded but cannot directly dispatch.

A handoff must retain an immutable reference to its original atomic or bundle selection. It may not reference another handoff as its origin. The core must validate this relationship rather than infer it from a non-null reference.

## RW-4 runtime ingestion and dispatch

[`choicegate-runtime.mjs`](../packages/runsteward-core/src/choicegate-runtime.mjs) is a pure consumer of the frozen plan, immutable receipt bytes, Python qualification, and provenance. It compares every current and frozen authority field against [`choicegate-authority.mjs`](../packages/runsteward-core/src/choicegate-authority.mjs), then compares the request digest, scope fingerprint, frozen preconditions, owner-gate IDs, and caller-declared ChoiceGate reselection conditions. Missing current state, unknown condition names, invalid qualification, or byte/object drift fails closed. A valid superseded authority produces an explicit reselection stop rather than dispatch.

The only dispatch result is a field-for-field copy of an original executable atomic or bundle route. `NO_SAFE_ROUTE`, non-executable setup/manual routes, and stale receipts stop for reselection. A handoff remains non-chainable continuity evidence and never dispatches. Owner-gated selections remain stopped until the existing event-chain invariant proves the exact declared gates satisfied. The module contains no discovery, candidate scoring, ranking, provider/network access, subprocess invocation, or ChoiceGate call.

## Lease and collision identity

A worktree lease reserves the run, task, repository branch, worktree, state path, evidence path, and lock path through normalized collision keys. Active or retained leases may not collide on these identities. Lease IDs and `(run_id, lease_epoch)` pairs are unique.

The first lease has epoch one and no predecessor. A successor lease names the immediately preceding lease and its digest. A released lease is history; an active successor may reuse the same intended branch/path identity only through the explicit predecessor chain. RW-1 defines and checks these identities. RW-2 implements deterministic allocation, filesystem-level alias checks, create-exclusive lease and scheduler locks, prior-state digest compare-and-swap behavior, and retained physical Git qualification. An expired or stale lease is evidence for an explicit reclamation decision and never permission for silent takeover.

On Windows, physical path binding requires an absolute local-drive path, a known filesystem device identity, an existing physical ancestor, and no junction, symbolic-link, reparse, UNC, or unresolved alias boundary. Equivalent absolute paths and case variants produce the same collision key. If volume or path equivalence cannot be established, allocation fails closed.

## Scheduler and child dependencies

An initial allocation deterministically binds one task to a run ID, lease ID, branch, worktree, state directory, evidence directory, and lock path. Reservation requires an explicit complete inventory of existing leases, local branches, and physical Git worktrees; an omitted or partial inventory fails closed. The scheduler then acquires the per-run lock and a short-lived state coordination lock. While holding the coordination lock it compares the supplied prior-state digest with the current on-disk digest and atomically replaces the complete state. Concurrent writers with a stale prior state are rejected rather than losing an update.

Lock cleanup is part of the operation result, not a best-effort afterthought. A failed reservation removes only locks it acquired; if removal fails, the call fails with the residual path and whether state replacement committed. A release whose state replacement committed but whose permanent or coordination lock cannot be removed also fails explicitly while preserving the released state and residual lock as recovery evidence. Such a residual lock never authorizes automatic deletion or takeover.

Child dependency evaluation distinguishes `wait` from `join`. A final, digest-bound `RUNSTEWARD_FINAL_STATUS` report for any closed status releases `wait`. Only a required child proven `completed` with `objective_satisfied=true` satisfies `join`. Missing, unfinished, approval-blocked, identity-mismatched, invalid-proof, stopped, failed, and cancelled children do not satisfy a parent completion condition.

## Checkpoint and resume

A checkpoint is resumable only when all of the following are true:

- completeness is `complete`;
- its digest and checkpoint-event reference validate;
- the checkpoint, run, leases, and resume event use the same run, task, repository, capability plan, source head, branch, and normalized worktree identity;
- the provider binding is either `verified` with a non-null identity-reference digest or `not-required` with a null identity-reference digest;
- the predecessor lease is released;
- the successor lease is active, has a greater epoch, and binds the predecessor ID and digest; and
- `lease.acquired` immediately precedes the matching `run.resumed` event.

Partial checkpoints, raw transcripts, credentials, an `unknown` or `mismatched` provider binding, an invalid verification-state/digest pairing, source drift, plan drift, branch/path drift, stale lease reuse, or a broken checkpoint event position must stop resume. A bounded handoff may describe a safe next action, but it cannot weaken these checks. The `not-required` plus null form is explicit proof that no provider identity is needed; it is not an unknown identity.

## Typed provider evidence

[`provider-evidence.schema.json`](../contracts/runsteward/v1/provider-evidence.schema.json) and [`provider-evidence.mjs`](../packages/runsteward-core/src/provider-evidence.mjs) preserve provider observations without converting one budget into another. Every metric carries an exact registered window-specific metric name, unit, value, source adapter, confidence, and bounded evidence reference. A consumer selects only the exact metric and unit it requested; it cannot substitute, estimate, or convert a different measure.

Provider evidence is conservative by construction:

- `unknown` evidence contains no metrics and cannot authorize wrap or resume;
- provider sensors report observations but do not make lifecycle decisions;
- raw provider payloads, credentials, transcripts, and thread identities are excluded;
- evidence references are bounded, redacted, digest-bound descriptors rather than copied raw evidence; and
- resume identity is valid only as `verified` plus a digest or `not-required` plus null.

The Claude and Codex consumers live in distinct RunSteward-owned atomic packages. Claude percentage extraction delegates to the imported Limit-Aware pure extractor, Claude outcome normalization consumes Claude Carry's classified result, and Codex metric normalization consumes Codex Nightwatch's classified analysis. The consumers do not reinterpret raw provider events, edit imported bytes, or relocate the imported product-owned packages.

## Checkpoint, handoff, and wrap orchestration

[`checkpoint-runtime.mjs`](../packages/runsteward-core/src/checkpoint-runtime.mjs) builds deterministic checkpoints and bounded handoffs, then applies the existing strict resume invariants before a resume can proceed. A handoff is an operator-facing summary, not a raw evidence container or a substitute for checkpoint proof.

[`wrap-plan.schema.json`](../contracts/runsteward/v1/wrap-plan.schema.json) and [`wrap-orchestration.mjs`](../packages/runsteward-core/src/wrap-orchestration.mjs) limit wrap orchestration to an ordered coordinator plan: checkpoint, stop, and final report. The plan requires the literal `RUNSTEWARD_FINAL_STATUS` marker and forbids automatic Git staging or commits, branch deletion, destructive cleanup, provider calls, and remote writes. A sensor observation alone never executes this plan.

## Closure and final reports

`stopped` and `completed` are intentionally different:

- `stopped` closes the current execution attempt, requires `objective_satisfied=false`, and binds its report through `stopped_report_ref`. It leaves `final_status_report_ref` null and may later enter an explicit checked resume/restart path that clears the stopped-attempt reference during successor lease acquisition.
- `completed` closes the run with `objective_satisfied=true` and binds its report through `final_status_report_ref`.
- `failed` and `cancelled` also close the run through `final_status_report_ref` but do not claim success.

For every closing status, a final report must:

- contain `report_kind=final` and the literal `RUNSTEWARD_FINAL_STATUS` marker;
- match the run and closing status;
- bind the terminal event, frozen capability plan, checkpoint history, lease history, and evidence directory;
- have a valid RunSteward digest; and
- be bound by a later `report.finalized` event in the status-appropriate projection field.

The attempt's `lease.released` event must precede `report.finalized`. Neither the closing event nor lease release alone proves that a final status packet exists.

## Atomic JSON replacement

[`atomic-write.mjs`](../packages/runsteward-core/src/atomic-write.mjs) canonicalizes the full artifact, writes it to a create-exclusive same-directory temporary file, syncs and closes that file, then renames it over the target. A failed pre-rename path cleans up the temporary file. Tests must fault the pre-rename path and prove that observers see the old complete artifact or the new complete artifact, never a partial replacement.

This primitive does not claim scheduler coordination, directory-sync durability, distributed transactions, or provider-side atomicity.

## RW-5 deterministic qualification contract

RW-5 is an evidence layer over existing contracts, not a new lifecycle contract or public capability. Its focused matrix must prove deterministic collision identity, stale leases that never authorize takeover, physical and coordinator lock contention, compare-and-swap rejection of lost updates, old-or-new atomic checkpoint visibility, interrupted/identity-mismatched/missing/stopped/cancelled child behavior, resume source and worktree identity drift rejection, exact forced wrap, recovery/idempotence, and literal final-report proof.

The physical qualifier requires an absolute environment-pinned retained root and exact accepted RW-4 commit/tree. It uses two different task IDs to derive distinct branches and worktrees, retains both physical Git worktrees, repeats the focused matrix, and records one blocked lane concurrently with an independently completed lane. A hard process exit is injected before atomic rename: the old complete target must remain readable, the temporary artifact is retained as crash evidence, and repeated recovery must be byte-identical. Passing evidence never permits worktree or branch deletion, provider or network access, a remote write, a commit, a push, or an imported-package edit.

## Phase ownership

| Phase | Owns | Candidate status |
|---|---|---|
| RW-1 | Schemas, canonical digests, event fold, invariants, contract loading, atomic JSON replacement | Accepted local base |
| RW-2 | Isolation allocator, scheduler coordination, physical collision enforcement, child wait/join | Accepted local base |
| RW-3 | Typed provider evidence, atomic provider sensors and consumers, checkpoint production, strict resume, wrap, bounded handoff orchestration | Implemented in this local candidate; qualification and acceptance remain gated |
| RW-4 | Runtime receipt ingestion, exact authority/drift detection, stop/reselection, owner-gate proof, original-selection dispatch | Implemented in this local candidate; no external execution |
| RW-5 | Crash, stale lease, collision, partial write/checkpoint, interrupted child, identity/source drift, and cross-surface qualification | Implemented as deterministic offline qualification; no runtime capability added |

Imported products remain product-owned throughout these phases. Shared code may replace product behavior only after focused equivalence and regression evidence; no RW-3 candidate claim modifies an imported package.

## Offline evidence gate

Run from the repository root without provider or network access:

```powershell
node packages/runsteward-core/scripts/run-all-tests.mjs
$env:PYTHONDONTWRITEBYTECODE = "1"
python tests/contract-compat/python_hash_vectors.py
```

The gate must validate schema self-consistency, all declared valid and invalid fixtures, full lifecycle folds, ChoiceGate native receipt tamper rejection, RunSteward JS/Python digest acceptance and rejection parity, checkpoint/resume and lease invariants, final-report ordering, and atomic-write failure behavior. Imported-product regression suites remain separate evidence and must pass before merge. No passing command authorizes a commit, merge, provider call, remote write, or publication by itself.
