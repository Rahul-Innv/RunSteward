---
name: runsteward-reorder-queue
description: "Move one existing pending RunSteward task to a new queue position. Use for queue-order changes; do not add, dispatch, pause, cancel, start, or stop work."
---

# RunSteward Reorder Queue

## Outcome

Produce one validated reorder request for an existing pending task.

## Trigger

A user explicitly asks to move an already queued task before, after, up, down, or to an exact pending position.

Reject new-task creation, dispatch-state changes, running-work control, cancellation, and destructive queue deletion.

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
