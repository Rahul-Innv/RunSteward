---
name: runsteward-resume-run
description: "Resume one verified existing RunSteward run from a complete checkpoint and successor lease. Use only for RunSteward resume; do not adopt a current non-RunSteward session."
---

# RunSteward Resume Run

## Outcome

Authorize one resumed attempt only after checkpoint, identity, predecessor release, and successor lease all validate.

## Trigger

A user explicitly asks to resume a named existing RunSteward run from its retained checkpoint.

Reject live-session adoption, missing or partial checkpoint, unknown or mismatched identity, active predecessor lease, reused lease, or provider execution without its gate.

## Procedure

1. Verify the exact run, task, queue item, session, or gate identity required by this leaf.
2. Bind only the qualified sources `rw.carry-cli`, `rw.nightwatch`, `rw.scheduler`, `rw.invariants` through the family manifest; do not copy or reinterpret imported implementation logic.
3. Apply the declared internal dependencies: `runsteward-core-contract-validation`, `runsteward-core-successor-lease`, `runsteward-core-event-fold`.
4. Preserve bounded evidence, exact owner gates, and fail-closed behavior. Stop if required identity, evidence, permission, or state is absent.
5. Return the single outcome above with no unrelated lifecycle or outward action.

## Non-goals

- Do not select or rerank capabilities; ChoiceGate owns selection.
- Do not change capability lifecycle or priority; The external lifecycle authority owns those decisions.
- Do not install or activate skills, execute providers, mutate imported packages, use remotes, publish, or perform destructive cleanup.
- Do not silently invoke another public RunSteward leaf except the dependencies explicitly named above.
