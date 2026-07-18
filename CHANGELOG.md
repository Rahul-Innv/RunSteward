# Changelog

All notable changes to RunSteward will be documented here.

## 0.1.0

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

This entry records candidate state. All skills remain inactive pending a separate
lifecycle-authority approval.
