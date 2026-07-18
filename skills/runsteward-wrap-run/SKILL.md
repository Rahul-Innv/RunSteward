---
name: runsteward-wrap-run
description: "Coordinate one explicit graceful RunSteward wrap through checkpoint, report, and stop leaves. Use for wrap-up; do not duplicate those procedures or add Git, provider, cleanup, or publication actions."
---

# RunSteward Wrap Run

## Outcome

Produce one coordinator plan that delegates exactly checkpoint, report, and resumable stop outcomes.

## Trigger

A user explicitly asks to wrap up one RunSteward attempt gracefully.

Reject automatic Git add or commit, provider execution, terminal cancellation, hard cleanup, merge, branch deletion, and silent policy decisions.

## Procedure

1. Verify the exact run, task, queue item, session, or gate identity required by this leaf.
2. Bind only the qualified sources `rw.wrap-skill`, `rw.nightwatch` through the family manifest; do not copy or reinterpret imported implementation logic.
3. Apply the declared internal dependencies: `runsteward-checkpoint-run`, `runsteward-report-run`, `runsteward-stop-run`.
4. Preserve bounded evidence, exact owner gates, and fail-closed behavior. Stop if required identity, evidence, permission, or state is absent.
5. Return the single outcome above with no unrelated lifecycle or outward action.

## Non-goals

- Do not select or rerank capabilities; ChoiceGate owns selection.
- Do not change capability lifecycle or priority; The external lifecycle authority owns those decisions.
- Do not install or activate skills, execute providers, mutate imported packages, use remotes, publish, or perform destructive cleanup.
- Do not silently invoke another public RunSteward leaf except the dependencies explicitly named above.
