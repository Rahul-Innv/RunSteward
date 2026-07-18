# Windows Task Scheduler Guide

This guide is for launching `nightwatch.py supervise` from Windows Task Scheduler without relying on an already-open Codex app window.

## Checklist

- Use an explicit Python executable and the absolute path to `scripts\nightwatch.py`.
- Use an explicit `--codex-bin` path when `codex` may resolve to a WindowsApps shim.
- Set **Start in** to the target workspace, not to the Nightwatch repository unless Nightwatch is supervising itself.
- Keep `--state`, `--log-dir`, JSONL, and transcript paths clear and intentional. Run `doctor` first if the paths are outside the workspace.
- Keep runtime artifacts such as `.codex\nightwatch` and `.nightwatch` out of product commits unless the owner explicitly asks to preserve them.
- Use bounded values for `--max-cycles`, `--timeout-seconds`, and `--inactivity-timeout-seconds`.
- Do not pass `danger-full-access`, bypass flags, or `approval_policy=never` to unattended runs.
- Treat stderr warnings as evidence, not automatic failure. Check the final report and transcript before resuming.
- Confirm stale locks and already-running Codex processes before starting a second scheduled run for the same workspace.
- Generate or review a report after every scheduled run.

## Preflight

Run this from the target workspace before creating the scheduled task:

```powershell
python -B C:\path\to\codex-nightwatch\scripts\nightwatch.py doctor `
  --cwd C:\path\to\target-workspace `
  --state-dir C:\path\to\target-workspace\.codex\nightwatch
```

If `runtime_artifact_warnings` reports untracked Nightwatch files, either add a local ignore rule or move state outside the product repo. Do not commit those runtime files unless the owner explicitly asks.

## Example Action

Program:

```text
C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
```

Arguments:

```text
-NoProfile -ExecutionPolicy Bypass -Command "python -B C:\path\to\codex-nightwatch\scripts\nightwatch.py supervise --state C:\path\to\target-workspace\.codex\nightwatch\state.json --log-dir C:\path\to\target-workspace\.codex\nightwatch --max-cycles 3 --timeout-seconds 21600 --inactivity-timeout-seconds 1800 --codex-bin C:\Users\you\AppData\Local\OpenAI\Codex\bin\<version>\codex.exe --execute"
```

Start in:

```text
C:\path\to\target-workspace
```

Use `--resume-after-stop` only when the owner explicitly approved resuming after stop thresholds or stop signals. Without that flag, `supervise` treats stop decisions as terminal and leaves the owner a report to review.
