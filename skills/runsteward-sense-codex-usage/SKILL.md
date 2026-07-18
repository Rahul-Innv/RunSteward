---
name: runsteward-sense-codex-usage
description: "Convert classified Codex usage analysis into typed evidence only. Use for Codex token sensing; never decide continue, checkpoint, stop, wrap, or budget policy."
---

# RunSteward Sense Codex Usage

## Outcome

Emit one typed Codex usage-evidence envelope with bounded redacted references.

## Trigger

A user or RunSteward coordinator asks for classified Codex usage evidence.

Reject raw JSONL interpretation, lifecycle decisions, cross-metric conversion, invented zero values, provider execution, and identity exposure.

## Procedure

1. Verify the exact run, task, queue item, session, or gate identity required by this leaf.
2. Bind only the qualified sources `rw.nightwatch` through the family manifest; do not copy or reinterpret imported implementation logic.
3. Apply the declared internal dependencies: `runsteward-core-contract-validation`.
4. Preserve bounded evidence, exact owner gates, and fail-closed behavior. Stop if required identity, evidence, permission, or state is absent.
5. Return the single outcome above with no unrelated lifecycle or outward action.

## Non-goals

- Do not select or rerank capabilities; ChoiceGate owns selection.
- Do not change capability lifecycle or priority; The external lifecycle authority owns those decisions.
- Do not install or activate skills, execute providers, mutate imported packages, use remotes, publish, or perform destructive cleanup.
- Do not silently invoke another public RunSteward leaf except the dependencies explicitly named above.
