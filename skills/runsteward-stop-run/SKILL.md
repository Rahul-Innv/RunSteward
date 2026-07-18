---
name: runsteward-stop-run
description: "Close one RunSteward attempt as resumable stopped. Use for graceful attempt closure; do not cancel terminally, checkpoint, resume, hard-delete, or claim objective completion."
---

# RunSteward Stop Run

## Outcome

Produce one evidence-bound stopped transition that remains eligible only for a separately checked resume.

## Trigger

A user or coordinator explicitly asks to stop one current RunSteward attempt without cancelling the run.

Reject terminal cancellation, checkpoint-only requests, immediate resume, success claims, cleanup, provider calls, and outward actions.

## Procedure

1. Verify the exact run, task, queue item, session, or gate identity required by this leaf.
2. Bind only the qualified sources `rw.carry-cli`, `rw.nightwatch`, `rw.invariants` through the family manifest; do not copy or reinterpret imported implementation logic.
3. Apply the declared internal dependencies: `runsteward-core-contract-validation`, `runsteward-core-event-fold`, `runsteward-core-lease-release`.
4. Preserve bounded evidence, exact owner gates, and fail-closed behavior. Stop if required identity, evidence, permission, or state is absent.
5. Return the single outcome above with no unrelated lifecycle or outward action.

## Non-goals

- Do not select or rerank capabilities; ChoiceGate owns selection.
- Do not change capability lifecycle or priority; The external lifecycle authority owns those decisions.
- Do not install or activate skills, execute providers, mutate imported packages, use remotes, publish, or perform destructive cleanup.
- Do not silently invoke another public RunSteward leaf except the dependencies explicitly named above.
