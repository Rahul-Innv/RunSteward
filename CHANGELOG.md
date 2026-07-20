# Changelog

All notable changes to RunSteward will be documented here.

## [Unreleased]

## [0.1.1] - 2026-07-19

This patch establishes a new reviewable source boundary without inventing provenance for the
historical, untagged `0.1.0` PyPI upload. The imported subpackages retain their independent
versions and release histories.

### Added

- Added conventional `-h` and `--help` aliases to the route-only CLI.
- Added Repository, Issues, and Changelog links to the Python package metadata.

### Fixed

- Made the public queue demonstration runnable and documented every prerequisite checked by the
  readiness doctor.
- Made source-binding checksums line-ending-invariant and kept Windows-only filesystem identity
  cases explicitly platform-gated.

### Security

- Parked general script execution and mutating Git commands by default so unattended work cannot
  cross those approval boundaries merely because a command appears in a task description.

## [0.1.0]

- Consolidated the existing Claude Carry, Codex Nightwatch, and Limit-Aware Wrapup capabilities.
- Added provider-neutral lifecycle contracts, scheduler primitives, thin provider adapters, and
  bounded evidence handling.
- Added the inactive RunSteward atomic family and route-only CLI.
- Added fail-closed ingestion of exact frozen ChoiceGate receipts without reranking or invoking
  ChoiceGate.
- Added deterministic offline failure and concurrency qualification without adding a runtime
  capability.
- Packaged the deterministic contract-verification surface as the `runsteward` Python
  distribution.

This entry records the historical PyPI distribution state. No matching Git tag or GitLab Release
exists, so it does not establish artifact-to-commit provenance. All skills remain inactive pending
a separate lifecycle-authority approval.

[Unreleased]: https://gitlab.com/krahul02004/RunSteward/-/compare/v0.1.1...main
[0.1.1]: https://gitlab.com/krahul02004/RunSteward/-/tags/v0.1.1
[0.1.0]: https://pypi.org/project/runsteward/0.1.0/
