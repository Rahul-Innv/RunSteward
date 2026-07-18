# RunSteward

RunSteward is an integration repository for long-running agent operations across sessions and
isolated worktrees. It owns the shared execution lifecycle: queueing, budgets, checkpoints, stop
rules, resume, and handoff. Capability policy, capability selection, cross-agent transport, release
workflows, research, and design remain with their separate canonical owners.

The provider-neutral core defines deterministic JSON digests, lifecycle event folding, contract
invariants, checkpoint and lease bindings, final-report proof, atomic JSON replacement,
collision-free task allocation, exclusive lease locks, digest-guarded scheduler updates,
proof-bound child dependencies, typed nonconvertible budget evidence, a coordinator-only wrap plan,
and a pure receipt-ingestion gate. Stale leases and stale ChoiceGate receipts remain evidence and
never authorize silent takeover or substitution. Provider-specific interpretation remains in the
bundled products; the RunSteward-owned sensors and adapters consume their bounded outputs without
copying provider calls or raw transcripts. The external lifecycle authority remains authoritative
for capability inventory and lifecycle policy; ChoiceGate remains authoritative for capability
selection. RunSteward dispatches only the original executable atomic or bundle selection after
exact authority, request, scope, precondition, and owner-gate checks.

## RunSteward-owned packages

| Package | Path | Role |
|---|---|---|
| `@runsteward/core` | `packages/runsteward-core/` | Provider-neutral contracts, invariants, scheduler, evidence, checkpoint, wrap, and frozen ChoiceGate ingestion primitives |
| `@runsteward/cli` | `packages/runsteward-cli/` | Inactive route-only atomic-family CLI; emits membership and dispatch receipts but executes no lifecycle or outward action |
| `@runsteward/sensor-claude-limits` | `packages/runsteward-sensor-claude-limits/` | Typed Claude percentage-window evidence through the bundled Limit-Aware extractor; no continue/checkpoint/stop decision |
| `@runsteward/sensor-codex-usage` | `packages/runsteward-sensor-codex-usage/` | Typed token evidence from classified Codex Nightwatch analysis; no raw-event interpretation or lifecycle decision |
| `@runsteward/adapter-claude-code` | `packages/runsteward-adapter-claude-code/` | Thin Claude Carry/Limit-Aware advisory, checkpoint, handoff, wrap, and resume binding |
| `@runsteward/adapter-codex` | `packages/runsteward-adapter-codex/` | Thin Codex advisory, checkpoint, handoff, wrap, and resume binding |

## Bundled products

| Product | Path | Product backlog |
|---|---|---|
| Claude Carry | `packages/claude-carry/` | [`packages/claude-carry/ROADMAP.md`](packages/claude-carry/ROADMAP.md) |
| Codex Nightwatch | `packages/codex-nightwatch/` | [`packages/codex-nightwatch/docs/backlog.md`](packages/codex-nightwatch/docs/backlog.md) |
| Limit-Aware Wrapup | `packages/limit-aware-wrapup/` | [`packages/limit-aware-wrapup/BACKLOG.md`](packages/limit-aware-wrapup/BACKLOG.md) |

Each bundled product keeps its own documentation, tests, and backlog.

## Python package

The repository root builds as the Python distribution `runsteward`. It packages the deterministic
contract-verification surface (`runsteward.contract_compat`): the restricted canonical-JSON digest,
the strict fixture loaders, and the offline schema/fixture/receipt verifier. After installation the
`runsteward-verify-contracts` console script replays the full offline contract verification against
a repository checkout.

```
python -m build --no-isolation
python -m twine check dist/*
```

## Validation

All validation is deterministic and offline:

```
node packages/runsteward-core/scripts/run-all-tests.mjs
node --test tests/runsteward-atomic-family.test.mjs
```

The first command runs fixture validation, the Python contract-compatibility verifier, and every
package-level Node test suite. The second validates the sixteen-skill atomic family surface.

## Repository guides

- [`docs/architecture.md`](docs/architecture.md) — architecture and boundary index
- [`contracts/README.md`](contracts/README.md) — contract map, digest rules, and local validation commands
- [`docs/contracts.md`](docs/contracts.md) — lifecycle, fold, checkpoint, lease, and final-report semantics
- [`ROADMAP.md`](ROADMAP.md) — deferred capability work
- [`CHANGELOG.md`](CHANGELOG.md) — notable changes

## Status

The sixteen atomic skills are packaged in an inactive, candidate state. The plugin and CLI surfaces
route and describe; they do not execute a provider, install a skill, or perform an outward action.
The external lifecycle authority governs capability state; ChoiceGate is the distinct
capability-selection authority.

## License

MIT. See [`LICENSE`](LICENSE).
