---
name: runsteward-supervise-run
description: "Supervise one bounded RunSteward run across declared lifecycle steps. Use for active orchestration; do not merely inspect, sense usage, select capabilities, or publish."
---

# RunSteward Supervise Run

## Outcome

Advance one accepted RunSteward plan through bounded supervision while preserving gates, leases, and child dependencies.

## Trigger

A user explicitly asks RunSteward to supervise or run an accepted task plan.

Reject read-only status requests, sensor-only requests, ChoiceGate selection, unqualified provider execution, or outward release work.

## Procedure

1. Verify the exact run, task, queue item, session, or gate identity required by this leaf.
2. Bind only the qualified sources `rw.carry-cli`, `rw.nightwatch`, `rw.scheduler`, `rw.child-join` through the family manifest; do not copy or reinterpret imported implementation logic.
3. Apply the declared internal dependencies: `runsteward-core-allocation-reservation`, `runsteward-core-child-dependency-evaluation`, `runsteward-core-scheduler-cas`.
4. Preserve bounded evidence, exact owner gates, and fail-closed behavior. Stop if required identity, evidence, permission, or state is absent.
5. Return the single outcome above with no unrelated lifecycle or outward action.

## Non-goals

- Do not select or rerank capabilities; ChoiceGate owns selection.
- Do not change capability lifecycle or priority; The external lifecycle authority owns those decisions.
- Do not install or activate skills, execute providers, mutate imported packages, use remotes, publish, or perform destructive cleanup.
- Do not silently invoke another public RunSteward leaf except the dependencies explicitly named above.
