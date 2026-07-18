---
name: runsteward-check-readiness
description: "Diagnose RunSteward prerequisites, configuration, paths, wake support, and recoverability without mutation. Use for readiness checks; do not install, configure, schedule, authenticate, or execute."
---

# RunSteward Check Readiness

## Outcome

Return one read-only readiness verdict with exact missing, drifted, or blocked prerequisites.

## Trigger

A user asks whether RunSteward or one of its local surfaces is ready before execution.

Reject editor installation, live configuration, scheduler mutation, OAuth refresh, provider execution, remediation, or publication.

## Procedure

1. Verify the exact run, task, queue item, session, or gate identity required by this leaf.
2. Bind only the qualified sources `rw.carry-cli`, `rw.nightwatch`, `rw.limit-validate` through the family manifest; do not copy or reinterpret imported implementation logic.
3. Apply the declared internal dependencies: `runsteward-core-contract-validation`.
4. Preserve bounded evidence, exact owner gates, and fail-closed behavior. Stop if required identity, evidence, permission, or state is absent.
5. Return the single outcome above with no unrelated lifecycle or outward action.

## Non-goals

- Do not select or rerank capabilities; ChoiceGate owns selection.
- Do not change capability lifecycle or priority; The external lifecycle authority owns those decisions.
- Do not install or activate skills, execute providers, mutate imported packages, use remotes, publish, or perform destructive cleanup.
- Do not silently invoke another public RunSteward leaf except the dependencies explicitly named above.
