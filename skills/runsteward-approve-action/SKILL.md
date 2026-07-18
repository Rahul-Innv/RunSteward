---
name: runsteward-approve-action
description: "Record one explicit owner approval for an already identified RunSteward gate. Use only to bind approval evidence; do not invent the decision or execute the action."
---

# RunSteward Approve Action

## Outcome

Bind one exact approval to one pending RunSteward action and scope.

## Trigger

A user explicitly approves a named pending RunSteward action with enough identity and scope to bind it.

Reject vague approval, capability selection, merge or branch deletion, execution, and any action outside the approval's exact scope.

## Procedure

1. Verify the exact run, task, queue item, session, or gate identity required by this leaf.
2. Bind only the qualified sources `rw.carry-cli`, `rw.live-landing` through the family manifest; do not copy or reinterpret imported implementation logic.
3. Apply the declared internal dependencies: `runsteward-core-contract-validation`.
4. Preserve bounded evidence, exact owner gates, and fail-closed behavior. Stop if required identity, evidence, permission, or state is absent.
5. Return the single outcome above with no unrelated lifecycle or outward action.

## Non-goals

- Do not select or rerank capabilities; ChoiceGate owns selection.
- Do not change capability lifecycle or priority; The external lifecycle authority owns those decisions.
- Do not install or activate skills, execute providers, mutate imported packages, use remotes, publish, or perform destructive cleanup.
- Do not silently invoke another public RunSteward leaf except the dependencies explicitly named above.
