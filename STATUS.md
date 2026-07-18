# RunSteward status

This file holds the precise integration state of the repository. The short version is in the
[README](README.md#status): the three bundled products work today; the shared core is implemented
and tested but deliberately inactive.

## What is live and what is not

- **Live:** the bundled products — [Claude Carry](packages/claude-carry/),
  [Limit-Aware Wrapup](packages/limit-aware-wrapup/), and
  [Codex Nightwatch](packages/codex-nightwatch/) — are usable tools with their own tests,
  documentation, and backlogs.
- **Inactive:** the root `@runsteward/*` packages and the sixteen skill definitions under
  `skills/` are packaged in a *candidate* state — prepared, verified, and awaiting an explicit
  activation decision. The plugin and CLI surfaces route and describe; they do not execute a
  provider, install a skill, or perform any outward action (no network call, no remote write, no
  publication).

## Implementation phases

The shared core was built in five phases (labelled RW-1 through RW-5 in
[`docs/architecture.md`](docs/architecture.md)). All five are implemented and covered by the
offline test suites; none is activated as a live runtime.

| Phase | Scope | State |
|---|---|---|
| RW-1 | Versioned shared contracts and provider-neutral lifecycle primitives | Implemented; inactive |
| RW-2 | Scheduler, isolation allocation, collision enforcement, and child joins | Implemented; inactive |
| RW-3 | Typed provider evidence, thin Claude/Codex consumers, checkpoint production, resume/wrap orchestration | Implemented; no provider execution or live activation |
| RW-4 | Runtime receipt ingestion, authority/scope drift stop, and exact original-selection dispatch | Implemented; no live activation |
| RW-5 | Fault, crash, concurrency, and cross-surface qualification | Implemented; deterministic offline qualification only |

## Authorities outside this repository

Two responsibilities are deliberately owned by companion systems that are not part of this
repository:

- **Capability inventory and lifecycle policy** belong to an external lifecycle authority.
  RunSteward consumes the capability state that authority declares; it never invents capability
  state or acts as a second registry.
- **Capability selection** belongs to ChoiceGate. ChoiceGate emits a decision *receipt* — a
  hash-bound, immutable record of which capability was selected and under what conditions.
  RunSteward validates and freezes that receipt and may dispatch only the original selection,
  after exact checks of authority, request, scope, preconditions, and owner gates (an
  *owner-gated* route stays stopped until the run's event chain proves a human owner explicitly
  approved it). A stale receipt or lease remains evidence; it never authorizes silent takeover or
  substitution.

The full boundary map is in [`docs/architecture.md`](docs/architecture.md) and
[`contracts/README.md`](contracts/README.md).

## Gates before activation

From [`ROADMAP.md`](ROADMAP.md), the durable gates that must pass before the candidate surfaces go
live:

- Host-backed CI proof from the exact release candidate.
- An explicit lifecycle-authority decision for any install, exposure, activation, promotion, or
  predecessor supersession.
- An explicit owner decision for predecessor privacy or archive actions after successor parity is
  accepted.

## What the root surfaces will not do

None of the root packages, in their current state, authorizes a provider call, a remote write, a
live-skill change, a publication, a predecessor archive, an edit to a bundled product's tree, a
history rewrite, or a destructive cleanup. Root integration status must not be read as a claim
that any bundled product's backlog item is complete; the product backlogs remain authoritative
([Claude Carry](packages/claude-carry/ROADMAP.md),
[Codex Nightwatch](packages/codex-nightwatch/docs/backlog.md),
[Limit-Aware Wrapup](packages/limit-aware-wrapup/BACKLOG.md)).
