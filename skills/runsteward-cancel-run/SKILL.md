---
name: runsteward-cancel-run
description: "Cancel exactly one RunSteward run terminally while retaining evidence. Use for explicit cancellation; never hard-delete queue, run, worktree, checkpoint, or evidence state."
---

# RunSteward Cancel Run

## Outcome

Produce one terminal cancelled transition with retained evidence for an identified run.

## Trigger

A user explicitly asks to cancel one queued or active RunSteward run permanently.

Reject resumable stop requests, queue removal by deletion, cleanup, branch deletion, worktree deletion, or evidence erasure.

## Procedure

1. Verify the exact run, task, queue item, session, or gate identity required by this leaf.
2. Bind only the qualified sources `rw.carry-cli`, `rw.invariants` through the family manifest; do not copy or reinterpret imported implementation logic.
3. Apply the declared internal dependencies: `runsteward-core-contract-validation`, `runsteward-core-event-fold`.
4. Preserve bounded evidence, exact owner gates, and fail-closed behavior. Stop if required identity, evidence, permission, or state is absent.
5. Return the single outcome above with no unrelated lifecycle or outward action.

## Non-goals

- Do not select or rerank capabilities; ChoiceGate owns selection.
- Do not change capability lifecycle or priority; The external lifecycle authority owns those decisions.
- Do not install or activate skills, execute providers, mutate imported packages, use remotes, publish, or perform destructive cleanup.
- Do not silently invoke another public RunSteward leaf except the dependencies explicitly named above.
