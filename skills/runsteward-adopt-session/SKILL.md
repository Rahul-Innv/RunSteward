---
name: runsteward-adopt-session
description: "Arm continuation for the current non-RunSteward live provider session. Use only for adoption after a limit reset; do not resume an existing RunSteward run."
---

# RunSteward Adopt Session

## Outcome

Produce one adoption record for the current live session that is not already a RunSteward run.

## Trigger

A user explicitly asks RunSteward to adopt the currently active non-RunSteward session for later continuation.

Reject existing RunSteward run resume, a different or historical session, an unverified live-session identity, or immediate provider execution.

## Procedure

1. Verify the exact run, task, queue item, session, or gate identity required by this leaf.
2. Bind only the qualified sources `rw.carry-cli`, `rw.live-continue-reset` through the family manifest; do not copy or reinterpret imported implementation logic.
3. Apply the declared internal dependencies: none.
4. Preserve bounded evidence, exact owner gates, and fail-closed behavior. Stop if required identity, evidence, permission, or state is absent.
5. Return the single outcome above with no unrelated lifecycle or outward action.

## Non-goals

- Do not select or rerank capabilities; ChoiceGate owns selection.
- Do not change capability lifecycle or priority; The external lifecycle authority owns those decisions.
- Do not install or activate skills, execute providers, mutate imported packages, use remotes, publish, or perform destructive cleanup.
- Do not silently invoke another public RunSteward leaf except the dependencies explicitly named above.
