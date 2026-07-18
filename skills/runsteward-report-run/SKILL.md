---
name: runsteward-report-run
description: "Materialize one evidence-bound RunSteward attempt or final report. Use for reports and handoffs; do not change lifecycle state, claim success without proof, or expose raw evidence."
---

# RunSteward Report Run

## Outcome

Produce one bounded report or handoff whose final form carries the literal RUNSTEWARD_FINAL_STATUS marker.

## Trigger

A user or coordinator explicitly asks for an attempt report, final report, or bounded handoff for one RunSteward run.

Reject checkpoint creation, lifecycle transition, approval, raw transcript export, identity or secret exposure, merge, release, and publication.

## Procedure

1. Verify the exact run, task, queue item, session, or gate identity required by this leaf.
2. Bind only the qualified sources `rw.carry-cli`, `rw.nightwatch`, `rw.invariants` through the family manifest; do not copy or reinterpret imported implementation logic.
3. Apply the declared internal dependencies: `runsteward-core-contract-validation`, `runsteward-core-canonical-json`.
4. Preserve bounded evidence, exact owner gates, and fail-closed behavior. Stop if required identity, evidence, permission, or state is absent.
5. Return the single outcome above with no unrelated lifecycle or outward action.

## Non-goals

- Do not select or rerank capabilities; ChoiceGate owns selection.
- Do not change capability lifecycle or priority; The external lifecycle authority owns those decisions.
- Do not install or activate skills, execute providers, mutate imported packages, use remotes, publish, or perform destructive cleanup.
- Do not silently invoke another public RunSteward leaf except the dependencies explicitly named above.
