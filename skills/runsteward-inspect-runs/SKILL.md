---
name: runsteward-inspect-runs
description: "Read existing RunSteward queue and run state without mutation. Use for list, status, show, logs, plans, guardrails, or budget evidence; do not approve or change state."
---

# RunSteward Inspect Runs

## Outcome

Return one bounded read-only inspection of existing queue or run evidence.

## Trigger

A user asks to list, inspect, show, explain, or report current state without changing it.

Reject approvals, dispatch-state changes, queue reorder, checkpoint creation, stop, resume, cancellation, cleanup, or any write.

## Procedure

1. Verify the exact run, task, queue item, session, or gate identity required by this leaf.
2. Bind only the qualified sources `rw.carry-cli`, `rw.nightwatch`, `rw.limit-status`, `rw.live-landing` through the family manifest; do not copy or reinterpret imported implementation logic.
3. Apply the declared internal dependencies: none.
4. Preserve bounded evidence, exact owner gates, and fail-closed behavior. Stop if required identity, evidence, permission, or state is absent.
5. Return the single outcome above with no unrelated lifecycle or outward action.

## Non-goals

- Do not select or rerank capabilities; ChoiceGate owns selection.
- Do not change capability lifecycle or priority; The external lifecycle authority owns those decisions.
- Do not install or activate skills, execute providers, mutate imported packages, use remotes, publish, or perform destructive cleanup.
- Do not silently invoke another public RunSteward leaf except the dependencies explicitly named above.
