# Roadmap

Claude Carry is **Windows-first by design.** The unattended runner leans on Windows wake timers
(modern standby) to bring the machine back at the exact moment a usage limit resets, so the core
stays small and the "wake at `reset_at`" guarantee is real rather than best-effort. Everything below
extends that core without weakening it.

## Near term
- **macOS & Linux wake support** — `pmset schedule` (macOS) and `rtcwake` / systemd timers (Linux)
  behind the existing `lib/wake.mjs` seam, so the same queue runs cross-platform.
- **`carry status --watch`** — a live view of the queue (running / waiting / parked / done) without
  tailing logs.
- **Richer handoff** — per-task diffs and cost surfaced in `carry handoff`, so the morning review is
  one screen.

## Later
- **Hosted / headless runner** — run the same queue on a small always-on box or CI runner, so resume
  doesn't depend on your laptop waking at all.
- **Pluggable guardrail policies** — per-project allow/deny sets and approval routing.
- **Multi-account / multi-window budgeting** — spread queued work across usage windows intelligently.

## Non-goals
- **Driving Claude Code's interactive TUI with synthetic keystrokes or screen-scraping.** Claude Carry
  exists precisely because that approach is brittle; it will always consume machine-readable surfaces
  (headless JSON event streams, session IDs) instead.
- **Becoming a framework or a VS Code extension.** It stays a small CLI plus a standalone runner.

Ideas and requests: open an issue. See [CONTRIBUTING.md](CONTRIBUTING.md).
