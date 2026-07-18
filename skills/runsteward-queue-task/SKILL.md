---
name: runsteward-queue-task
description: "Queue exactly one new RunSteward task request. Use when the user wants to add work to the queue; do not reorder, dispatch, adopt, start, stop, or delete a run."
---

# RunSteward Queue Task

## Outcome

Produce one validated queue-task request for a new task identity.

## Trigger

A user explicitly asks to add or queue one new task for later RunSteward execution.

Reject requests whose decisive intent is reordering, dispatch control, live-session adoption, supervision, stopping, cancellation, or deletion.

## Procedure

1. Verify the exact run, task, queue item, session, or gate identity required by this leaf.
2. Bind only the qualified sources `rw.carry-cli`, `rw.live-carry-queue` through the family manifest; do not copy or reinterpret imported implementation logic.
3. Apply the declared internal dependencies: none.
4. Preserve bounded evidence, exact owner gates, and fail-closed behavior. Stop if required identity, evidence, permission, or state is absent.
5. Return the single outcome above with no unrelated lifecycle or outward action.

## Non-goals

- Do not select or rerank capabilities; ChoiceGate owns selection.
- Do not change capability lifecycle or priority; The external lifecycle authority owns those decisions.
- Do not install or activate skills, execute providers, mutate imported packages, use remotes, publish, or perform destructive cleanup.
- Do not silently invoke another public RunSteward leaf except the dependencies explicitly named above.
