<p align="center">
  <img src="docs/assets/logo.png" alt="RunSteward logo" width="180">
</p>

# RunSteward

[![pipeline status](https://gitlab.com/krahul02004/RunSteward/badges/main/pipeline.svg)](https://gitlab.com/krahul02004/RunSteward/-/commits/main)
[![PyPI version](https://img.shields.io/pypi/v/runsteward)](https://pypi.org/project/runsteward/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

RunSteward is for developers who hand Claude Code (or OpenAI's Codex CLI) work that takes longer
than one sitting (big refactors, migrations, overnight builds) and can't sit there watching it.
It bundles the tools that keep that work moving unattended: queue tasks with a spending cap,
checkpoint progress, resume automatically when a usage limit resets, and read a reviewable summary
of what happened in the morning. Without it, hitting a usage limit mid-task means coming back to a
stopped session with half-applied edits and no record of what was done or what to do next.

## Getting started

- **Prerequisites:** Node 18 or newer and Git. The full Claude Carry doctor also requires the standalone Claude Code CLI 2.1.139 or newer and at least one folder under `~/.claude/skills`. On Windows it additionally checks wake timers and, on Modern Standby laptops, lid-close and AC sleep settings. The Node surfaces have no npm dependencies. Clone to a short path and turn on long paths first because a few fixture filenames are long (exact command in the [Windows note](#install) below).
- **Install:** the Node surfaces, including Claude Carry, run straight from a clone with no `npm install`: `git clone https://gitlab.com/krahul02004/RunSteward.git` and `cd RunSteward`. The Python contract verifier is published separately as `pip install runsteward`. Fuller setup is under [Install](#install).
- **Check it works:** from the checkout, run `node packages/claude-carry/bin/carry.mjs doctor`. It prints one line per applicable check and finishes with `All N checks passed.` A ready Modern Standby Windows host currently runs seven checks; other platforms and a missing Claude CLI produce a different count, and every failed prerequisite is named.

## 30-second demo

Queue a task for [Claude Carry](packages/claude-carry/), the overnight runner bundled in this repo.
From the RunSteward checkout, replace `X:\my-app` with the absolute path to your project:

```
node packages/claude-carry/bin/carry.mjs add "refactor the auth module into smaller files" --goal "npm test passes" --budget 5 --cwd "X:\my-app"
```

```
queued t1: refactor the auth module into smaller files
  done when: npm test passes
  model: sonnet (default)  budget: $5
  work: branch carry/t1 in your project (shows in Source Control)
  in: X:\my-app
```

That task now waits in a plain-JSON queue. `carry run --until-idle` starts the night shift: each
task runs as headless Claude Code on its own `carry/<id>` branch, capped at its budget, with
guardrails that park risky actions for your approval instead of doing them. If your usage limit
hits, the runner reads the exact reset time from Claude Code's own event stream, wakes the PC at
that moment (on Windows), and resumes the same session. In the morning, `carry handoff` prints what
got done, what's parked for approval, and which branches to review. The full walkthrough is in
[Claude Carry's README](packages/claude-carry/README.md).

## What's inside

Three working products, plus the shared core being built underneath them.

### The products

| Product | What it does for you |
|---|---|
| [Claude Carry](packages/claude-carry/) (`packages/claude-carry/`) | Runs queued Claude Code tasks overnight: per-task budgets, an allow/deny guardrail set, automatic resume when your usage limit resets (including waking the PC), and a morning handoff. Can also adopt your *live* session so it continues by itself after a reset. |
| [Limit-Aware Wrapup](packages/limit-aware-wrapup/) (`packages/limit-aware-wrapup/`) | Ends a Claude Code session gracefully instead of mid-edit: watches your 5-hour and weekly usage windows and, just before the budget runs out, has the session commit its work-in-progress, write a handoff note, and stop clean. Silent the rest of the time. |
| [Codex Nightwatch](packages/codex-nightwatch/) (`packages/codex-nightwatch/`) | The same overnight discipline for OpenAI's Codex CLI: reads `codex exec --json` event streams, applies your token thresholds, checkpoints, stops on policy, produces a safe resume command and a morning report. |

Each product keeps its own README, tests, changelog, and backlog.

### The shared core

The `@runsteward/*` packages are the provider-neutral engine being extracted from those products:
implemented and fully tested, but not yet switched on as the runtime that drives them
(see [Status](#status)).

| Package | What it's for |
|---|---|
| `@runsteward/core` (`packages/runsteward-core/`) | Defines how a run is recorded, scheduled, checkpointed, resumed, and proven finished: the contracts and invariants everything else consumes |
| `@runsteward/cli` (`packages/runsteward-cli/`) | Lists and describes the sixteen planned run-management skills (queue, adopt, checkpoint, wrap, resume, report, …); it routes and describes but executes nothing yet |
| `@runsteward/sensor-claude-limits` (`packages/runsteward-sensor-claude-limits/`) | Turns Claude usage-window percentages into typed evidence the core can consume |
| `@runsteward/sensor-codex-usage` (`packages/runsteward-sensor-codex-usage/`) | Turns Codex token usage into typed evidence the core can consume |
| `@runsteward/adapter-claude-code` (`packages/runsteward-adapter-claude-code/`) | Thin binding from the core's checkpoint/wrap/resume contracts to Claude Code |
| `@runsteward/adapter-codex` (`packages/runsteward-adapter-codex/`) | Thin binding from the core's checkpoint/wrap/resume contracts to Codex |

A few core modules validate decision receipts from ChoiceGate, a companion selection tool that
lives outside this repository; that boundary is documented in
[`docs/architecture.md`](docs/architecture.md).

## How it works

Three ideas carry most of the engineering:

- **Runs are digest-linked event chains.** Every lifecycle fact (queued, running, checkpointed,
  stopped, …) is an ordered JSON event carrying a deterministic digest (a hash of the exact
  canonical bytes) linked to the previous event's digest. A run's current state is only accepted
  if it is the replay of one complete, unbroken chain, so any machine can verify what happened.
- **Resume requires a checkpoint and a lease.** A checkpoint captures everything needed to pick a
  run back up (branch, worktree, session identity); a lease is an exclusive, epoch-numbered claim
  on that run's branch and worktree. Two runners can never grab the same task, and a crashed run
  can be resumed without guessing.
- **Everything fails closed.** When evidence is missing, stale, or ambiguous, the core refuses to
  act rather than act on a guess: an unattended runner that guesses can destroy work while you
  sleep. The same rule shows up product-side as Claude Carry's guardrails and Limit-Aware Wrapup's
  do-nothing-if-unsure sensor.

Deeper reading: [`docs/architecture.md`](docs/architecture.md) (layer and boundary index),
[`contracts/README.md`](contracts/README.md) (contract map and digest rules),
[`docs/contracts.md`](docs/contracts.md) (lifecycle semantics).

## Install

The repository root builds as the Python distribution `runsteward`, which packages the offline
contract verifier and is published on PyPI:

```
pip install runsteward
runsteward-verify-contracts --root <path-to-a-runsteward-checkout>
```

Or run it straight from a clone (`git clone https://gitlab.com/krahul02004/RunSteward.git`,
`cd RunSteward`, `pip install .`, then `runsteward-verify-contracts --root .`).

> **Windows note:** some fixture filenames are over 100 characters, so a deep clone destination
> can push full paths past Windows' default 260-character limit, which breaks the clone
> ("Filename too long") and, later, the verifier. Clone to a short path (e.g. `C:\src\rs`) and
> enable long paths: `git clone -c core.longpaths=true https://gitlab.com/krahul02004/RunSteward.git`.

`runsteward-verify-contracts` replays the full contract verification (every schema, frozen
fixture, and digest vector under `contracts/`) against the checkout, entirely offline. The
distribution also builds offline (`python -m build --no-isolation`, then `python -m twine check dist/*`).

The Node surfaces run straight from the checkout, with no npm install:

```
node packages/claude-carry/bin/carry.mjs doctor        # Claude Carry health check
node packages/runsteward-cli/bin/runsteward.mjs list-skills
```

Claude Carry's one-time setup (installs the standalone Claude Code CLI if missing) is
[`packages/claude-carry/setup.ps1`](packages/claude-carry/setup.ps1).

### Run the tests

All validation is deterministic and offline:

```
node packages/runsteward-core/scripts/run-all-tests.mjs
node --test tests/runsteward-atomic-family.test.mjs
```

The first command runs fixture validation, the Python contract-compatibility verifier, and every
package-level Node test suite. The second validates the sixteen-skill definition surface.

## Status

The three bundled products are working, tested tools; the shared core underneath them is
implemented and fully tested, but not yet switched on as the engine that drives them. The precise
integration state and the gates before activation are in [STATUS.md](STATUS.md).

## License

MIT. See [`LICENSE`](LICENSE).
