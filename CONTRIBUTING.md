# Contributing to RunSteward

RunSteward changes must preserve ownership, imported history, and fail-closed lifecycle behavior.

## Before changing code

1. Identify whether the change belongs to RunSteward, a bundled product, the external lifecycle
   authority, ChoiceGate, Cairnspan, ReleaseBench, or PixelHelm.
2. Keep net-new capability expansion in `ROADMAP.md` until separately approved.
3. Do not edit bundled product bytes from a RunSteward-owned integration lane.
4. Use an isolated worktree and preserve the exact base commit and tree.

## Validation

Run the deterministic offline commands:

```
node packages/runsteward-core/scripts/run-all-tests.mjs
node --test tests/runsteward-atomic-family.test.mjs
```

A candidate must have an exact diff and passing tests. A known baseline failure is acceptable only
when reproduced on the untouched base and recorded separately.

## Closed actions

Do not install or activate skills, call providers, change remotes, publish packages, alter repository
visibility, create a tag or Release, or archive predecessor products without a new exact approval.
