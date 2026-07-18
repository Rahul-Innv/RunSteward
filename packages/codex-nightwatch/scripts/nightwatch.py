#!/usr/bin/env python3
"""Local helpers for usage-aware Codex run orchestration.

This module is intentionally stdlib-only. The MVP should be easy to run from a
fresh checkout without installing package dependencies.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import shutil
import shlex
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence


USAGE_KEYS = (
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
)

STOP_SIGNAL_WORDS = (
    "rate limit",
    "ratelimit",
    "quota",
    "usage limit",
    "limit reached",
    "too many requests",
    "429",
)


@dataclass(frozen=True)
class UsageSummary:
    turns: int
    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0
    reasoning_output_tokens: int = 0

    @property
    def billable_like_tokens(self) -> int:
        return self.input_tokens + self.output_tokens + self.reasoning_output_tokens

    @property
    def uncached_input_tokens(self) -> int:
        return max(0, self.input_tokens - self.cached_input_tokens)

    @property
    def fresh_pressure_tokens(self) -> int:
        return self.uncached_input_tokens + self.output_tokens + self.reasoning_output_tokens


@dataclass(frozen=True)
class BudgetDecision:
    action: str
    used_tokens: int
    remaining_tokens: int
    threshold_tokens: int
    reason: str


@dataclass(frozen=True)
class StopSignal:
    matched: bool
    reason: str = ""
    event_type: str = ""


@dataclass
class NightwatchState:
    version: int
    objective: str
    cwd: str
    prompt: str
    token_budget: int
    reserve_tokens: int
    checkpoint_ratio: float
    reset_after_minutes: int
    created_at: str
    updated_at: str
    status: str = "planned"
    thread_id: str | None = None
    run_log: str | None = None
    transcript_log: str | None = None
    resume_prompt: str | None = None
    planned_resume_at: str | None = None
    last_command: list[str] = field(default_factory=list)
    summary: dict[str, Any] = field(default_factory=dict)
    decision: dict[str, Any] = field(default_factory=dict)
    stop_signal: dict[str, Any] = field(default_factory=dict)
    checkpoints: list[dict[str, Any]] = field(default_factory=list)
    run_contract: dict[str, Any] = field(default_factory=dict)
    wrap_up: dict[str, Any] = field(default_factory=dict)


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def planned_resume_at(reset_after_minutes: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(minutes=reset_after_minutes)).replace(microsecond=0).isoformat()


def parse_iso_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}:{line_number}: invalid JSONL event") from exc
        if isinstance(event, dict):
            events.append(event)
    return events


def summarize_usage(events: Iterable[dict[str, Any]]) -> UsageSummary:
    totals = {key: 0 for key in USAGE_KEYS}
    turns = 0

    for event in events:
        if event.get("type") != "turn.completed":
            continue
        usage = event.get("usage")
        if not isinstance(usage, dict):
            continue
        turns += 1
        for key in USAGE_KEYS:
            value = usage.get(key, 0)
            if isinstance(value, int):
                totals[key] += value

    return UsageSummary(turns=turns, **totals)


def find_thread_id(events: Iterable[dict[str, Any]]) -> str | None:
    thread_id = None
    for event in events:
        value = event.get("thread_id") or event.get("threadId")
        if isinstance(value, str) and value.strip():
            thread_id = value.strip()
    return thread_id


def _event_text(event: dict[str, Any]) -> str:
    parts: list[str] = []
    for key in ("message", "error", "reason", "text"):
        value = event.get(key)
        if isinstance(value, str):
            parts.append(value)
        elif isinstance(value, dict):
            parts.append(json.dumps(value, sort_keys=True))
    return " ".join(parts).lower()


def detect_stop_signal(events: Iterable[dict[str, Any]]) -> StopSignal:
    for event in events:
        event_type = str(event.get("type", ""))
        if event_type in {"turn.failed", "error"}:
            text = _event_text(event)
            if "nightwatch inactivity timeout" in text:
                return StopSignal(
                    matched=True,
                    reason="Nightwatch inactivity timeout reached",
                    event_type=event_type,
                )
            if "nightwatch timeout" in text:
                return StopSignal(
                    matched=True,
                    reason="Nightwatch timeout reached",
                    event_type=event_type,
                )
            for word in STOP_SIGNAL_WORDS:
                if word in text:
                    return StopSignal(
                        matched=True,
                        reason=f"Codex event indicates a usage/rate limit: {word}",
                        event_type=event_type,
                    )
            if text:
                return StopSignal(
                    matched=True,
                    reason=f"Codex emitted a failure/error event: {text}",
                    event_type=event_type,
                )
            return StopSignal(
                matched=True,
                reason="Codex emitted a failure/error event",
                event_type=event_type,
            )
    return StopSignal(matched=False)


def decide_budget(
    summary: UsageSummary,
    token_budget: int,
    reserve_tokens: int,
    checkpoint_ratio: float,
    stop_signal: StopSignal | None = None,
) -> BudgetDecision:
    if token_budget <= 0:
        raise ValueError("token_budget must be positive")
    if reserve_tokens < 0:
        raise ValueError("reserve_tokens cannot be negative")
    if reserve_tokens >= token_budget:
        raise ValueError("reserve_tokens must be less than token_budget")
    if not 0 <= checkpoint_ratio <= 1:
        raise ValueError("checkpoint_ratio must be between 0 and 1")

    used = summary.billable_like_tokens
    remaining = token_budget - used
    checkpoint_at = int(token_budget * checkpoint_ratio)
    stop_at = token_budget - reserve_tokens

    if stop_signal and stop_signal.matched:
        return BudgetDecision(
            action="stop",
            used_tokens=used,
            remaining_tokens=max(0, remaining),
            threshold_tokens=stop_at,
            reason=stop_signal.reason,
        )
    if used >= stop_at:
        return BudgetDecision(
            action="stop",
            used_tokens=used,
            remaining_tokens=max(0, remaining),
            threshold_tokens=stop_at,
            reason="usage reached the stop threshold",
        )
    if used >= checkpoint_at:
        return BudgetDecision(
            action="checkpoint",
            used_tokens=used,
            remaining_tokens=max(0, remaining),
            threshold_tokens=checkpoint_at,
            reason="usage reached the checkpoint threshold",
        )
    return BudgetDecision(
        action="continue",
        used_tokens=used,
        remaining_tokens=max(0, remaining),
        threshold_tokens=checkpoint_at,
        reason="usage is below checkpoint threshold",
    )


def load_state(path: Path) -> NightwatchState:
    data = json.loads(path.read_text(encoding="utf-8"))
    return NightwatchState(**data)


def save_state(path: Path, state: NightwatchState) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    state.updated_at = now_iso()
    path.write_text(json.dumps(asdict(state), indent=2, sort_keys=True) + "\n", encoding="utf-8")


def resolve_for_warning(path: Path) -> Path:
    return path.expanduser().resolve()


def path_inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def state_path_warnings(cwd: Path, paths: dict[str, Path]) -> list[str]:
    workspace = resolve_for_warning(cwd)
    warnings: list[str] = []
    for label, path in paths.items():
        resolved = resolve_for_warning(path)
        if not path_inside(resolved, workspace):
            warnings.append(
                f"{label} path is outside the project workspace: {resolved} "
                f"(workspace: {workspace})"
            )
    return warnings


def emit_warnings(warnings: Sequence[str]) -> None:
    for warning in warnings:
        print(f"warning: {warning}", file=sys.stderr)


def git_status_for_paths(repo: Path, paths: Sequence[str]) -> list[str]:
    if not paths:
        return []
    try:
        result = subprocess.run(
            ["git", "-C", str(repo), "status", "--porcelain", "--", *paths],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if result.returncode != 0:
        return []
    return [line for line in result.stdout.splitlines() if line.strip()]


def runtime_artifact_hygiene_warnings(repo: Path, state_dir: Path | None = None) -> list[str]:
    workspace = resolve_for_warning(repo)
    candidates = [Path(".codex") / "nightwatch", Path(".nightwatch")]
    if state_dir is not None:
        resolved_state_dir = resolve_for_warning(state_dir)
        if path_inside(resolved_state_dir, workspace):
            candidates.append(resolved_state_dir.relative_to(workspace))

    existing: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        absolute = workspace / candidate
        if absolute.exists():
            relative = candidate.as_posix()
            if relative not in seen:
                existing.append(relative)
                seen.add(relative)

    warnings: list[str] = []
    for line in git_status_for_paths(workspace, existing):
        status = line[:2]
        path = line[3:].strip()
        if status == "??":
            warnings.append(
                f"Untracked Nightwatch runtime artifact in target repo: {path}. "
                "Keep it local and do not commit it unless the owner explicitly asks."
            )
    return warnings


def resolve_codex_binary(explicit: Path | None = None) -> str:
    if explicit:
        return str(explicit)

    found = shutil.which("codex")
    if found and "WindowsApps" not in found:
        return found

    if sys.platform == "win32":
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            bin_root = Path(local_app_data) / "OpenAI" / "Codex" / "bin"
            if bin_root.exists():
                candidates = sorted(
                    bin_root.glob("*/codex.exe"),
                    key=lambda path: path.stat().st_mtime,
                    reverse=True,
                )
                if candidates:
                    return str(candidates[0])

    return found or "codex"


def build_codex_exec_command(
    prompt: str,
    extra_args: Sequence[str] = (),
    codex_bin: Path | None = None,
) -> list[str]:
    return [
        resolve_codex_binary(codex_bin),
        "exec",
        "--json",
        *extra_args,
        prompt,
    ]


def build_codex_resume_exec_command(
    state: NightwatchState,
    extra_args: Sequence[str] = (),
    codex_bin: Path | None = None,
    prompt: str | None = None,
    allow_last: bool = False,
) -> list[str]:
    resume_prompt = prompt or state.resume_prompt or state.prompt
    command = [
        resolve_codex_binary(codex_bin),
        "exec",
        "resume",
        "--json",
        *extra_args,
    ]
    if state.thread_id:
        command.append(state.thread_id)
    elif allow_last:
        command.append("--last")
    else:
        raise ValueError("No thread_id is recorded; pass --allow-last to opt into codex exec resume --last")
    command.append(resume_prompt)
    return command


def shell_join(command: Sequence[str]) -> str:
    if sys.platform == "win32":
        return subprocess.list2cmdline(list(command))
    return shlex.join(command)


def display_value(value: str | None, redact: bool, fallback: str = "not recorded") -> str:
    if not value:
        return fallback
    return "[redacted]" if redact else value


def display_resume_command(state: NightwatchState, redact: bool) -> str:
    if redact:
        return "[redacted: resume command may contain prompts or session identifiers]"
    try:
        return shell_join(build_resume_command(state))
    except ValueError as exc:
        return f"Unavailable: {exc}"


def build_resume_command(state: NightwatchState, prompt: str | None = None, allow_last: bool = False) -> list[str]:
    resume_prompt = prompt or state.resume_prompt or state.prompt
    command = ["codex", "exec", "resume"]
    if state.thread_id:
        command.append(state.thread_id)
    elif allow_last:
        command.append("--last")
    else:
        raise ValueError("No thread_id is recorded; pass --allow-last to opt into codex exec resume --last")
    command.append(resume_prompt)
    return command


def checkpoint_key(checkpoint: dict[str, Any]) -> tuple[Any, ...]:
    return (
        checkpoint.get("action"),
        checkpoint.get("reason"),
        checkpoint.get("used_tokens"),
        checkpoint.get("thread_id"),
    )


def status_from_decision(decision: BudgetDecision) -> str:
    if decision.action == "stop":
        return "stopped"
    if decision.action == "checkpoint":
        return "checkpointed"
    return "running"


def classify_blocker(reason: str) -> str:
    text = reason.lower()
    if not text:
        return "none"
    if any(word in text for word in ("rate limit", "ratelimit", "quota", "usage limit", "429")):
        return "usage_limit"
    if "usage reached" in text or "token" in text:
        return "budget_policy"
    if "timeout" in text or "inactivity" in text:
        return "timeout"
    if "before emitting json events" in text or "unexpected argument" in text or "codex process exited" in text:
        return "codex_cli_or_launcher"
    if any(word in text for word in ("permission", "access is denied", "index.lock", "credential", "auth")):
        return "environment"
    if any(word in text for word in ("network", "fetch", "dns", "connection", "certificate")):
        return "environment"
    if "git " in text or "build failed" in text or "test failed" in text:
        return "project_or_validation"
    return "agent_or_unknown"


def summarize_failed_commands(events: Iterable[dict[str, Any]], limit: int = 5) -> list[dict[str, Any]]:
    failed: list[dict[str, Any]] = []
    for event in events:
        item = event.get("item")
        if not isinstance(item, dict):
            continue
        item_type = str(item.get("type", ""))
        status = str(item.get("status", "")).lower()
        if "command" not in item_type and "exec" not in item_type:
            continue
        if status not in {"failed", "error", "cancelled"} and not item.get("exit_code"):
            continue
        command = item.get("command") or item.get("cmd") or item.get("text") or item.get("summary")
        if isinstance(command, list):
            command = " ".join(str(part) for part in command)
        if isinstance(command, str) and command.strip():
            failed.append(
                {
                    "command": command.strip(),
                    "status": status or "unknown",
                    "exit_code": item.get("exit_code"),
                }
            )
        if len(failed) >= limit:
            break
    return failed


def summarize_file_changes(events: Iterable[dict[str, Any]], limit: int = 10) -> list[str]:
    changed: list[str] = []
    seen: set[str] = set()
    for event in events:
        item = event.get("item")
        if not isinstance(item, dict):
            continue
        candidates: list[Any] = []
        for key in ("path", "file", "filename"):
            candidates.append(item.get(key))
        for key in ("files", "paths"):
            value = item.get(key)
            if isinstance(value, list):
                candidates.extend(value)
        for candidate in candidates:
            if not isinstance(candidate, str) or not candidate.strip():
                continue
            path = candidate.strip()
            if path not in seen:
                seen.add(path)
                changed.append(path)
            if len(changed) >= limit:
                return changed
    return changed


def wrap_up_outcome(decision_action: str) -> str:
    if decision_action == "stop":
        return "Stopped safely"
    if decision_action == "checkpoint":
        return "Checkpoint ready"
    if decision_action == "continue":
        return "No stop needed"
    return "Unknown"


def wrap_up_next_action(state: NightwatchState, decision: BudgetDecision, blocker_type: str) -> str:
    if decision.action == "checkpoint":
        return f"Resume after {state.reset_after_minutes} minutes using the recorded thread id."
    if decision.action == "stop":
        if blocker_type in {"usage_limit", "budget_policy", "timeout"}:
            return "Owner should review the report before any resume; do not auto-resume unless explicitly allowed."
        if blocker_type in {"codex_cli_or_launcher", "environment"}:
            return "Fix the launcher/environment blocker first, then rerun or resume from the recorded thread id."
        return "Review the transcript and final repo state before continuing."
    return "No action required unless the objective is still incomplete."


def build_wrap_up(
    state: NightwatchState,
    events: list[dict[str, Any]],
    decision: BudgetDecision,
    stop_signal: StopSignal,
) -> dict[str, Any]:
    blocker_type = classify_blocker(decision.reason)
    return {
        "outcome": wrap_up_outcome(decision.action),
        "decision_action": decision.action,
        "blocker_type": blocker_type,
        "reason": decision.reason,
        "safe_next_action": wrap_up_next_action(state, decision, blocker_type),
        "failed_commands": summarize_failed_commands(events),
        "changed_files": summarize_file_changes(events),
        "evidence": {
            "run_log": state.run_log,
            "transcript_log": state.transcript_log,
            "thread_id": state.thread_id,
            "stop_signal": asdict(stop_signal),
        },
    }

def update_state_from_events(state: NightwatchState, events: list[dict[str, Any]], jsonl_path: Path | None = None) -> None:
    summary = summarize_usage(events)
    stop_signal = detect_stop_signal(events)
    decision = decide_budget(
        summary=summary,
        token_budget=state.token_budget,
        reserve_tokens=state.reserve_tokens,
        checkpoint_ratio=state.checkpoint_ratio,
        stop_signal=stop_signal,
    )

    thread_id = find_thread_id(events)
    if thread_id:
        state.thread_id = thread_id
    if jsonl_path:
        state.run_log = str(jsonl_path)

    state.summary = asdict(summary) | {
        "billable_like_tokens": summary.billable_like_tokens,
        "uncached_input_tokens": summary.uncached_input_tokens,
        "fresh_pressure_tokens": summary.fresh_pressure_tokens,
    }
    state.stop_signal = asdict(stop_signal)
    state.decision = asdict(decision)
    state.status = status_from_decision(decision)
    state.wrap_up = build_wrap_up(state, events, decision, stop_signal)

    if decision.action in {"checkpoint", "stop"}:
        checkpoint = {
            "created_at": now_iso(),
            "action": decision.action,
            "reason": decision.reason,
            "used_tokens": decision.used_tokens,
            "thread_id": state.thread_id,
        }
        existing_keys = {checkpoint_key(item) for item in state.checkpoints}
        if checkpoint_key(checkpoint) not in existing_keys:
            state.checkpoints.append(checkpoint)


def render_report(
    state: NightwatchState,
    redact_prompts: bool = False,
    redact_paths: bool = False,
    redact_thread_ids: bool = False,
) -> str:
    summary = state.summary or {}
    decision = state.decision or {}
    run_contract = state.run_contract or {}
    wrap_up = state.wrap_up or {}
    failed_commands = wrap_up.get("failed_commands") or []
    changed_files = wrap_up.get("changed_files") or []
    decision_action = decision.get("action", "unknown")
    if decision_action == "stop":
        next_action = "terminal stop; no automatic resume unless supervise is run with --resume-after-stop"
    elif decision_action == "checkpoint":
        next_action = f"eligible to resume after {state.reset_after_minutes} minutes"
    else:
        next_action = "no resume needed"
    redact_resume = redact_prompts or redact_thread_ids
    resume_command = display_resume_command(state, redact_resume)
    lines = [
        "# Codex Nightwatch Report",
        "",
        f"- Objective: {state.objective}",
        f"- Status: {state.status}",
        f"- CWD: {display_value(state.cwd, redact_paths)}",
        f"- Thread/session target: {display_value(state.thread_id, redact_thread_ids, 'unknown')}",
        f"- Event log: {display_value(state.run_log, redact_paths)}",
        f"- Transcript log: {display_value(state.transcript_log, redact_paths)}",
        f"- Turns: {summary.get('turns', 0)}",
        f"- Advisory used tokens: {summary.get('billable_like_tokens', 0)} / {state.token_budget}",
        "- Budget policy basis: raw advisory tokens (input + output + reasoning, including cached input)",
        f"- Cached input tokens: {summary.get('cached_input_tokens', 0)}",
        f"- Uncached input tokens: {summary.get('uncached_input_tokens', 0)}",
        f"- Fresh pressure estimate: {summary.get('fresh_pressure_tokens', 0)}",
        f"- Decision: {decision_action} ({decision.get('reason', 'no reason recorded')})",
        f"- Next action: {next_action}",
        f"- Autonomy mode: {run_contract.get('autonomy_mode', 'unspecified')}",
        f"- Approval mode: {run_contract.get('approval_mode', 'unspecified')}",
        f"- Commit policy: {run_contract.get('commit_policy', 'unspecified')}",
        f"- Push policy: {run_contract.get('push_policy', 'unspecified')}",
        f"- Scheduler mode: {run_contract.get('scheduler_mode', 'unspecified')}",
        f"- Resume-after-stop allowed: {run_contract.get('resume_after_stop_allowed', False)}",
        f"- Resume after: {state.reset_after_minutes} minutes",
        f"- Planned resume at: {state.planned_resume_at or 'not scheduled'}",
        "",
        "## Wrap-Up",
        "",
        f"- Outcome: {wrap_up.get('outcome', 'Unknown')}",
        f"- Blocker type: {wrap_up.get('blocker_type', 'none')}",
        f"- Reason: {wrap_up.get('reason', decision.get('reason', 'no reason recorded'))}",
        f"- Safe next action: {wrap_up.get('safe_next_action', next_action)}",
        f"- Changed files observed: {len(changed_files)}",
        f"- Failed commands observed: {len(failed_commands)}",
        "",
        "## Resume Command",
        "",
        "```bash",
        resume_command,
        "```",
        "",
    ]
    if changed_files:
        lines.extend(["## Changed Files", ""])
        for path in changed_files:
            lines.append(f"- {display_value(path, redact_paths)}")
        lines.append("")
    if failed_commands:
        lines.extend(["## Failed Commands", ""])
        for item in failed_commands:
            exit_code = item.get("exit_code")
            exit_text = f" (exit {exit_code})" if exit_code is not None else ""
            lines.append(f"- {item.get('command', 'unknown command')}{exit_text}: {item.get('status', 'unknown')}")
        lines.append("")
    lines.extend(["## Checkpoints", ""])
    if state.checkpoints:
        for checkpoint in state.checkpoints:
            lines.append(
                f"- {checkpoint['created_at']}: {checkpoint['action']} after "
                f"{checkpoint['used_tokens']} tokens ({checkpoint['reason']})"
            )
    else:
        lines.append("- No checkpoints recorded.")
    lines.append("")
    return "\n".join(lines)


def analyze(args: argparse.Namespace) -> int:
    events = load_jsonl(args.jsonl)
    summary = summarize_usage(events)
    stop_signal = detect_stop_signal(events)
    decision = decide_budget(
        summary=summary,
        token_budget=args.token_budget,
        reserve_tokens=args.reserve_tokens,
        checkpoint_ratio=args.checkpoint_ratio,
        stop_signal=stop_signal,
    )
    payload = {
        "summary": asdict(summary),
        "billable_like_tokens": summary.billable_like_tokens,
        "uncached_input_tokens": summary.uncached_input_tokens,
        "fresh_pressure_tokens": summary.fresh_pressure_tokens,
        "budget_policy_basis": "raw advisory tokens: input + output + reasoning, including cached input",
        "thread_id": find_thread_id(events),
        "stop_signal": asdict(stop_signal),
        "decision": asdict(decision),
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def init(args: argparse.Namespace) -> int:
    emit_warnings(state_path_warnings(args.cwd, {"state": args.state}))
    state = NightwatchState(
        version=1,
        objective=args.objective,
        cwd=str(args.cwd.resolve()),
        prompt=args.prompt,
        token_budget=args.token_budget,
        reserve_tokens=args.reserve_tokens,
        checkpoint_ratio=args.checkpoint_ratio,
        reset_after_minutes=args.reset_after_minutes,
        created_at=now_iso(),
        updated_at=now_iso(),
        resume_prompt=args.resume_prompt or args.prompt,
        planned_resume_at=planned_resume_at(args.reset_after_minutes),
        run_contract={
            "autonomy_mode": args.autonomy_mode,
            "approval_mode": args.approval_mode,
            "commit_policy": args.commit_policy,
            "push_policy": args.push_policy,
            "scheduler_mode": args.scheduler_mode,
            "resume_after_stop_allowed": args.resume_after_stop_allowed,
        },
    )
    save_state(args.state, state)
    print(str(args.state))
    return 0


def record(args: argparse.Namespace) -> int:
    state = load_state(args.state)
    events = load_jsonl(args.jsonl)
    update_state_from_events(state, events, args.jsonl)
    save_state(args.state, state)
    print(json.dumps({"status": state.status, "decision": state.decision}, indent=2, sort_keys=True))
    return 0


def resume_command(args: argparse.Namespace) -> int:
    state = load_state(args.state)
    print(shell_join(build_resume_command(state, args.prompt, args.allow_last)))
    return 0


def timestamp_label() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def cycle_log_path(state_path: Path, log_dir: Path, cycle: int, phase: str, suffix: str) -> Path:
    return log_dir / f"{state_path.stem}.cycle-{cycle:02d}.{phase}.{timestamp_label()}{suffix}"


def resume_delay_seconds(state: NightwatchState, now: datetime | None = None) -> int:
    if not state.planned_resume_at:
        return max(0, state.reset_after_minutes * 60)
    now = now or datetime.now(timezone.utc)
    return max(0, int((parse_iso_datetime(state.planned_resume_at) - now).total_seconds()))


def should_resume(state: NightwatchState, force_resume: bool = False) -> bool:
    return force_resume or bool(state.thread_id and state.status in {"stopped", "checkpointed"})


def run_state_command(
    command: list[str],
    state: NightwatchState,
    state_path: Path,
    jsonl_path: Path,
    transcript_path: Path,
    timeout_seconds: int,
    inactivity_timeout_seconds: int,
    execute: bool,
) -> int:
    emit_warnings(
        state_path_warnings(
            Path(state.cwd),
            {
                "state": state_path,
                "event log": jsonl_path,
                "transcript log": transcript_path,
            },
        )
    )
    emit_warnings(runtime_artifact_hygiene_warnings(Path(state.cwd), state_path.parent))
    state.last_command = command
    state.run_log = str(jsonl_path)
    state.transcript_log = str(transcript_path)
    save_state(state_path, state)

    if not execute:
        print(shell_join(command))
        return 0

    jsonl_path.parent.mkdir(parents=True, exist_ok=True)
    transcript_path.parent.mkdir(parents=True, exist_ok=True)
    return execute_monitored_run(
        command,
        state,
        state_path,
        jsonl_path,
        transcript_path,
        timeout_seconds,
        inactivity_timeout_seconds,
    )


def resume_run(args: argparse.Namespace) -> int:
    state = load_state(args.state)
    validate_resume_args(args.resume_arg)
    command = build_codex_resume_exec_command(
        state,
        args.resume_arg,
        args.codex_bin,
        args.prompt,
        args.allow_last,
    )
    jsonl_path = args.jsonl or args.state.with_suffix(".resume.jsonl")
    transcript_path = args.transcript or args.state.with_suffix(".resume.transcript.log")
    if getattr(args, "dry_run", False):
        args.execute = False
    return run_state_command(
        command,
        state,
        args.state,
        jsonl_path,
        transcript_path,
        args.timeout_seconds,
        args.inactivity_timeout_seconds,
        args.execute,
    )


def supervise(args: argparse.Namespace) -> int:
    validate_codex_args(args.codex_arg)
    validate_resume_args(args.resume_arg)
    log_dir = args.log_dir or args.state.parent

    last_return_code = 0
    for cycle in range(1, args.max_cycles + 1):
        state = load_state(args.state)
        phase = "resume" if should_resume(state, args.resume_first and cycle == 1) else "initial"
        if phase == "resume":
            command = build_codex_resume_exec_command(
                state,
                args.resume_arg,
                args.codex_bin,
                args.resume_prompt,
                args.allow_last,
            )
        else:
            command = build_codex_exec_command(state.prompt, args.codex_arg, args.codex_bin)

        jsonl_path = cycle_log_path(args.state, log_dir, cycle, phase, ".jsonl")
        transcript_path = cycle_log_path(args.state, log_dir, cycle, phase, ".transcript.log")
        last_return_code = run_state_command(
            command,
            state,
            args.state,
            jsonl_path,
            transcript_path,
            args.timeout_seconds,
            args.inactivity_timeout_seconds,
            args.execute,
        )

        if not args.execute:
            return last_return_code

        state = load_state(args.state)
        decision_action = state.decision.get("action")
        decision_reason = str(state.decision.get("reason", ""))
        if last_return_code != 0 and "before emitting json events" in decision_reason.lower():
            return last_return_code
        if last_return_code == 0 and decision_action not in {"checkpoint", "stop"}:
            return 0
        if decision_action == "stop" and not args.resume_after_stop:
            return last_return_code
        if not state.thread_id:
            return last_return_code or 1
        if cycle == args.max_cycles:
            return last_return_code

        state.planned_resume_at = planned_resume_at(state.reset_after_minutes)
        save_state(args.state, state)
        sleep_seconds = resume_delay_seconds(state)
        if args.max_sleep_seconds is not None:
            sleep_seconds = min(sleep_seconds, args.max_sleep_seconds)
        if sleep_seconds > 0:
            time.sleep(sleep_seconds)

    return last_return_code


def report(args: argparse.Namespace) -> int:
    state = load_state(args.state)
    rendered = render_report(
        state,
        redact_prompts=args.redact_prompts,
        redact_paths=args.redact_paths,
        redact_thread_ids=args.redact_thread_ids,
    )
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
        print(str(args.output))
    else:
        print(rendered)
    return 0


BLOCKED_CODEX_ARGS = (
    "danger-full-access",
    "dangerously",
    "bypass",
    "approval_policy=never",
    "approval-policy=never",
)


def validate_codex_args(args: Sequence[str]) -> None:
    joined = " ".join(args).lower()
    for blocked in BLOCKED_CODEX_ARGS:
        if blocked in joined:
            raise ValueError(f"Refusing unsafe unattended Codex argument: {blocked}")


UNSUPPORTED_RESUME_ARGS = {
    "--sandbox",
}


def validate_resume_args(args: Sequence[str]) -> None:
    validate_codex_args(args)
    for arg in args:
        normalized = arg.lower()
        if normalized in UNSUPPORTED_RESUME_ARGS or any(
            normalized.startswith(f"{blocked}=") for blocked in UNSUPPORTED_RESUME_ARGS
        ):
            raise ValueError(
                f"Refusing unsupported Codex resume argument: {arg}. "
                "Use a resume-compatible Codex option such as -c/--config instead."
            )


def _reader_thread(
    stream: Any,
    output_path: Path,
    activity_ref: list[float],
    event_queue: queue.Queue[dict[str, Any]] | None = None,
) -> threading.Thread:
    def worker() -> None:
        with output_path.open("w", encoding="utf-8") as output:
            for line in stream:
                activity_ref[0] = time.monotonic()
                output.write(line)
                output.flush()
                if event_queue is None:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(event, dict):
                    event_queue.put(event)

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    return thread


def drain_event_queue(event_queue: queue.Queue[dict[str, Any]]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    while True:
        try:
            events.append(event_queue.get_nowait())
        except queue.Empty:
            return events


def execute_monitored_run(
    command: list[str],
    state: NightwatchState,
    state_path: Path,
    jsonl_path: Path,
    transcript_path: Path,
    timeout_seconds: int,
    inactivity_timeout_seconds: int,
) -> int:
    event_queue: queue.Queue[dict[str, Any]] = queue.Queue()
    events: list[dict[str, Any]] = []
    timed_out = False
    inactive_timed_out = False

    process = subprocess.Popen(
        command,
        cwd=state.cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert process.stdout is not None
    assert process.stderr is not None

    started_at = time.monotonic()
    activity_ref = [started_at]
    stdout_thread = _reader_thread(process.stdout, jsonl_path, activity_ref, event_queue)
    stderr_thread = _reader_thread(process.stderr, transcript_path, activity_ref)

    while True:
        for event in drain_event_queue(event_queue):
            events.append(event)
            update_state_from_events(state, events, jsonl_path)
            state.transcript_log = str(transcript_path)
            save_state(state_path, state)
            if state.decision.get("action") == "stop" and process.poll() is None:
                process.terminate()

        if process.poll() is not None:
            break

        if timeout_seconds > 0 and time.monotonic() - started_at > timeout_seconds:
            timed_out = True
            process.terminate()
            break

        if inactivity_timeout_seconds > 0 and time.monotonic() - activity_ref[0] > inactivity_timeout_seconds:
            inactive_timed_out = True
            process.terminate()
            break

        time.sleep(0.25)

    try:
        return_code = process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        return_code = 124

    stdout_thread.join(timeout=2)
    stderr_thread.join(timeout=2)
    process.stdout.close()
    process.stderr.close()

    events.extend(drain_event_queue(event_queue))

    if timed_out:
        events.append({"type": "error", "message": "Nightwatch timeout reached"})
        return_code = 124
    if inactive_timed_out:
        events.append({"type": "error", "message": "Nightwatch inactivity timeout reached"})
        return_code = 124
    if return_code != 0 and not events:
        events.append(
            {
                "type": "error",
                "message": (
                    f"Codex process exited with code {return_code} before emitting JSON events; "
                    f"see transcript log: {transcript_path}"
                ),
            }
        )

    update_state_from_events(state, events, jsonl_path)
    state.transcript_log = str(transcript_path)
    save_state(state_path, state)
    return return_code


def run(args: argparse.Namespace) -> int:
    state = load_state(args.state)
    jsonl_path = args.jsonl or args.state.with_suffix(".jsonl")
    transcript_path = args.transcript or args.state.with_suffix(".transcript.log")
    emit_warnings(
        state_path_warnings(
            Path(state.cwd),
            {
                "state": args.state,
                "event log": jsonl_path,
                "transcript log": transcript_path,
            },
        )
    )
    emit_warnings(runtime_artifact_hygiene_warnings(Path(state.cwd), args.state.parent))
    validate_codex_args(args.codex_arg)
    command = build_codex_exec_command(state.prompt, args.codex_arg, args.codex_bin)
    state.last_command = command
    state.run_log = str(jsonl_path)
    state.transcript_log = str(transcript_path)
    save_state(args.state, state)

    if getattr(args, "dry_run", False):
        args.execute = False

    if not args.execute:
        print(shell_join(command))
        return 0

    jsonl_path.parent.mkdir(parents=True, exist_ok=True)
    transcript_path.parent.mkdir(parents=True, exist_ok=True)
    return execute_monitored_run(
        command,
        state,
        args.state,
        jsonl_path,
        transcript_path,
        args.timeout_seconds,
        args.inactivity_timeout_seconds,
    )


def doctor(args: argparse.Namespace) -> int:
    state_parent = resolve_for_warning(args.state_dir)
    cwd = resolve_for_warning(args.cwd)
    state_check_dir = state_parent if state_parent.exists() else state_parent.parent
    codex_binary = resolve_codex_binary(args.codex_bin)
    path_warnings = state_path_warnings(cwd, {"state_dir": state_parent})
    hygiene_warnings = runtime_artifact_hygiene_warnings(cwd, state_parent)
    checks = {
        "codex_binary": codex_binary,
        "codex_available": shutil.which(codex_binary) is not None or Path(codex_binary).exists(),
        "python_version": sys.version.split()[0],
        "cwd_writable": cwd.exists() and cwd.is_dir(),
        "state_dir_writable": state_check_dir.exists() and os.access(state_check_dir, os.W_OK),
        "state_dir_inside_cwd": path_inside(state_parent, cwd),
        "path_warnings": path_warnings,
        "runtime_artifact_hygiene_ok": not hygiene_warnings,
        "runtime_artifact_warnings": hygiene_warnings,
    }
    print(json.dumps(checks, indent=2, sort_keys=True))
    required = ("codex_available", "cwd_writable", "state_dir_writable")
    return 0 if all(checks[key] is True for key in required) else 1


def add_policy_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--token-budget", type=int, required=True, help="Total local token budget")
    parser.add_argument(
        "--reserve-tokens",
        type=int,
        default=15_000,
        help="Tokens to reserve before stopping",
    )
    parser.add_argument(
        "--checkpoint-ratio",
        type=float,
        default=0.75,
        help="Budget fraction that should trigger checkpointing",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Codex Nightwatch helper")
    subparsers = parser.add_subparsers(dest="command", required=True)

    analyze_parser = subparsers.add_parser("analyze", help="Analyze codex exec --json JSONL output")
    analyze_parser.add_argument("--jsonl", type=Path, required=True, help="Path to a Codex JSONL event stream")
    add_policy_arguments(analyze_parser)
    analyze_parser.set_defaults(func=analyze)

    init_parser = subparsers.add_parser("init", help="Create a Nightwatch state file")
    init_parser.add_argument("--state", type=Path, required=True, help="State file to create")
    init_parser.add_argument("--objective", required=True, help="Human-readable run objective")
    init_parser.add_argument("--prompt", required=True, help="Prompt to pass to codex exec")
    init_parser.add_argument("--resume-prompt", help="Prompt to use when resuming")
    init_parser.add_argument("--cwd", type=Path, default=Path.cwd(), help="Workspace for Codex execution")
    init_parser.add_argument("--reset-after-minutes", type=int, default=360, help="Expected wait before resuming")
    init_parser.add_argument(
        "--autonomy-mode",
        choices=("unspecified", "fully-autonomous", "conservative", "audit-only"),
        default="unspecified",
        help="Owner-approved autonomy level for this run",
    )
    init_parser.add_argument(
        "--approval-mode",
        choices=("unspecified", "ask-if-needed", "stop-instead-of-asking"),
        default="unspecified",
        help="Whether Nightwatch may request approvals while unattended",
    )
    init_parser.add_argument(
        "--commit-policy",
        choices=("unspecified", "allowed", "commit-ready-only", "forbidden"),
        default="unspecified",
        help="Owner-approved commit behavior for this run",
    )
    init_parser.add_argument(
        "--push-policy",
        choices=("unspecified", "allowed", "forbidden"),
        default="unspecified",
        help="Owner-approved push behavior for this run",
    )
    init_parser.add_argument(
        "--scheduler-mode",
        choices=("unspecified", "manual", "codex-automation", "windows-task-scheduler", "dual"),
        default="unspecified",
        help="Scheduler mechanism expected to launch this run",
    )
    init_parser.add_argument(
        "--resume-after-stop-allowed",
        action="store_true",
        help="Record that the owner explicitly allowed resume-after-stop behavior",
    )
    add_policy_arguments(init_parser)
    init_parser.set_defaults(func=init)

    record_parser = subparsers.add_parser("record", help="Update state from a JSONL event stream")
    record_parser.add_argument("--state", type=Path, required=True, help="Nightwatch state file")
    record_parser.add_argument("--jsonl", type=Path, required=True, help="Codex JSONL event stream")
    record_parser.set_defaults(func=record)

    run_parser = subparsers.add_parser("run", help="Build or execute a codex exec command for a state file")
    run_parser.add_argument("--state", type=Path, required=True, help="Nightwatch state file")
    run_parser.add_argument("--jsonl", type=Path, help="Output JSONL path")
    run_parser.add_argument("--transcript", type=Path, help="Output transcript/stderr log path")
    run_parser.add_argument("--execute", action="store_true", help="Actually run Codex; default prints the command")
    run_parser.add_argument("--dry-run", action="store_true", help="Explicitly print the command without executing")
    run_parser.add_argument("--codex-bin", type=Path, help="Explicit Codex binary path")
    run_parser.add_argument("--timeout-seconds", type=int, default=0, help="Maximum runtime before terminating Codex")
    run_parser.add_argument(
        "--inactivity-timeout-seconds",
        type=int,
        default=0,
        help="Maximum time without stdout/stderr activity before terminating Codex",
    )
    run_parser.add_argument(
        "--codex-arg",
        action="append",
        default=[],
        help="Extra argument passed before the prompt, repeat as needed",
    )
    run_parser.set_defaults(func=run)

    resume_parser = subparsers.add_parser("resume-command", help="Print a safe codex exec resume command")
    resume_parser.add_argument("--state", type=Path, required=True, help="Nightwatch state file")
    resume_parser.add_argument("--prompt", help="Override resume prompt")
    resume_parser.add_argument("--allow-last", action="store_true", help="Allow codex exec resume --last if no thread id is known")
    resume_parser.set_defaults(func=resume_command)

    resume_run_parser = subparsers.add_parser("resume-run", help="Build or execute a monitored codex exec resume command")
    resume_run_parser.add_argument("--state", type=Path, required=True, help="Nightwatch state file")
    resume_run_parser.add_argument("--jsonl", type=Path, help="Output JSONL path")
    resume_run_parser.add_argument("--transcript", type=Path, help="Output transcript/stderr log path")
    resume_run_parser.add_argument("--execute", action="store_true", help="Actually resume Codex; default prints the command")
    resume_run_parser.add_argument("--dry-run", action="store_true", help="Explicitly print the resume command without executing")
    resume_run_parser.add_argument("--codex-bin", type=Path, help="Explicit Codex binary path")
    resume_run_parser.add_argument("--prompt", help="Override resume prompt")
    resume_run_parser.add_argument("--allow-last", action="store_true", help="Allow codex exec resume --last if no thread id is known")
    resume_run_parser.add_argument("--timeout-seconds", type=int, default=0, help="Maximum runtime before terminating Codex")
    resume_run_parser.add_argument(
        "--inactivity-timeout-seconds",
        type=int,
        default=0,
        help="Maximum time without stdout/stderr activity before terminating Codex",
    )
    resume_run_parser.add_argument(
        "--resume-arg",
        action="append",
        default=[],
        help="Extra argument passed to codex exec resume before the session id/prompt, repeat as needed",
    )
    resume_run_parser.set_defaults(func=resume_run)

    supervise_parser = subparsers.add_parser("supervise", help="Run and safely resume a Nightwatch state for multiple cycles")
    supervise_parser.add_argument("--state", type=Path, required=True, help="Nightwatch state file")
    supervise_parser.add_argument("--log-dir", type=Path, help="Directory for cycle JSONL and transcript logs")
    supervise_parser.add_argument("--execute", action="store_true", help="Actually run Codex; default prints the first planned command")
    supervise_parser.add_argument("--codex-bin", type=Path, help="Explicit Codex binary path")
    supervise_parser.add_argument("--max-cycles", type=int, default=1, help="Maximum initial/resume cycles")
    supervise_parser.add_argument("--timeout-seconds", type=int, default=0, help="Maximum runtime for each cycle")
    supervise_parser.add_argument(
        "--inactivity-timeout-seconds",
        type=int,
        default=0,
        help="Maximum time without stdout/stderr activity before terminating a cycle",
    )
    supervise_parser.add_argument(
        "--max-sleep-seconds",
        type=int,
        help="Cap sleep between cycles; useful for tests and short trials",
    )
    supervise_parser.add_argument("--resume-first", action="store_true", help="Start with resume instead of an initial run")
    supervise_parser.add_argument("--resume-after-stop", action="store_true", help="Resume after stop decisions instead of treating them as terminal")
    supervise_parser.add_argument("--resume-prompt", help="Override prompt for resume cycles")
    supervise_parser.add_argument("--allow-last", action="store_true", help="Allow resume --last if no thread id is known")
    supervise_parser.add_argument(
        "--codex-arg",
        action="append",
        default=[],
        help="Extra argument passed to initial codex exec before the prompt, repeat as needed",
    )
    supervise_parser.add_argument(
        "--resume-arg",
        action="append",
        default=[],
        help="Extra argument passed to codex exec resume before the session id/prompt, repeat as needed",
    )
    supervise_parser.set_defaults(func=supervise)

    report_parser = subparsers.add_parser("report", help="Render a markdown run report")
    report_parser.add_argument("--state", type=Path, required=True, help="Nightwatch state file")
    report_parser.add_argument("--output", type=Path, help="Write report to this path")
    report_parser.add_argument("--redact-prompts", action="store_true", help="Redact resume commands that may contain prompts")
    report_parser.add_argument("--redact-paths", action="store_true", help="Redact local paths in the report")
    report_parser.add_argument("--redact-thread-ids", action="store_true", help="Redact thread/session identifiers")
    report_parser.set_defaults(func=report)

    doctor_parser = subparsers.add_parser("doctor", help="Check local prerequisites")
    doctor_parser.add_argument("--cwd", type=Path, default=Path.cwd(), help="Workspace to check")
    doctor_parser.add_argument("--state-dir", type=Path, default=Path(".nightwatch"), help="State directory to check")
    doctor_parser.add_argument("--codex-bin", type=Path, help="Explicit Codex binary path")
    doctor_parser.set_defaults(func=doctor)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
