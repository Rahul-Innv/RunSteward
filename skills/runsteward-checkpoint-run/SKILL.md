---
name: runsteward-checkpoint-run
description: "Persist one complete resumable RunSteward checkpoint. Use for checkpointing an existing run; do not close, stop, resume, report, commit, or publish the attempt."
---

# RunSteward Checkpoint Run

## Outcome

Create one digest-bound complete checkpoint that preserves exact run, plan, repository, lease, and provider identity.

## Trigger

A user or coordinator explicitly requests a resumable checkpoint for one existing RunSteward run.

Reject incomplete identity, unknown provider binding, attempt closure, resume, terminal reporting, Git mutation, provider execution, and outward writes.

## Procedure

1. Verify the exact run, task, queue item, session, or gate identity required by this leaf.
2. Bind only the qualified sources `rw.nightwatch`, `rw.wrap-skill`, `rw.invariants` through the family manifest; do not copy or reinterpret imported implementation logic.
3. Apply the declared internal dependencies: `runsteward-core-contract-validation`, `runsteward-core-atomic-write`.
4. Preserve bounded evidence, exact owner gates, and fail-closed behavior. Stop if required identity, evidence, permission, or state is absent.
5. Return the single outcome above with no unrelated lifecycle or outward action.

## Non-goals

- Do not select or rerank capabilities; ChoiceGate owns selection.
- Do not change capability lifecycle or priority; The external lifecycle authority owns those decisions.
- Do not install or activate skills, execute providers, mutate imported packages, use remotes, publish, or perform destructive cleanup.
- Do not silently invoke another public RunSteward leaf except the dependencies explicitly named above.
