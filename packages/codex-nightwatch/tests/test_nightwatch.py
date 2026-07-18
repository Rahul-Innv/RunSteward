import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from argparse import Namespace
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"
sys.path.insert(0, str(ROOT / "scripts"))

import nightwatch


def sample_events():
    return [
        {"type": "thread.started", "thread_id": "abc"},
        {
            "type": "turn.completed",
            "usage": {
                "input_tokens": 100,
                "cached_input_tokens": 80,
                "output_tokens": 20,
                "reasoning_output_tokens": 5,
            },
        },
        {
            "type": "turn.completed",
            "usage": {
                "input_tokens": 50,
                "output_tokens": 10,
                "reasoning_output_tokens": 0,
            },
        },
    ]


class NightwatchTests(unittest.TestCase):
    def test_summarize_usage_from_turn_completed_events(self):
        summary = nightwatch.summarize_usage(sample_events())

        self.assertEqual(summary.turns, 2)
        self.assertEqual(summary.input_tokens, 150)
        self.assertEqual(summary.cached_input_tokens, 80)
        self.assertEqual(summary.output_tokens, 30)
        self.assertEqual(summary.reasoning_output_tokens, 5)
        self.assertEqual(summary.billable_like_tokens, 185)
        self.assertEqual(summary.uncached_input_tokens, 70)
        self.assertEqual(summary.fresh_pressure_tokens, 105)

    def test_analyze_outputs_fresh_pressure_and_policy_basis(self):
        with tempfile.TemporaryDirectory() as tmp:
            jsonl_path = Path(tmp) / "events.jsonl"
            jsonl_path.write_text(
                "\n".join(json.dumps(event) for event in sample_events()) + "\n",
                encoding="utf-8",
            )
            output = io.StringIO()

            with contextlib.redirect_stdout(output):
                code = nightwatch.analyze(
                    Namespace(
                        jsonl=jsonl_path,
                        token_budget=1000,
                        reserve_tokens=100,
                        checkpoint_ratio=0.75,
                    )
                )

            payload = json.loads(output.getvalue())
            self.assertEqual(code, 0)
            self.assertEqual(payload["billable_like_tokens"], 185)
            self.assertEqual(payload["uncached_input_tokens"], 70)
            self.assertEqual(payload["fresh_pressure_tokens"], 105)
            self.assertIn("raw advisory tokens", payload["budget_policy_basis"])

    def test_budget_decision_checkpoints_before_stop(self):
        summary = nightwatch.UsageSummary(turns=1, input_tokens=760, output_tokens=0)

        decision = nightwatch.decide_budget(
            summary=summary,
            token_budget=1000,
            reserve_tokens=100,
            checkpoint_ratio=0.75,
        )

        self.assertEqual(decision.action, "checkpoint")

    def test_budget_decision_stops_at_reserve(self):
        summary = nightwatch.UsageSummary(turns=1, input_tokens=910, output_tokens=0)

        decision = nightwatch.decide_budget(
            summary=summary,
            token_budget=1000,
            reserve_tokens=100,
            checkpoint_ratio=0.75,
        )

        self.assertEqual(decision.action, "stop")

    def test_budget_decision_stops_on_rate_limit_signal(self):
        summary = nightwatch.UsageSummary(turns=1, input_tokens=10, output_tokens=0)
        signal = nightwatch.StopSignal(
            matched=True,
            reason="Codex event indicates a usage/rate limit: rate limit",
            event_type="error",
        )

        decision = nightwatch.decide_budget(
            summary=summary,
            token_budget=1000,
            reserve_tokens=100,
            checkpoint_ratio=0.75,
            stop_signal=signal,
        )

        self.assertEqual(decision.action, "stop")
        self.assertIn("rate limit", decision.reason)

    def test_load_jsonl_rejects_invalid_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "events.jsonl"
            path.write_text(json.dumps({"type": "turn.completed"}) + "\nnot json\n", encoding="utf-8")

            with self.assertRaises(ValueError):
                nightwatch.load_jsonl(path)

    def test_state_update_from_events_records_checkpoint(self):
        state = nightwatch.NightwatchState(
            version=1,
            objective="overnight build",
            cwd=str(ROOT),
            prompt="build the MVP",
            token_budget=200,
            reserve_tokens=10,
            checkpoint_ratio=0.75,
            reset_after_minutes=360,
            created_at=nightwatch.now_iso(),
            updated_at=nightwatch.now_iso(),
        )

        nightwatch.update_state_from_events(state, sample_events(), Path("run.jsonl"))

        self.assertEqual(state.thread_id, "abc")
        self.assertEqual(state.status, "checkpointed")
        self.assertEqual(state.decision["action"], "checkpoint")
        self.assertEqual(state.summary["billable_like_tokens"], 185)
        self.assertEqual(len(state.checkpoints), 1)

        nightwatch.update_state_from_events(state, sample_events(), Path("run.jsonl"))

        self.assertEqual(len(state.checkpoints), 1)

    def test_redacted_real_codex_fixture_is_parseable(self):
        events = nightwatch.load_jsonl(FIXTURES / "real_codex_minimal.redacted.jsonl")

        summary = nightwatch.summarize_usage(events)

        self.assertEqual(nightwatch.find_thread_id(events), "thread_real_redacted_001")
        self.assertEqual(summary.turns, 1)
        self.assertEqual(summary.input_tokens, 12457)
        self.assertEqual(summary.cached_input_tokens, 10112)
        self.assertEqual(summary.output_tokens, 10)
        self.assertEqual(summary.billable_like_tokens, 12467)

    def test_rate_limit_fixture_stops_even_below_budget(self):
        events = nightwatch.load_jsonl(FIXTURES / "rate_limit_error.jsonl")
        signal = nightwatch.detect_stop_signal(events)
        decision = nightwatch.decide_budget(
            summary=nightwatch.summarize_usage(events),
            token_budget=100000,
            reserve_tokens=1000,
            checkpoint_ratio=0.75,
            stop_signal=signal,
        )

        self.assertTrue(signal.matched)
        self.assertEqual(decision.action, "stop")
        self.assertIn("rate limit", decision.reason)

    def test_missing_usage_fixture_does_not_invent_tokens(self):
        events = nightwatch.load_jsonl(FIXTURES / "missing_usage.jsonl")

        summary = nightwatch.summarize_usage(events)

        self.assertEqual(summary.turns, 0)
        self.assertEqual(summary.billable_like_tokens, 0)

    def test_resume_command_uses_thread_id_when_present(self):
        state = nightwatch.NightwatchState(
            version=1,
            objective="overnight build",
            cwd=str(ROOT),
            prompt="build the MVP",
            token_budget=1000,
            reserve_tokens=100,
            checkpoint_ratio=0.75,
            reset_after_minutes=360,
            created_at=nightwatch.now_iso(),
            updated_at=nightwatch.now_iso(),
            thread_id="abc",
            resume_prompt="continue from checkpoint",
        )

        self.assertEqual(
            nightwatch.build_resume_command(state),
            ["codex", "exec", "resume", "abc", "continue from checkpoint"],
        )

    def test_monitored_resume_command_uses_json_and_explicit_binary(self):
        state = nightwatch.NightwatchState(
            version=1,
            objective="overnight build",
            cwd=str(ROOT),
            prompt="build the MVP",
            token_budget=1000,
            reserve_tokens=100,
            checkpoint_ratio=0.75,
            reset_after_minutes=360,
            created_at=nightwatch.now_iso(),
            updated_at=nightwatch.now_iso(),
            thread_id="abc",
            resume_prompt="continue from checkpoint",
        )

        command = nightwatch.build_codex_resume_exec_command(
            state,
            ["--model", "gpt-5.4"],
            Path("C:/Tools/Codex/codex.exe"),
        )

        self.assertEqual(
            command,
            [
                str(Path("C:/Tools/Codex/codex.exe")),
                "exec",
                "resume",
                "--json",
                "--model",
                "gpt-5.4",
                "abc",
                "continue from checkpoint",
            ],
        )

    def test_render_report_contains_resume_command(self):
        state = nightwatch.NightwatchState(
            version=1,
            objective="overnight build",
            cwd=str(ROOT),
            prompt="build the MVP",
            token_budget=1000,
            reserve_tokens=100,
            checkpoint_ratio=0.75,
            reset_after_minutes=360,
            created_at=nightwatch.now_iso(),
            updated_at=nightwatch.now_iso(),
            thread_id="abc",
            summary={"turns": 1, "billable_like_tokens": 10},
            decision={"action": "continue", "reason": "ok"},
        )

        report = nightwatch.render_report(state)

        self.assertIn("Codex Nightwatch Report", report)
        self.assertIn("codex exec resume abc", report)
        self.assertIn("Fresh pressure estimate", report)
        self.assertIn("Budget policy basis", report)

    def test_render_report_marks_stop_as_terminal(self):
        state = nightwatch.NightwatchState(
            version=1,
            objective="overnight build",
            cwd=str(ROOT),
            prompt="build the MVP",
            token_budget=1000,
            reserve_tokens=100,
            checkpoint_ratio=0.75,
            reset_after_minutes=360,
            created_at=nightwatch.now_iso(),
            updated_at=nightwatch.now_iso(),
            thread_id="abc",
            status="stopped",
            summary={"turns": 1, "billable_like_tokens": 1100},
            decision={"action": "stop", "reason": "usage reached the stop threshold"},
        )

        report = nightwatch.render_report(state)

        self.assertIn("terminal stop", report)
        self.assertIn("--resume-after-stop", report)

    def test_resume_command_fails_closed_without_thread_id(self):
        state = nightwatch.NightwatchState(
            version=1,
            objective="overnight build",
            cwd=str(ROOT),
            prompt="build the MVP",
            token_budget=1000,
            reserve_tokens=100,
            checkpoint_ratio=0.75,
            reset_after_minutes=360,
            created_at=nightwatch.now_iso(),
            updated_at=nightwatch.now_iso(),
        )

        with self.assertRaises(ValueError):
            nightwatch.build_resume_command(state)

        self.assertEqual(
            nightwatch.build_resume_command(state, allow_last=True),
            ["codex", "exec", "resume", "--last", "build the MVP"],
        )

    def test_resume_delay_seconds_uses_planned_resume_at(self):
        now = datetime(2026, 7, 6, 12, 0, tzinfo=timezone.utc)
        state = nightwatch.NightwatchState(
            version=1,
            objective="overnight build",
            cwd=str(ROOT),
            prompt="build the MVP",
            token_budget=1000,
            reserve_tokens=100,
            checkpoint_ratio=0.75,
            reset_after_minutes=360,
            created_at=nightwatch.now_iso(),
            updated_at=nightwatch.now_iso(),
            planned_resume_at=(now + timedelta(seconds=90)).isoformat(),
        )

        self.assertEqual(nightwatch.resume_delay_seconds(state, now), 90)

    def test_supervise_dry_run_prints_initial_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            state_path = tmp_path / "state.json"
            state = nightwatch.NightwatchState(
                version=1,
                objective="overnight build",
                cwd=str(tmp_path),
                prompt="build the MVP",
                token_budget=1000,
                reserve_tokens=100,
                checkpoint_ratio=0.75,
                reset_after_minutes=360,
                created_at=nightwatch.now_iso(),
                updated_at=nightwatch.now_iso(),
            )
            nightwatch.save_state(state_path, state)

            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = nightwatch.supervise(
                    Namespace(
                        state=state_path,
                        log_dir=tmp_path,
                        execute=False,
                        codex_bin=Path("C:/Tools/Codex/codex.exe"),
                        max_cycles=2,
                        timeout_seconds=5,
                        inactivity_timeout_seconds=1,
                        max_sleep_seconds=0,
                        resume_first=False,
                        resume_after_stop=False,
                        resume_prompt=None,
                        allow_last=False,
                        codex_arg=["--sandbox", "read-only"],
                        resume_arg=[],
                    )
                )

            self.assertEqual(code, 0)
            self.assertIn("codex.exe exec --json", output.getvalue())
            updated = nightwatch.load_state(state_path)
            self.assertEqual(updated.last_command[:4], [str(Path("C:/Tools/Codex/codex.exe")), "exec", "--json", "--sandbox"])

    def test_supervise_treats_stop_as_terminal_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            state_path = tmp_path / "state.json"
            state = nightwatch.NightwatchState(
                version=1,
                objective="overnight build",
                cwd=str(tmp_path),
                prompt="build the MVP",
                token_budget=1000,
                reserve_tokens=100,
                checkpoint_ratio=0.75,
                reset_after_minutes=360,
                created_at=nightwatch.now_iso(),
                updated_at=nightwatch.now_iso(),
                thread_id="abc",
            )
            nightwatch.save_state(state_path, state)
            calls = []
            original = nightwatch.run_state_command

            def fake_run_state_command(*args):
                calls.append(args)
                updated = nightwatch.load_state(state_path)
                updated.status = "stopped"
                updated.decision = {"action": "stop", "reason": "usage reached the stop threshold"}
                updated.thread_id = "abc"
                nightwatch.save_state(state_path, updated)
                return 0

            try:
                nightwatch.run_state_command = fake_run_state_command
                code = nightwatch.supervise(
                    Namespace(
                        state=state_path,
                        log_dir=tmp_path,
                        execute=True,
                        codex_bin=Path("C:/Tools/Codex/codex.exe"),
                        max_cycles=3,
                        timeout_seconds=5,
                        inactivity_timeout_seconds=1,
                        max_sleep_seconds=0,
                        resume_first=False,
                        resume_after_stop=False,
                        resume_prompt=None,
                        allow_last=False,
                        codex_arg=["--sandbox", "read-only"],
                        resume_arg=[],
                    )
                )
            finally:
                nightwatch.run_state_command = original

            self.assertEqual(code, 0)
            self.assertEqual(len(calls), 1)

    def test_validate_codex_args_blocks_dangerous_flags(self):
        with self.assertRaises(ValueError):
            nightwatch.validate_codex_args(["--sandbox", "danger-full-access"])

    def test_validate_resume_args_rejects_initial_run_only_sandbox_flag(self):
        with self.assertRaises(ValueError):
            nightwatch.validate_resume_args(["--sandbox", "workspace-write"])
        with self.assertRaises(ValueError):
            nightwatch.validate_resume_args(["--sandbox=workspace-write"])

    def test_init_records_run_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "state.json"
            with contextlib.redirect_stdout(io.StringIO()):
                code = nightwatch.init(
                    Namespace(
                        state=state_path,
                        objective="overnight build",
                        prompt="build the MVP",
                        resume_prompt=None,
                        cwd=Path(tmp),
                        reset_after_minutes=360,
                        token_budget=1000,
                        reserve_tokens=100,
                        checkpoint_ratio=0.75,
                        autonomy_mode="conservative",
                        approval_mode="stop-instead-of-asking",
                        commit_policy="commit-ready-only",
                        push_policy="forbidden",
                        scheduler_mode="dual",
                        resume_after_stop_allowed=True,
                    )
                )

            self.assertEqual(code, 0)
            state = nightwatch.load_state(state_path)
            self.assertEqual(state.run_contract["autonomy_mode"], "conservative")
            self.assertEqual(state.run_contract["approval_mode"], "stop-instead-of-asking")
            self.assertEqual(state.run_contract["commit_policy"], "commit-ready-only")
            self.assertEqual(state.run_contract["push_policy"], "forbidden")
            self.assertEqual(state.run_contract["scheduler_mode"], "dual")
            self.assertTrue(state.run_contract["resume_after_stop_allowed"])
            report = nightwatch.render_report(state)
            self.assertIn("Autonomy mode: conservative", report)
            self.assertIn("Resume-after-stop allowed: True", report)

    def test_init_warns_for_state_path_outside_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            workspace = tmp_path / "workspace"
            workspace.mkdir()
            state_path = tmp_path / "outside" / "state.json"
            stderr = io.StringIO()

            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(stderr):
                code = nightwatch.init(
                    Namespace(
                        state=state_path,
                        objective="overnight build",
                        prompt="build the MVP",
                        resume_prompt=None,
                        cwd=workspace,
                        reset_after_minutes=360,
                        token_budget=1000,
                        reserve_tokens=100,
                        checkpoint_ratio=0.75,
                        autonomy_mode="conservative",
                        approval_mode="stop-instead-of-asking",
                        commit_policy="commit-ready-only",
                        push_policy="forbidden",
                        scheduler_mode="manual",
                        resume_after_stop_allowed=False,
                    )
                )

            self.assertEqual(code, 0)
            self.assertIn("outside the project workspace", stderr.getvalue())

    def test_doctor_warns_for_untracked_runtime_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True, text=True)
            runtime_dir = tmp_path / ".codex" / "nightwatch"
            runtime_dir.mkdir(parents=True)
            (runtime_dir / "state.json").write_text("{}", encoding="utf-8")
            output = io.StringIO()

            with contextlib.redirect_stdout(output):
                code = nightwatch.doctor(
                    Namespace(
                        cwd=tmp_path,
                        state_dir=runtime_dir,
                        codex_bin=Path(sys.executable),
                    )
                )

            payload = json.loads(output.getvalue())
            self.assertEqual(code, 0)
            self.assertFalse(payload["runtime_artifact_hygiene_ok"])
            self.assertIn("do not commit", payload["runtime_artifact_warnings"][0])

    def test_build_codex_exec_command_accepts_explicit_binary(self):
        command = nightwatch.build_codex_exec_command(
            "build the MVP",
            ["--sandbox", "read-only"],
            Path("C:/Tools/Codex/codex.exe"),
        )

        self.assertEqual(
            command,
            [str(Path("C:/Tools/Codex/codex.exe")), "exec", "--json", "--sandbox", "read-only", "build the MVP"],
        )

    def test_execute_monitored_run_records_json_and_transcript_separately(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            state_path = tmp_path / "state.json"
            jsonl_path = tmp_path / "events.jsonl"
            transcript_path = tmp_path / "transcript.log"
            state = nightwatch.NightwatchState(
                version=1,
                objective="overnight build",
                cwd=str(tmp_path),
                prompt="build the MVP",
                token_budget=1000,
                reserve_tokens=100,
                checkpoint_ratio=0.75,
                reset_after_minutes=360,
                created_at=nightwatch.now_iso(),
                updated_at=nightwatch.now_iso(),
            )
            nightwatch.save_state(state_path, state)
            code = (
                "import json, sys; "
                "print(json.dumps({'type':'thread.started','thread_id':'abc'})); "
                "print(json.dumps({'type':'turn.completed','usage':{'input_tokens':10,'output_tokens':5,'reasoning_output_tokens':0}})); "
                "print('stderr line', file=sys.stderr)"
            )

            return_code = nightwatch.execute_monitored_run(
                [sys.executable, "-c", code],
                state,
                state_path,
                jsonl_path,
                transcript_path,
                timeout_seconds=5,
                inactivity_timeout_seconds=0,
            )

            self.assertEqual(return_code, 0)
            self.assertIn("thread.started", jsonl_path.read_text(encoding="utf-8"))
            self.assertIn("stderr line", transcript_path.read_text(encoding="utf-8"))
            updated = nightwatch.load_state(state_path)
            self.assertEqual(updated.thread_id, "abc")
            self.assertEqual(updated.status, "running")

    def test_execute_monitored_run_stops_on_inactivity(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            state_path = tmp_path / "state.json"
            jsonl_path = tmp_path / "events.jsonl"
            transcript_path = tmp_path / "transcript.log"
            state = nightwatch.NightwatchState(
                version=1,
                objective="overnight build",
                cwd=str(tmp_path),
                prompt="build the MVP",
                token_budget=1000,
                reserve_tokens=100,
                checkpoint_ratio=0.75,
                reset_after_minutes=360,
                created_at=nightwatch.now_iso(),
                updated_at=nightwatch.now_iso(),
            )
            nightwatch.save_state(state_path, state)

            return_code = nightwatch.execute_monitored_run(
                [sys.executable, "-c", "import time; time.sleep(10)"],
                state,
                state_path,
                jsonl_path,
                transcript_path,
                timeout_seconds=30,
                inactivity_timeout_seconds=1,
            )

            self.assertEqual(return_code, 124)
            updated = nightwatch.load_state(state_path)
            self.assertEqual(updated.status, "stopped")
            self.assertIn("inactivity", updated.decision["reason"])

    def test_execute_monitored_run_classifies_no_json_process_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            state_path = tmp_path / "state.json"
            jsonl_path = tmp_path / "events.jsonl"
            transcript_path = tmp_path / "transcript.log"
            state = nightwatch.NightwatchState(
                version=1,
                objective="overnight build",
                cwd=str(tmp_path),
                prompt="build the MVP",
                token_budget=1000,
                reserve_tokens=100,
                checkpoint_ratio=0.75,
                reset_after_minutes=360,
                created_at=nightwatch.now_iso(),
                updated_at=nightwatch.now_iso(),
            )
            nightwatch.save_state(state_path, state)

            return_code = nightwatch.execute_monitored_run(
                [sys.executable, "-c", "import sys; print('bad args', file=sys.stderr); sys.exit(2)"],
                state,
                state_path,
                jsonl_path,
                transcript_path,
                timeout_seconds=5,
                inactivity_timeout_seconds=0,
            )

            self.assertEqual(return_code, 2)
            self.assertIn("bad args", transcript_path.read_text(encoding="utf-8"))
            updated = nightwatch.load_state(state_path)
            self.assertEqual(updated.status, "stopped")
            self.assertIn("before emitting json events", updated.decision["reason"].lower())

    def test_supervise_does_not_continue_after_resume_infrastructure_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            state_path = tmp_path / "state.json"
            state = nightwatch.NightwatchState(
                version=1,
                objective="overnight build",
                cwd=str(tmp_path),
                prompt="build the MVP",
                token_budget=1000,
                reserve_tokens=100,
                checkpoint_ratio=0.75,
                reset_after_minutes=360,
                created_at=nightwatch.now_iso(),
                updated_at=nightwatch.now_iso(),
                thread_id="abc",
                status="stopped",
                decision={"action": "stop", "reason": "usage reached the stop threshold"},
            )
            nightwatch.save_state(state_path, state)
            calls = []
            original = nightwatch.run_state_command

            def fake_run_state_command(*args):
                calls.append(args)
                updated = nightwatch.load_state(state_path)
                updated.status = "stopped"
                updated.decision = {
                    "action": "stop",
                    "reason": "Codex process exited with code 2 before emitting JSON events; see transcript log",
                }
                updated.thread_id = "abc"
                nightwatch.save_state(state_path, updated)
                return 2

            try:
                nightwatch.run_state_command = fake_run_state_command
                code = nightwatch.supervise(
                    Namespace(
                        state=state_path,
                        log_dir=tmp_path,
                        execute=True,
                        codex_bin=Path("C:/Tools/Codex/codex.exe"),
                        max_cycles=3,
                        timeout_seconds=5,
                        inactivity_timeout_seconds=1,
                        max_sleep_seconds=0,
                        resume_first=False,
                        resume_after_stop=True,
                        resume_prompt=None,
                        allow_last=False,
                        codex_arg=["--sandbox", "read-only"],
                        resume_arg=[],
                    )
                )
            finally:
                nightwatch.run_state_command = original

            self.assertEqual(code, 2)
            self.assertEqual(len(calls), 1)


    def test_update_state_records_wrap_up_for_environment_blocker(self):
        events = [
            {"type": "thread.started", "thread_id": "abc"},
            {
                "type": "item.completed",
                "item": {
                    "type": "command_execution",
                    "status": "failed",
                    "command": "git add cohortwatch/tests/test_score.py",
                    "exit_code": 128,
                },
            },
            {"type": "item.completed", "item": {"type": "file_change", "path": "cohortwatch/tests/test_score.py"}},
            {"type": "error", "message": "git add failed: permission denied creating index.lock"},
        ]
        state = nightwatch.NightwatchState(
            version=1,
            objective="overnight build",
            cwd=str(ROOT),
            prompt="build the MVP",
            token_budget=1000,
            reserve_tokens=100,
            checkpoint_ratio=0.75,
            reset_after_minutes=360,
            created_at=nightwatch.now_iso(),
            updated_at=nightwatch.now_iso(),
        )

        nightwatch.update_state_from_events(state, events, Path("run.jsonl"))

        self.assertEqual(state.status, "stopped")
        self.assertEqual(state.wrap_up["outcome"], "Stopped safely")
        self.assertEqual(state.wrap_up["blocker_type"], "environment")
        self.assertIn("Fix the launcher/environment blocker", state.wrap_up["safe_next_action"])
        self.assertEqual(state.wrap_up["failed_commands"][0]["command"], "git add cohortwatch/tests/test_score.py")
        self.assertEqual(state.wrap_up["changed_files"], ["cohortwatch/tests/test_score.py"])

    def test_render_report_includes_wrap_up_changed_files_and_failed_commands(self):
        state = nightwatch.NightwatchState(
            version=1,
            objective="overnight build",
            cwd=str(ROOT),
            prompt="build the MVP",
            token_budget=1000,
            reserve_tokens=100,
            checkpoint_ratio=0.75,
            reset_after_minutes=360,
            created_at=nightwatch.now_iso(),
            updated_at=nightwatch.now_iso(),
            status="stopped",
            thread_id="abc",
            summary={"turns": 1, "billable_like_tokens": 10},
            decision={"action": "stop", "reason": "git add failed: permission denied creating index.lock"},
            wrap_up={
                "outcome": "Stopped safely",
                "blocker_type": "environment",
                "reason": "git add failed: permission denied creating index.lock",
                "safe_next_action": "Fix the launcher/environment blocker first, then rerun or resume from the recorded thread id.",
                "changed_files": ["src/app.py"],
                "failed_commands": [{"command": "git add src/app.py", "status": "failed", "exit_code": 128}],
            },
        )

        report = nightwatch.render_report(state)

        self.assertIn("## Wrap-Up", report)
        self.assertIn("Blocker type: environment", report)
        self.assertIn("Safe next action: Fix the launcher/environment blocker", report)
        self.assertIn("## Changed Files", report)
        self.assertIn("src/app.py", report)
        self.assertIn("## Failed Commands", report)
        self.assertIn("git add src/app.py (exit 128): failed", report)

    def test_run_dry_run_overrides_execute(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            state_path = tmp_path / "state.json"
            state = nightwatch.NightwatchState(
                version=1,
                objective="overnight build",
                cwd=str(tmp_path),
                prompt="build the MVP",
                token_budget=1000,
                reserve_tokens=100,
                checkpoint_ratio=0.75,
                reset_after_minutes=360,
                created_at=nightwatch.now_iso(),
                updated_at=nightwatch.now_iso(),
            )
            nightwatch.save_state(state_path, state)
            original = nightwatch.execute_monitored_run

            def fail_if_called(*args):
                raise AssertionError("dry-run should not execute Codex")

            try:
                nightwatch.execute_monitored_run = fail_if_called
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    code = nightwatch.run(
                        Namespace(
                            state=state_path,
                            jsonl=None,
                            transcript=None,
                            execute=True,
                            dry_run=True,
                            codex_bin=Path("C:/Tools/Codex/codex.exe"),
                            timeout_seconds=0,
                            inactivity_timeout_seconds=0,
                            codex_arg=[],
                        )
                    )
            finally:
                nightwatch.execute_monitored_run = original

            self.assertEqual(code, 0)
            self.assertIn("codex.exe exec --json", output.getvalue())
            updated = nightwatch.load_state(state_path)
            self.assertEqual(updated.status, "planned")

    def test_resume_run_dry_run_overrides_execute(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            state_path = tmp_path / "state.json"
            state = nightwatch.NightwatchState(
                version=1,
                objective="overnight build",
                cwd=str(tmp_path),
                prompt="build the MVP",
                token_budget=1000,
                reserve_tokens=100,
                checkpoint_ratio=0.75,
                reset_after_minutes=360,
                created_at=nightwatch.now_iso(),
                updated_at=nightwatch.now_iso(),
                thread_id="abc",
            )
            nightwatch.save_state(state_path, state)
            calls = []
            original = nightwatch.run_state_command

            def fake_run_state_command(*args):
                calls.append(args)
                return 0

            try:
                nightwatch.run_state_command = fake_run_state_command
                code = nightwatch.resume_run(
                    Namespace(
                        state=state_path,
                        jsonl=None,
                        transcript=None,
                        execute=True,
                        dry_run=True,
                        codex_bin=Path("C:/Tools/Codex/codex.exe"),
                        prompt=None,
                        allow_last=False,
                        timeout_seconds=0,
                        inactivity_timeout_seconds=0,
                        resume_arg=[],
                    )
                )
            finally:
                nightwatch.run_state_command = original

            self.assertEqual(code, 0)
            self.assertEqual(len(calls), 1)
            self.assertFalse(calls[0][-1])

    def test_cli_lifecycle_init_run_record_report_resume_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            state_path = tmp_path / ".nightwatch" / "state.json"
            report_path = tmp_path / ".nightwatch" / "report.md"
            script = ROOT / "scripts" / "nightwatch.py"
            base = [sys.executable, "-B", str(script)]

            subprocess.run(
                [
                    *base,
                    "init",
                    "--state",
                    str(state_path),
                    "--cwd",
                    str(tmp_path),
                    "--objective",
                    "Lifecycle proof",
                    "--prompt",
                    "Demonstrate the lifecycle.",
                    "--token-budget",
                    "5000",
                    "--reserve-tokens",
                    "1000",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            dry_run = subprocess.run(
                [
                    *base,
                    "run",
                    "--state",
                    str(state_path),
                    "--dry-run",
                    "--codex-bin",
                    "C:/Tools/Codex/codex.exe",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertIn("codex.exe exec --json", dry_run.stdout)

            subprocess.run(
                [
                    *base,
                    "record",
                    "--state",
                    str(state_path),
                    "--jsonl",
                    str(ROOT / "tests" / "sample_codex_events.jsonl"),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            subprocess.run(
                [*base, "report", "--state", str(state_path), "--output", str(report_path)],
                check=True,
                capture_output=True,
                text=True,
            )
            resume = subprocess.run(
                [*base, "resume-command", "--state", str(state_path)],
                check=True,
                capture_output=True,
                text=True,
            )

            self.assertTrue(report_path.exists())
            self.assertIn("Codex Nightwatch Report", report_path.read_text(encoding="utf-8"))
            self.assertIn("codex exec resume sample-thread", resume.stdout)

    def test_render_report_can_redact_sensitive_fields(self):
        state = nightwatch.NightwatchState(
            version=1,
            objective="overnight build",
            cwd="C:/private/path",
            prompt="secret prompt",
            token_budget=1000,
            reserve_tokens=100,
            checkpoint_ratio=0.75,
            reset_after_minutes=360,
            created_at=nightwatch.now_iso(),
            updated_at=nightwatch.now_iso(),
            thread_id="thread-secret",
            run_log="C:/private/path/events.jsonl",
            transcript_log="C:/private/path/transcript.log",
            summary={"turns": 1, "billable_like_tokens": 10},
            decision={"action": "continue", "reason": "ok"},
        )

        report = nightwatch.render_report(
            state,
            redact_prompts=True,
            redact_paths=True,
            redact_thread_ids=True,
        )

        self.assertIn("[redacted]", report)
        self.assertNotIn("C:/private/path", report)
        self.assertNotIn("thread-secret", report)
        self.assertNotIn("secret prompt", report)


if __name__ == "__main__":
    unittest.main()
