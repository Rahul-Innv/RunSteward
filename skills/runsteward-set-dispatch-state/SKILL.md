---
name: runsteward-set-dispatch-state
description: "Pause or unpause future RunSteward queue dispatch. Use for dispatcher-state changes; do not stop a running attempt, reorder tasks, or change task terminal state."
---

# RunSteward Set Dispatch State

## Outcome

Produce one validated dispatcher pause or unpause request.

## Trigger

A user explicitly asks to pause or resume future queue dispatch without changing a running attempt.

Reject run stop, run resume, queue reorder, task creation, cancellation, wake scheduling, or provider execution.

## Procedure

1. Verify the exact run, task, queue item, session, or gate identity required by this leaf.
2. Bind only the qualified sources `rw.carry-cli` through the family manifest; do not copy or reinterpret imported implementation logic.
3. Apply the declared internal dependencies: none.
4. Preserve bounded evidence, exact owner gates, and fail-closed behavior. Stop if required identity, evidence, permission, or state is absent.
5. Return the single outcome above with no unrelated lifecycle or outward action.

## Non-goals

- Do not select or rerank capabilities; ChoiceGate owns selection.
- Do not change capability lifecycle or priority; The external lifecycle authority owns those decisions.
- Do not install or activate skills, execute providers, mutate imported packages, use remotes, publish, or perform destructive cleanup.
- Do not silently invoke another public RunSteward leaf except the dependencies explicitly named above.
