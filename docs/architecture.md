# RunSteward Architecture Index

## Current layers

The repository contains the RW-1 through RW-5 implementation layers. The atomic-family candidate additionally includes an inactive route-only `@runsteward/cli` package that proves canonical skill, plugin, package, and legacy-command membership without executing lifecycle actions:

- [`contracts/`](../contracts/) — versioned schemas, frozen compatibility fixtures, and digest vectors
- [`packages/runsteward-core/`](../packages/runsteward-core/) — deterministic canonicalization, event folding, invariants, contract loading, atomic JSON replacement, filesystem identity, task allocation, scheduler coordination, child dependency evaluation, typed evidence, checkpoint construction, wrap planning, and frozen ChoiceGate receipt ingestion
- [`packages/runsteward-sensor-claude-limits/`](../packages/runsteward-sensor-claude-limits/) and [`packages/runsteward-sensor-codex-usage/`](../packages/runsteward-sensor-codex-usage/) — provider-specific typed evidence consumers that never decide continue, checkpoint, stop, or budget policy
- [`packages/runsteward-adapter-claude-code/`](../packages/runsteward-adapter-claude-code/) and [`packages/runsteward-adapter-codex/`](../packages/runsteward-adapter-codex/) — thin consumers for bounded advisories, checkpoints, handoffs, wrap plans, and strict resume identity

This is a contract and lifecycle-core slice, not a completed shared runtime. Provider-facing executable behavior remains in three bundled packages:

- [`packages/claude-carry/`](../packages/claude-carry/) — Claude-oriented queueing, continuation, guardrails, reporting, and handoff
- [`packages/codex-nightwatch/`](../packages/codex-nightwatch/) — Codex-oriented supervision, policy, evidence, and resume control
- [`packages/limit-aware-wrapup/`](../packages/limit-aware-wrapup/) — usage sensing, wrap decisions, notification, and configuration policy

RW-3 does not execute a provider, authenticate, install a hook, copy provider internals, or activate a runtime. It consumes bounded imported-product facts and produces local contract artifacts only. Claude percentage extraction delegates to the imported Limit-Aware pure extractor, Claude lifecycle outcomes consume Claude Carry classifications, and Codex metrics consume Codex Nightwatch's classified analysis output rather than reparsing raw events. RW-4 adds only a pure local dispatch authorization gate for an already-qualified frozen ChoiceGate receipt; it never calls ChoiceGate, a provider, or a second router. RW-5 adds deterministic offline qualification of the existing scheduler, checkpoint, child, wrap, and final-proof boundaries; it adds no provider or lifecycle capability. Later integration work remains in [`ROADMAP.md`](../ROADMAP.md). Detailed semantics are in [`docs/contracts.md`](contracts.md).

## Authority map

| Concern | Canonical owner | RunSteward relationship |
|---|---|---|
| Capability inventory, provenance, policy, promotion, and evaluation contracts | The external lifecycle authority | Consume declared capability state; do not create a second registry authority |
| Atomic capability or approved-bundle selection | ChoiceGate | Consume and freeze a hash-bound decision receipt; do not silently rerank |
| Execution lifecycle across sessions and worktrees | RunSteward | Own queueing, isolation, budgets, checkpoints, stop rules, resume, and handoff |
| Cross-agent transport | Cairnspan | Integrate through a transport contract |
| Claim-verified research | StormWorthy | Consume research outputs through explicit contracts |
| Repository preparation and outward release workflow | ReleaseBench | Hand off only after RunSteward's local gates; outward action remains separately approved |
| Design workflow routing and gates | PixelHelm | Consume an explicit design contract without copying design internals |

The external lifecycle authority is the lifecycle and priority authority for capabilities: it owns inventory identity, provenance, state, policy, promotion, and evaluation contracts. ChoiceGate selects one atomic capability or an approved bundle against that authority and emits the decision receipt. RunSteward may bind and execute that frozen decision, but it may not invent capability state, copy ranking fields, select a substitute, or turn a handoff into a new selection.

## P0 lifecycle architecture

The event log is authoritative. A run projection is accepted only when it is the deterministic fold of one complete, ordered, digest-linked event chain. Event type, typed event data, state transition, and projected mutations must agree. Identity, repository source, policy, state/evidence locations, and sensor bindings remain immutable during a run.

The P0 state model separates execution state from proof that an attempt was closed:

| State group | States | Meaning |
|---|---|---|
| Preparation | `planned`, `queued`, `allocated` | Plan binding, owner gates, and an isolated lease are established before execution |
| Active | `running`, `waiting`, `needs_approval`, `checkpointed`, `stopping` | Work may proceed only through declared transitions and preserved evidence |
| Closed attempt | `stopped` | The current attempt is closed without claiming success; an explicit checked resume/restart path may allocate a successor lease |
| Terminal run | `completed`, `failed`, `cancelled` | The run cannot resume through the same lifecycle chain |

`stopped` is deliberately not synonymous with `completed`. It must never claim the objective was satisfied. Its attempt report is bound through `stopped_report_ref`, leaving `final_status_report_ref` empty so an explicit resume may clear the stopped-attempt reference. Reports for `completed`, `failed`, and `cancelled` are bound through `final_status_report_ref`. In either case, closure proof requires a report with the literal `RUNSTEWARD_FINAL_STATUS` marker and a later digest-bound `report.finalized` event. Lease release is separately recorded and must precede report finalization; it does not replace report proof.

A resumable checkpoint must be complete and bound to its checkpoint event, capability plan, repository identity, source, branch, worktree collision identity, and lease epoch. Its provider binding is fail-closed and has exactly two resumable forms: `verified` with a non-null identity-reference digest, or `not-required` with a null identity-reference digest. `unknown`, `mismatched`, and state/digest combinations outside those pairs reject resume. Resume also requires a released predecessor lease and a distinct active successor lease with a greater epoch and predecessor digest. The fold records lease acquisition before `run.resumed`; it never silently reuses an active lease.

JSON artifacts are written through create-exclusive temporary files, file sync, and same-directory rename, with failed temporary files cleaned up. RW-2 composes this primitive with a create-exclusive coordinator lock and prior-state digest check, so distinct task reservations cannot silently overwrite one another. This is local scheduler coordination, not a distributed or provider transaction.

## RW-2 isolation and dependency semantics

The allocator derives deterministic run, lease, branch, worktree, state, evidence, and lock identities from the repository, task, and accepted source head. Before reservation it compares existing lease identities, all local branches, and physical worktree bindings. Windows paths are absolute, case-folded for comparison, bound to a verified local volume, and resolved through an existing physical ancestor. UNC roots, unknown volumes, junction/reparse boundaries, and any identity that cannot be proven safe fail closed.

Each reservation requires a caller-supplied complete snapshot of leases, branches, and worktrees, then acquires its permanent per-run lease lock and a short-lived scheduler coordination lock. Under that lock it verifies the on-disk scheduler digest against the caller's prior state and atomically replaces the complete scheduler state. A failure before replacement preserves the old complete state and removes the uncommitted per-run lock. If reservation or release lock cleanup fails, the operation reports a cleanup-required error with the committed-state fact and residual paths; committed state and residual locks are preserved as recovery evidence and never reclaimed automatically. Expired and `stale` leases remain collision evidence; only an explicitly released, RW-1-contract-valid predecessor may produce a contract-valid successor epoch.

Child `wait` and `join` are distinct. A required child releases `wait` only after a valid final report proves `stopped`, `completed`, `failed`, or `cancelled`. Only `completed` plus `objective_satisfied=true` satisfies `join`. Missing, unfinished, approval-blocked, identity-mismatched, stopped, failed, cancelled, or invalid-proof children cannot authorize parent completion. Optional children do not widen the required completion condition.

## RW-3 evidence and orchestration semantics

Claude account percentages, Claude burn rates, and Codex token counts retain distinct metric IDs and units. Sensors emit numeric strings plus bounded redacted evidence references; they do not convert one metric into another, synthesize a zero for unknown input, or make lifecycle decisions. Unknown evidence has no numeric metric and cannot authorize wrap or resume.

Complete checkpoints accept only `verified` plus a non-null identity-reference digest or `not-required` plus null. The Claude adapter uses the explicit `not-required` form; the Codex adapter requires a caller-supplied verified opaque digest. `unknown`, `mismatched`, and mixed state/digest pairs remain non-resumable, and the existing released-predecessor/successor-lease invariant remains mandatory.

The wrap coordinator delegates exactly three outcomes in lifecycle order: checkpoint, resumable stop, and digest-bound report. It cannot add or commit Git work, delete a branch or worktree, call a provider, or write a remote. Completion still requires the literal `RUNSTEWARD_FINAL_STATUS` marker and the existing report-finalization event proof.

## RW-4 ChoiceGate ingestion semantics

[`choicegate-runtime.mjs`](../packages/runsteward-core/src/choicegate-runtime.mjs) validates the receipt object against its qualified immutable bytes, verifies the exact accepted ChoiceGate and the external lifecycle authority authority envelope, and compares the current request, scope, preconditions, owner gates, and declared reselection conditions with the frozen plan. Any drift returns a stopped, reselection-required result. An internally valid receipt bound to a superseded authority is preserved as evidence but cannot dispatch.

Only an original executable `atomic` or `bundle` route can produce `dispatch-original-selection`, and the returned route is a field-for-field copy of the frozen plan. `NO_SAFE_ROUTE` requires reselection. A handoff is continuity evidence and instructs the caller to reuse the qualified original selection; it cannot be chained or dispatched. Owner-gated routes remain stopped until the existing digest-linked event chain proves the declared gates satisfied.

## RW-5 fault and concurrency qualification

[`rw5-failure-concurrency.test.mjs`](../packages/runsteward-core/test/rw5-failure-concurrency.test.mjs) faults the existing provider-neutral boundaries without widening them. It covers deterministic allocation and collision, stale-lease evidence, physical-lock contention, coordinator compare-and-swap, pre-rename crash/partial-checkpoint behavior, interrupted and unsuccessful children, resume identity and source drift, exact forced wrap, cancellation, recovery/idempotence, and literal `RUNSTEWARD_FINAL_STATUS` proof.

[`qualify-rw5-failure-concurrency.mjs`](../packages/runsteward-core/scripts/qualify-rw5-failure-concurrency.mjs) pins an owner-supplied local qualification root, creates or reuses exactly two retained physical Git worktrees from the accepted RW-4 base under different task-derived branches, repeats the focused matrix, and runs isolated worker probes from both worktrees. One probe intentionally stops while the other completes; a separate pre-rename process crash preserves the prior complete target and retained temporary evidence before an idempotent recovery. The worktrees are evidence and are never deleted by the qualifier. The qualifier performs no provider, network, remote, commit, push, branch-delete, worktree-delete, or imported-package action.

## Product boundaries

Bundled product trees remain intact and their product backlogs remain authoritative. The root core contains only provider-neutral behavior. RW-3 adapters consume provider-owned classifications through bounded local interfaces; they do not replace the bundled classification implementations. Therefore:

- Claude percentage windows and failure semantics stay Claude-specific.
- Codex JSONL, usage, supervision, and resume identity semantics stay Codex-specific.
- Unknown-state behavior remains asymmetric where the source products require it.
- Root integration status must not be used to infer that a package backlog item is complete.

The authoritative backlog paths are [`packages/claude-carry/ROADMAP.md`](../packages/claude-carry/ROADMAP.md), [`packages/codex-nightwatch/docs/backlog.md`](../packages/codex-nightwatch/docs/backlog.md), and [`packages/limit-aware-wrapup/BACKLOG.md`](../packages/limit-aware-wrapup/BACKLOG.md).

## Phase boundary

| Phase | Scope | Status |
|---|---|---|
| RW-1 | Versioned shared contracts and provider-neutral lifecycle primitives | Implemented; inactive |
| RW-2 | Scheduler, isolation allocation, collision enforcement, and child joins | Implemented; inactive |
| RW-3 | Typed provider evidence, thin Claude/Codex consumers, checkpoint production, resume/wrap orchestration | Implemented; no provider execution or live activation |
| RW-4 | Runtime ChoiceGate ingestion, authority/scope drift stop/reselection, and exact original-selection dispatch | Implemented; no ChoiceGate/provider invocation or live activation |
| RW-5 | Fault, crash, concurrency, and cross-surface qualification | Implemented; deterministic offline qualification only |
