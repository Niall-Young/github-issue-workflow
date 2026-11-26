from __future__ import annotations

import datetime as dt
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "github-issue-autopilot" / "scripts" / "issue_watcher.py"
SPEC = importlib.util.spec_from_file_location("issue_watcher", SCRIPT)
WATCHER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(WATCHER)


class IssueWatcherTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "-C", str(self.repo), "init", "-b", "main"], check=True, stdout=subprocess.PIPE)
        subprocess.run(["git", "-C", str(self.repo), "config", "user.name", "Test"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "config", "user.email", "test@example.com"], check=True)
        subprocess.run(
            ["git", "-C", str(self.repo), "commit", "--allow-empty", "-m", "baseline"],
            check=True, stdout=subprocess.PIPE,
        )
        self.db = self.root / "state.sqlite3"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    @staticmethod
    def issue(node_id: str = "I_kwDO1", number: int = 1) -> dict:
        return {
            "id": node_id,
            "repository": "owner/repo",
            "number": number,
            "url": f"https://github.com/owner/repo/issues/{number}",
            "title": "Repair the thing",
            "createdAt": "2026-08-27T01:00:00Z",
            "updatedAt": "2026-08-27T01:01:00Z",
        }

    def ledger(self, attempts: int = 2) -> object:
        return WATCHER.Ledger(self.db, lease_seconds=20, max_attempts=attempts)

    def test_github_command_retries_transient_eof(self) -> None:
        failed = subprocess.CompletedProcess(["gh", "api", "user"], 1, "", "request: EOF")
        succeeded = subprocess.CompletedProcess(["gh", "api", "user"], 0, "owner\n", "")
        with mock.patch.object(WATCHER.subprocess, "run", side_effect=[failed, succeeded]) as run:
            result = WATCHER.command(["gh", "api", "user"])
        self.assertEqual(0, result.returncode)
        self.assertEqual(2, run.call_count)
        self.assertEqual("http2client=0", run.call_args.kwargs["env"]["GODEBUG"])

    def test_schema_v3_requires_orca_automation_identity(self) -> None:
        config = self.config()
        config["schema_version"] = 3
        config["state_db"] = str(config["state_db"])
        config["repositories"][0]["repo_path"] = str(self.repo)
        path = self.root / "autopilot.json"
        path.write_text(json.dumps(config), encoding="utf-8")
        with self.assertRaisesRegex(WATCHER.WatcherError, "scheduler ID"):
            WATCHER.load_config(path)
        config["scheduler"] = {"backend": "orca-automation", "automation_id": "auto-1"}
        path.write_text(json.dumps(config), encoding="utf-8")
        loaded = WATCHER.load_config(path)
        self.assertEqual("auto-1", loaded["scheduler"]["automation_id"])

    def test_scheduler_enabled_reads_native_automation_state(self) -> None:
        config = self.config()
        config["schema_version"] = 3
        config["scheduler"] = {"backend": "orca-automation", "automation_id": "auto-1"}
        with mock.patch.object(WATCHER, "orca_call", return_value={
            "result": {"automation": {"enabled": True}}
        }) as call:
            self.assertTrue(WATCHER.scheduler_enabled(config))
        call.assert_called_once_with(config, "automations", "show", "auto-1")
        with mock.patch.object(WATCHER, "orca_call", return_value={
            "result": {"automation": {"enabled": False}}
        }):
            self.assertFalse(WATCHER.scheduler_enabled(config))

    def test_schema_v2_coordinator_remains_compatible_during_migration(self) -> None:
        self.assertTrue(WATCHER.scheduler_enabled(self.config()))

    def test_run_exits_cleanly_when_native_automation_is_paused(self) -> None:
        config = self.config()
        config["schema_version"] = 3
        config["scheduler"] = {"backend": "orca-automation", "automation_id": "auto-1"}
        with mock.patch.object(WATCHER.sys, "argv", [
            "issue_watcher.py", "run", "--config", str(self.root / "config.json")
        ]), mock.patch.object(WATCHER, "load_config", return_value=config), mock.patch.object(
            WATCHER, "runtime_workspace_error", return_value=None
        ), mock.patch.object(WATCHER, "scheduler_enabled", return_value=False
        ), mock.patch("builtins.print") as output:
            self.assertEqual(0, WATCHER.main())
        self.assertIn("scheduler-paused", output.call_args.args[0])

    def test_run_exits_nonzero_when_scheduler_status_is_unavailable(self) -> None:
        config = self.config()
        config["schema_version"] = 3
        config["scheduler"] = {"backend": "orca-automation", "automation_id": "auto-1"}
        with mock.patch.object(WATCHER.sys, "argv", [
            "issue_watcher.py", "run", "--config", str(self.root / "config.json")
        ]), mock.patch.object(WATCHER, "load_config", return_value=config), mock.patch.object(
            WATCHER, "runtime_workspace_error", return_value=None
        ), mock.patch.object(
            WATCHER, "scheduler_enabled", side_effect=WATCHER.WatcherError("Automation missing")
        ), mock.patch("builtins.print") as output:
            self.assertEqual(2, WATCHER.main())
        self.assertIn("scheduler-unavailable", output.call_args.args[0])

    def test_runtime_workspace_loss_pauses_native_automation(self) -> None:
        config = self.config()
        config["schema_version"] = 3
        config["scheduler"] = {"backend": "orca-automation", "automation_id": "auto-1"}
        config["repositories"][0]["repo_path"] = self.root / "missing"
        self.assertIn("missing", WATCHER.runtime_workspace_error(config))
        with mock.patch.object(WATCHER, "orca_call", return_value={"result": {}}) as call:
            result = WATCHER.pause_for_missing_workspace(config, "missing")
        self.assertEqual("paused-missing-workspace", result["status"])
        call.assert_called_once_with(config, "automations", "edit", "auto-1", "--disabled")

    def test_explicit_discard_settles_missing_orca_worker_and_worktree(self) -> None:
        ledger = self.ledger()
        ledger.enqueue(self.issue())
        claimed = ledger.claim_next()
        ledger.assign_orca(
            claimed["node_id"], claimed["attempt_number"], run_id=str(uuid.uuid4()), agent_id="codex",
            orca_task_id="task-1", orca_dispatch_id="dispatch-missing",
            orca_worktree_id=f"repo::{self.root / 'missing-worktree'}",
            worktree_path=str(self.root / "missing-worktree"), branch="owner/issue-1-attempt-1",
        )
        with mock.patch.object(WATCHER, "json_command",
                               side_effect=WATCHER.WatcherError("dispatch not found")):
            result = ledger.discard(self.issue()["url"], self.repo, "/bin/orca")
        self.assertEqual("discarded", result["status"])
        self.assertEqual("discarded", ledger.snapshot()["issues"][0]["status"])

    def test_explicit_discard_refuses_live_orca_worker(self) -> None:
        ledger = self.ledger()
        ledger.enqueue(self.issue())
        claimed = ledger.claim_next()
        ledger.assign_orca(
            claimed["node_id"], claimed["attempt_number"], run_id=str(uuid.uuid4()), agent_id="codex",
            orca_task_id="task-1", orca_dispatch_id="dispatch-live",
            orca_worktree_id=f"repo::{self.root / 'live-worktree'}",
            worktree_path=str(self.root / "live-worktree"), branch="owner/issue-1-attempt-1",
        )
        with mock.patch.object(WATCHER, "json_command", return_value={"status": "running"}), self.assertRaisesRegex(
            WATCHER.WatcherError, "still running"
        ):
            ledger.discard(self.issue()["url"], self.repo, "/bin/orca")

    def repair_evidence(self, worktree: Path, branch: str, base: str, head: str) -> dict:
        run_id = str(uuid.uuid4())
        common = subprocess.run(
            ["git", "-C", str(self.repo), "rev-parse", "--git-common-dir"], check=True, text=True,
            stdout=subprocess.PIPE,
        ).stdout.strip()
        common_path = Path(common) if Path(common).is_absolute() else self.repo / common
        state = common_path.resolve() / "issue-repair" / "runs" / run_id / "state.json"
        state.parent.mkdir(parents=True)
        state.write_text(json.dumps({
            "run_id": run_id, "repository": str(self.repo.resolve()), "base_sha": base,
            "source_url": self.issue()["url"], "state": "AWAIT_PUBLICATION_APPROVAL",
            "receipts": {"commit": {"kind": "commit", "value": head}},
        }), encoding="utf-8")
        return {"run_id": run_id, "worktree_path": str(worktree), "branch": branch,
                "base_sha": base, "head_sha": head}

    def config(self) -> dict:
        return {
            "schema_version": 2,
            "state_db": self.db,
            "lease_timeout_seconds": 20,
            "max_attempts": 2,
            "max_concurrent_workers": 3,
            "policy": {"scope_approval": "eligible-issue", "publication": "never", "max_risk": "medium"},
            "repositories": [{
                "repository": "owner/repo",
                "repo_path": self.repo,
                "author": "@me",
                "labels": [],
            }],
            "orca": {"cli": sys.executable, "default_agent": "codex",
                     "allowed_agents": ["codex", "claude"], "setup": "run"},
        }

    def reconcile_invalid_output(self, receipt: str, show: dict) -> tuple[dict, dict]:
        config, ledger = self.config(), self.ledger()
        ledger.enqueue(self.issue())
        claimed = ledger.claim_next()
        ledger.assign_orca(
            claimed["node_id"], claimed["attempt_number"], run_id=str(uuid.uuid4()), agent_id="codex",
            orca_task_id="task-1", orca_dispatch_id="dispatch-1",
            orca_worktree_id="repo::/tmp/invalid-output", worktree_path="/tmp/invalid-output",
        )
        with mock.patch.object(WATCHER, "orca_call", side_effect=[
            show, {"ok": True, "result": {"rows": [{"text": receipt}]}},
            {"ok": True, "result": {}},
            {"ok": True, "result": {}},
        ]):
            completed = WATCHER.reconcile_workers(config, ledger)
        attempt = ledger.snapshot()["issues"][0]["attempt_history"][0]
        return completed[0], attempt

    def test_node_id_is_idempotent_and_edits_do_not_retrigger(self) -> None:
        ledger = self.ledger()
        issue = self.issue()
        self.assertTrue(ledger.enqueue(issue))
        edited = dict(issue, title="Edited title", updatedAt="2026-08-27T02:00:00Z")
        self.assertFalse(ledger.enqueue(edited))
        first = ledger.claim_next()
        self.assertIsNotNone(first)
        ledger.finish(first["node_id"], first["attempt_number"], "succeeded", summary="done")
        self.assertIsNone(ledger.claim_next())
        self.assertEqual("ready-for-review", ledger.snapshot()["issues"][0]["status"])

    def test_failed_open_issue_requeues_once_up_to_automatic_attempt_limit(self) -> None:
        ledger = self.ledger(attempts=2)
        issue = self.issue()
        self.assertTrue(ledger.enqueue(issue))
        first = ledger.claim_next()
        ledger.finish(first["node_id"], first["attempt_number"], "failed",
                      summary="worker stopped")

        self.assertTrue(ledger.enqueue(issue))
        second = ledger.claim_next()
        self.assertEqual(2, second["attempt_number"])
        ledger.finish(second["node_id"], second["attempt_number"], "failed",
                      summary="worker stopped again")

        self.assertFalse(ledger.enqueue(issue))
        self.assertIsNone(ledger.claim_next())
        snapshot = ledger.snapshot()["issues"][0]
        self.assertEqual("failed", snapshot["status"])
        self.assertEqual(["failed", "failed"],
                         [attempt["status"] for attempt in snapshot["attempt_history"]])

        self.assertEqual(3, ledger.retry(issue["url"], self.repo, False))
        self.assertEqual(3, ledger.claim_next()["attempt_number"])

    def test_next_poll_requeues_failed_issue_that_remains_open_and_eligible(self) -> None:
        config, ledger = self.config(), self.ledger(attempts=2)
        issue = self.issue()
        ledger.enqueue(issue)
        claimed = ledger.claim_next()
        ledger.finish(claimed["node_id"], claimed["attempt_number"], "failed",
                      summary="worker stopped")
        eligible = dict(issue, author={"login": "owner"}, labels=[])

        with mock.patch.object(WATCHER, "github_login", return_value="owner"), \
                mock.patch.object(WATCHER, "list_issues", return_value=[eligible]):
            detection = WATCHER.poll(config, ledger)

        self.assertEqual({"observed": 1, "enqueued": 1}, detection)
        self.assertEqual(2, ledger.claim_next()["attempt_number"])

    def test_review_and_human_stops_do_not_requeue_when_issue_stays_open(self) -> None:
        for status in ("ready-for-review", "needs-human", "blocked"):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as temporary:
                ledger = WATCHER.Ledger(Path(temporary) / "state.sqlite3",
                                        lease_seconds=20, max_attempts=2)
                issue = self.issue()
                ledger.enqueue(issue)
                claimed = ledger.claim_next()
                ledger.finish(claimed["node_id"], claimed["attempt_number"], status,
                              summary="wait for a person")
                self.assertFalse(ledger.enqueue(issue))
                self.assertIsNone(ledger.claim_next())

    def test_overlapping_failed_issue_scans_only_requeue_once(self) -> None:
        first = self.ledger(attempts=2)
        second = self.ledger(attempts=2)
        issue = self.issue()
        first.enqueue(issue)
        claimed = first.claim_next()
        first.finish(claimed["node_id"], claimed["attempt_number"], "failed",
                     summary="worker stopped")

        self.assertTrue(first.enqueue(issue))
        self.assertFalse(second.enqueue(issue))
        self.assertEqual(2, second.claim_next()["attempt_number"])
        self.assertIsNone(first.claim_next())

    def test_overlapping_claims_only_return_one_run(self) -> None:
        first = self.ledger()
        second = self.ledger()
        first.enqueue(self.issue())
        first.enqueue(self.issue("I_kwDO2", 2))
        self.assertIsNotNone(first.claim_next())
        self.assertIsNone(second.claim_next())
        claimed = first.snapshot()["issues"][0]
        first.finish(claimed["node_id"], claimed["attempts"], "succeeded", summary="done")
        self.assertEqual(2, second.claim_next()["issue_number"])

    def test_stale_dead_lease_stops_for_human_instead_of_relaunching(self) -> None:
        ledger = self.ledger(attempts=2)
        ledger.enqueue(self.issue())
        original = dt.datetime(2026, 8, 27, 1, 0, tzinfo=dt.timezone.utc)
        first = ledger.claim_next(original)
        self.assertEqual(1, first["attempt_number"])
        self.assertIsNone(ledger.claim_next(original + dt.timedelta(seconds=21)))
        snapshot = ledger.snapshot()["issues"][0]
        self.assertEqual("needs-human", snapshot["status"])
        self.assertEqual(1, len(snapshot["attempt_history"]))

    def test_issue_filters_apply_author_and_label_without_age_cutoff(self) -> None:
        repository = self.config()["repositories"][0]
        repository["labels"] = ["agent-ready"]
        values = [
            {**self.issue("new", 1), "author": {"login": "owner"}, "labels": [{"name": "agent-ready"}]},
            {**self.issue("old", 2), "createdAt": "2026-08-26T23:59:00Z", "author": {"login": "owner"}, "labels": [{"name": "agent-ready"}]},
            {**self.issue("other", 3), "author": {"login": "someone"}, "labels": [{"name": "agent-ready"}]},
            {**self.issue("unlabeled", 4), "author": {"login": "owner"}, "labels": []},
        ]
        metadata = {"id": "R_1", "nameWithOwner": "owner/repo", "isArchived": False, "hasIssuesEnabled": True}
        calls = [
            subprocess.CompletedProcess([], 0, json.dumps(metadata), ""),
            subprocess.CompletedProcess([], 0, json.dumps(values), ""),
        ]
        with mock.patch.object(WATCHER, "command", side_effect=calls):
            eligible = WATCHER.list_issues(repository, "owner")
        self.assertEqual(["new", "old"], [issue["id"] for issue in eligible])

    def test_issue_filter_includes_backlog_through_poll_boundary(self) -> None:
        repository = self.config()["repositories"][0]
        repository["labels"] = ["agent-ready"]
        boundary = dt.datetime(2026, 8, 27, 1, 0, 1, tzinfo=dt.timezone.utc)
        values = [
            {**self.issue("boundary", 1), "createdAt": "2026-08-27T01:00:01Z",
             "author": {"login": "owner"}, "labels": [{"name": "agent-ready"}]},
            {**self.issue("backlog", 2), "createdAt": "2026-08-27T00:00:00Z",
             "author": {"login": "owner"}, "labels": [{"name": "agent-ready"}]},
        ]
        metadata = {"id": "R_1", "nameWithOwner": "owner/repo",
                    "isArchived": False, "hasIssuesEnabled": True}
        calls = [
            subprocess.CompletedProcess([], 0, json.dumps(metadata), ""),
            subprocess.CompletedProcess([], 0, json.dumps(values), ""),
        ]
        with mock.patch.object(WATCHER, "command", side_effect=calls):
            eligible = WATCHER.list_issues(repository, "owner", created_through=boundary)
        self.assertEqual(["boundary", "backlog"], [issue["id"] for issue in eligible])

    def test_repeated_full_scans_include_backlog_and_deduplicate_node_id(self) -> None:
        config, ledger = self.config(), self.ledger()
        ledger.set_metadata("poll_cursor:owner/repo", "2099-01-01T00:00:00+00:00")
        issue = {**self.issue(), "createdAt": "2026-08-27T01:00:01Z",
                 "author": {"login": "owner"}, "labels": []}
        metadata = {"id": "R_1", "nameWithOwner": "owner/repo",
                    "isArchived": False, "hasIssuesEnabled": True}
        empty = subprocess.CompletedProcess([], 0, "[]", "")
        visible = subprocess.CompletedProcess([], 0, json.dumps([issue]), "")
        repo = subprocess.CompletedProcess([], 0, json.dumps(metadata), "")
        boundaries = [
            dt.datetime(2026, 8, 27, 1, 0, 1, 900000, tzinfo=dt.timezone.utc),
            dt.datetime(2026, 8, 27, 1, 0, 2, 900000, tzinfo=dt.timezone.utc),
            dt.datetime(2026, 8, 27, 1, 0, 2, 950000, tzinfo=dt.timezone.utc),
            dt.datetime(2026, 8, 27, 1, 0, 3, 900000, tzinfo=dt.timezone.utc),
        ]
        with mock.patch.object(WATCHER, "github_login", return_value="owner"), mock.patch.object(
            WATCHER, "now", side_effect=boundaries
        ), mock.patch.object(WATCHER, "command", side_effect=[repo, empty, repo, visible, repo, visible]):
            first = WATCHER.poll(config, ledger)
            second = WATCHER.poll(config, ledger)
            repeated = WATCHER.poll(config, ledger)
        self.assertEqual(0, first["enqueued"])
        self.assertEqual(1, second["enqueued"])
        self.assertEqual(0, repeated["enqueued"])
        self.assertEqual(1, len(ledger.snapshot()["issues"]))

    def test_doctor_does_not_initialize_sqlite_ledger(self) -> None:
        config = self.config()
        with mock.patch.object(WATCHER.sys, "argv", ["issue_watcher.py", "doctor",
                                                     "--config", str(self.root / "config.json")]), mock.patch.object(
            WATCHER, "load_config", return_value=config
        ), mock.patch.object(WATCHER, "doctor", return_value={"ok": True}), mock.patch.object(
            WATCHER, "Ledger", side_effect=AssertionError("doctor must stay read-only")
        ), mock.patch("builtins.print"):
            self.assertEqual(0, WATCHER.main())

    def test_claim_many_starts_three_and_leaves_the_fourth_queued(self) -> None:
        ledger = self.ledger()
        for number in range(1, 5):
            ledger.enqueue(self.issue(f"I_kwDO{number}", number))
        claimed = ledger.claim_many(3)
        self.assertEqual([1, 2, 3], [item["issue_number"] for item in claimed])
        self.assertEqual("queued", ledger.snapshot()["issues"][3]["status"])

    def test_issue_agent_label_overrides_repository_default(self) -> None:
        config = self.config()
        self.assertEqual("codex", WATCHER.select_agent({"labels": []}, config))
        self.assertEqual("claude", WATCHER.select_agent(
            {"labels": [{"name": "agent:claude"}]}, config))
        with self.assertRaisesRegex(WATCHER.WatcherError, "multiple agent labels"):
            WATCHER.select_agent(
                {"labels": [{"name": "agent:codex"}, {"name": "agent:claude"}]}, config)

    def test_dispatch_creates_orca_child_worker_with_selected_agent(self) -> None:
        config = self.config()
        ledger = self.ledger()
        issue = self.issue()
        ledger.enqueue(issue)
        claimed = ledger.claim_next()
        eligible = dict(issue, author={"login": "owner"}, labels=[])
        with mock.patch.object(WATCHER, "github_login", return_value="owner"), mock.patch.object(
            WATCHER, "list_issues", return_value=[eligible]
        ) as list_issues, mock.patch.object(
            WATCHER, "create_orca_task", return_value="task-1"
        ), mock.patch.object(WATCHER, "orca_call", side_effect=[
            {"ok": True, "result": {"dispatch": {"id": "dispatch-1"}, "worktree": {
                "id": "repo::/tmp/issue-1", "path": "/tmp/issue-1", "branch": "refs/heads/issue-1"
            }}},
            {"ok": True, "result": {}},
        ]):
            result = WATCHER.dispatch_one(config, ledger, "run-1", claimed)
        self.assertEqual("running", result["status"])
        attempt = ledger.snapshot()["issues"][0]["attempt_history"][0]
        self.assertEqual("codex", attempt["agent_id"])
        self.assertEqual("dispatch-1", attempt["orca_dispatch_id"])
        self.assertEqual({}, list_issues.call_args.kwargs)

    def test_dispatch_accepts_concise_worker_start_receipt_with_local_workspace(self) -> None:
        config = self.config()
        ledger = self.ledger()
        issue = self.issue()
        ledger.enqueue(issue)
        claimed = ledger.claim_next()
        worktree = self.root / "concise-issue-1"
        subprocess.run(
            ["git", "-C", str(self.repo), "worktree", "add", "-b", "owner/issue-1-attempt-1",
             str(worktree), "HEAD"], check=True, stdout=subprocess.PIPE,
        )
        eligible = dict(issue, author={"login": "owner"}, labels=[])
        with mock.patch.object(WATCHER, "github_login", return_value="owner"), mock.patch.object(
            WATCHER, "list_issues", return_value=[eligible]
        ), mock.patch.object(
            WATCHER, "create_orca_task", return_value="task-concise"
        ), mock.patch.object(WATCHER, "orca_call", side_effect=[
            {"ok": True, "result": {
                "dispatchId": "ctx_concise", "taskId": "task-concise",
                "workspace": f"repo::{worktree}",
            }},
            {"ok": True, "result": {}},
        ]) as orca_call:
            result = WATCHER.dispatch_one(config, ledger, "run-1", claimed)
        self.assertEqual("running", result["status"])
        self.assertEqual(2, len(orca_call.call_args_list))
        attempt = ledger.snapshot()["issues"][0]["attempt_history"][0]
        self.assertEqual("ctx_concise", attempt["orca_dispatch_id"])
        self.assertEqual(f"repo::{worktree}", attempt["orca_worktree_id"])
        self.assertEqual(str(worktree), attempt["worktree_path"])
        self.assertEqual("owner/issue-1-attempt-1", attempt["branch"])

    def test_dispatch_falls_back_to_orca_worktree_show_for_concise_workspace(self) -> None:
        config = self.config()
        ledger = self.ledger()
        issue = self.issue()
        ledger.enqueue(issue)
        claimed = ledger.claim_next()
        missing_path = self.root / "not-local-issue-1"
        eligible = dict(issue, author={"login": "owner"}, labels=[])
        with mock.patch.object(WATCHER, "github_login", return_value="owner"), mock.patch.object(
            WATCHER, "list_issues", return_value=[eligible]
        ), mock.patch.object(
            WATCHER, "create_orca_task", return_value="task-show"
        ), mock.patch.object(WATCHER, "orca_call", side_effect=[
            {"ok": True, "result": {
                "dispatchId": "ctx_show", "taskId": "task-show",
                "workspace": f"repo::{missing_path}",
            }},
            {"ok": True, "result": {"worktree": {
                "id": f"repo::{missing_path}", "path": str(missing_path),
                "branch": "refs/heads/owner/issue-1-attempt-1",
            }}},
            {"ok": True, "result": {}},
        ]) as orca_call:
            result = WATCHER.dispatch_one(config, ledger, "run-1", claimed)
        self.assertEqual("running", result["status"])
        self.assertEqual(("worktree", "show"), orca_call.call_args_list[1].args[1:3])
        attempt = ledger.snapshot()["issues"][0]["attempt_history"][0]
        self.assertEqual("ctx_show", attempt["orca_dispatch_id"])
        self.assertEqual(f"repo::{missing_path}", attempt["orca_worktree_id"])
        self.assertEqual(str(missing_path), attempt["worktree_path"])
        self.assertEqual("owner/issue-1-attempt-1", attempt["branch"])

    def test_orca_identities_cannot_be_reused_by_another_attempt_or_issue(self) -> None:
        ledger = self.ledger()
        ledger.enqueue(self.issue())
        first = ledger.claim_next()
        identities = {
            "run_id": str(uuid.uuid4()), "agent_id": "codex", "orca_task_id": "task-1",
            "orca_dispatch_id": "dispatch-1", "orca_worktree_id": "repo::/tmp/issue-1",
            "worktree_path": "/tmp/issue-1", "branch": "issue-1-attempt-1",
        }
        ledger.assign_orca(first["node_id"], first["attempt_number"], **identities)
        ledger.finish(first["node_id"], first["attempt_number"], "needs-human", summary="retry")

        ledger.enqueue(self.issue("I_kwDO2", 2))
        second = ledger.claim_next()
        for name in ("orca_task_id", "orca_dispatch_id", "orca_worktree_id", "worktree_path"):
            candidate = {
                **identities, "run_id": str(uuid.uuid4()), "orca_task_id": "task-2",
                "orca_dispatch_id": "dispatch-2", "orca_worktree_id": "repo::/tmp/issue-2",
                "worktree_path": "/tmp/issue-2", "branch": "issue-2-attempt-1",
                name: identities[name],
            }
            with self.subTest(name=name), self.assertRaisesRegex(
                WATCHER.OrcaIdentityError, name
            ):
                ledger.assign_orca(second["node_id"], second["attempt_number"], **candidate)

        history = ledger.snapshot()["issues"][0]["attempt_history"][0]
        self.assertEqual("dispatch-1", history["orca_dispatch_id"])
        self.assertEqual("/tmp/issue-1", history["worktree_path"])

    def test_dispatch_identity_reuse_fails_closed_without_copying_identity(self) -> None:
        config = self.config()
        ledger = self.ledger()
        ledger.enqueue(self.issue("I_kwDO-old", 9))
        old = ledger.claim_next()
        ledger.assign_orca(
            old["node_id"], old["attempt_number"], run_id=str(uuid.uuid4()), agent_id="codex",
            orca_task_id="task-old", orca_dispatch_id="dispatch-old",
            orca_worktree_id="repo::/tmp/shared", worktree_path="/tmp/shared",
            branch="issue-9-attempt-1",
        )
        ledger.finish(old["node_id"], old["attempt_number"], "needs-human", summary="stopped")
        issue = self.issue()
        ledger.enqueue(issue)
        claimed = ledger.claim_next()
        eligible = dict(issue, author={"login": "owner"}, labels=[])
        with mock.patch.object(WATCHER, "github_login", return_value="owner"), mock.patch.object(
            WATCHER, "list_issues", return_value=[eligible]
        ), mock.patch.object(
            WATCHER, "create_orca_task", return_value="task-new"
        ), mock.patch.object(WATCHER, "orca_call", side_effect=[
            {"ok": True, "result": {"dispatch": {"id": "dispatch-new"}, "worktree": {
                "id": "repo::/tmp/shared", "path": "/tmp/shared",
                "branch": "refs/heads/issue-1-attempt-1"
            }}},
            {"ok": True, "result": {}},
        ]) as orca_call, mock.patch.object(WATCHER, "create_blocked_worktree") as blocked:
            result = WATCHER.dispatch_one(config, ledger, "run-1", claimed)

        self.assertEqual("needs-human", result["status"])
        self.assertIn("reused recorded orca_worktree_id", result["summary"])
        self.assertFalse(blocked.called)
        self.assertEqual("worker-stop", orca_call.call_args_list[1].args[2])
        self.assertNotIn("worktree", [call.args[1] for call in orca_call.call_args_list[1:]])
        attempt = ledger.snapshot()["issues"][0]["attempt_history"][0]
        self.assertEqual("task-new", attempt["orca_task_id"])
        self.assertEqual("dispatch-new", attempt["orca_dispatch_id"])
        self.assertIsNone(attempt["orca_worktree_id"])

    def test_failed_worker_fence_preserves_ids_and_blocks_retry_while_running(self) -> None:
        config = self.config()
        ledger = self.ledger()
        ledger.enqueue(self.issue("I_kwDO-old", 9))
        old = ledger.claim_next()
        ledger.assign_orca(
            old["node_id"], old["attempt_number"], run_id=str(uuid.uuid4()), agent_id="codex",
            orca_task_id="task-old", orca_dispatch_id="dispatch-old",
            orca_worktree_id="repo::/tmp/shared", worktree_path="/tmp/shared",
            branch="issue-9-attempt-1",
        )
        ledger.finish(old["node_id"], old["attempt_number"], "needs-human", summary="stopped")
        issue = self.issue()
        ledger.enqueue(issue)
        claimed = ledger.claim_next()
        eligible = dict(issue, author={"login": "owner"}, labels=[])
        with mock.patch.object(WATCHER, "github_login", return_value="owner"), mock.patch.object(
            WATCHER, "list_issues", return_value=[eligible]
        ), mock.patch.object(
            WATCHER, "create_orca_task", return_value="task-new"
        ), mock.patch.object(WATCHER, "orca_call", side_effect=[
            {"ok": True, "result": {"dispatch": {"id": "dispatch-new"}, "worktree": {
                "id": "repo::/tmp/shared", "path": "/tmp/shared",
                "branch": "refs/heads/issue-1-attempt-1"
            }}},
            WATCHER.WatcherError("stop failed"),
        ]):
            result = WATCHER.dispatch_one(config, ledger, "run-1", claimed)

        self.assertEqual("needs-human", result["status"])
        attempt = ledger.snapshot()["issues"][0]["attempt_history"][0]
        self.assertEqual("task-new", attempt["orca_task_id"])
        self.assertEqual("dispatch-new", attempt["orca_dispatch_id"])
        with mock.patch.object(
            WATCHER, "json_command", return_value={"status": "running"}
        ), self.assertRaisesRegex(WATCHER.WatcherError, "still running"):
            ledger.retry(issue["url"], self.repo, False, orca_cli="orca")

    def test_nonstalled_orca_error_cannot_record_duplicate_residual_worktree(self) -> None:
        config = self.config()
        ledger = self.ledger()
        ledger.enqueue(self.issue("I_kwDO-old", 9))
        old = ledger.claim_next()
        ledger.assign_orca(
            old["node_id"], old["attempt_number"], run_id=str(uuid.uuid4()), agent_id="codex",
            orca_task_id="task-old", orca_dispatch_id="dispatch-old",
            orca_worktree_id="repo::/tmp/shared", worktree_path="/tmp/shared",
            branch="issue-9-attempt-1",
        )
        ledger.finish(old["node_id"], old["attempt_number"], "needs-human", summary="stopped")
        issue = self.issue()
        ledger.enqueue(issue)
        claimed = ledger.claim_next()
        eligible = dict(issue, author={"login": "owner"}, labels=[])
        residual = {"result": {"dispatchId": "dispatch-new", "worktree": {
            "id": "repo::/tmp/shared", "path": "/tmp/shared",
            "branch": "refs/heads/issue-1-attempt-1"
        }}}
        with mock.patch.object(WATCHER, "github_login", return_value="owner"), mock.patch.object(
            WATCHER, "list_issues", return_value=[eligible]
        ), mock.patch.object(
            WATCHER, "create_orca_task", return_value="task-new"
        ), mock.patch.object(
            WATCHER, "orca_call", side_effect=WATCHER.OrcaCommandError("Orca failed", residual)
        ), mock.patch.object(WATCHER, "create_blocked_worktree") as blocked:
            result = WATCHER.dispatch_one(config, ledger, "run-1", claimed)

        self.assertEqual("needs-human", result["status"])
        self.assertFalse(blocked.called)
        attempt = ledger.snapshot()["issues"][0]["attempt_history"][0]
        self.assertEqual("task-new", attempt["orca_task_id"])
        self.assertEqual("dispatch-new", attempt["orca_dispatch_id"])
        self.assertIsNone(attempt["orca_worktree_id"])

    def test_reused_task_id_stops_before_worker_start(self) -> None:
        config = self.config()
        ledger = self.ledger()
        ledger.enqueue(self.issue("I_kwDO-old", 9))
        old = ledger.claim_next()
        ledger.assign_orca(
            old["node_id"], old["attempt_number"], run_id=str(uuid.uuid4()), agent_id="codex",
            orca_task_id="task-reused", orca_dispatch_id="dispatch-old",
            orca_worktree_id="repo::/tmp/old", worktree_path="/tmp/old",
            branch="issue-9-attempt-1",
        )
        ledger.finish(old["node_id"], old["attempt_number"], "needs-human", summary="stopped")
        issue = self.issue()
        ledger.enqueue(issue)
        claimed = ledger.claim_next()
        eligible = dict(issue, author={"login": "owner"}, labels=[])
        with mock.patch.object(WATCHER, "github_login", return_value="owner"), mock.patch.object(
            WATCHER, "list_issues", return_value=[eligible]
        ), mock.patch.object(
            WATCHER, "create_orca_task", return_value="task-reused"
        ), mock.patch.object(WATCHER, "orca_call") as orca_call:
            result = WATCHER.dispatch_one(config, ledger, "run-1", claimed)

        self.assertEqual("needs-human", result["status"])
        self.assertIn("reused recorded orca_task_id", result["summary"])
        orca_call.assert_not_called()

    def test_incomplete_worker_receipt_stops_without_fallback_worktree(self) -> None:
        config = self.config()
        ledger = self.ledger()
        issue = self.issue()
        ledger.enqueue(issue)
        claimed = ledger.claim_next()
        eligible = dict(issue, author={"login": "owner"}, labels=[])
        with mock.patch.object(WATCHER, "github_login", return_value="owner"), mock.patch.object(
            WATCHER, "list_issues", return_value=[eligible]
        ), mock.patch.object(
            WATCHER, "create_orca_task", return_value="task-new"
        ), mock.patch.object(WATCHER, "orca_call", side_effect=[
            {"ok": True, "result": {"dispatch": {"id": "dispatch-new"}}},
            {"ok": True, "result": {}},
        ]) as orca_call, mock.patch.object(WATCHER, "create_blocked_worktree") as blocked:
            result = WATCHER.dispatch_one(config, ledger, "run-1", claimed)

        self.assertEqual("needs-human", result["status"])
        self.assertIn("omitted its worktree identity", result["summary"])
        self.assertFalse(blocked.called)
        self.assertEqual("worker-stop", orca_call.call_args_list[1].args[2])

    def test_same_attempt_cannot_replace_recorded_orca_identity(self) -> None:
        ledger = self.ledger()
        ledger.enqueue(self.issue())
        claimed = ledger.claim_next()
        identities = {
            "run_id": str(uuid.uuid4()), "agent_id": "codex", "orca_task_id": "task-1",
            "orca_dispatch_id": "dispatch-1", "orca_worktree_id": "repo::/tmp/issue-1",
            "worktree_path": "/tmp/issue-1", "branch": "issue-1-attempt-1",
        }
        ledger.assign_orca(claimed["node_id"], claimed["attempt_number"], **identities)
        with self.assertRaisesRegex(WATCHER.OrcaIdentityError, "replace recorded orca_dispatch_id"):
            ledger.assign_orca(
                claimed["node_id"], claimed["attempt_number"],
                **{**identities, "orca_dispatch_id": "dispatch-replacement"},
            )

    def test_prompt_requires_literal_receipt_prefix_with_one_line_example(self) -> None:
        prompt = WATCHER.prompt_for({
            "url": self.issue()["url"], "attempt_number": 2, "run_id": "run-6",
        }, self.config())
        self.assertIn("literal prefix `AUTOPILOT_RESULT: `", prompt)
        expected = ('AUTOPILOT_RESULT: {"status":"needs-human","summary":"explain why",'
                    '"run_id":"<assigned run ID>","worktree_path":"<absolute worktree path>",'
                    '"branch":"<assigned branch>"}')
        receipt_lines = [line for line in prompt.splitlines() if line.startswith("AUTOPILOT_RESULT")]
        self.assertEqual([expected], receipt_lines)
        self.assertEqual("needs-human", WATCHER.parse_receipt(receipt_lines[0])["status"])

    def test_parser_uses_last_valid_exact_receipt_line(self) -> None:
        output = "\n".join([
            'AUTOPILOT_RESULT: {"status":"blocked","summary":"older"}',
            'debug: AUTOPILOT_RESULT: {"status":"failed","summary":"ordinary log"}',
            'AUTOPILOT_RESULT: {"status":"needs-human","summary":"scope expanded"}',
            'AUTOPILOT_RESULT: {not-json}',
        ])
        self.assertEqual({"status": "needs-human", "summary": "scope expanded"},
                         WATCHER.parse_receipt(output))

    def test_unavailable_agent_still_creates_visible_blocked_worktree(self) -> None:
        config = self.config()
        config["orca"]["allowed_agents"] = ["codex"]
        ledger = self.ledger()
        issue = self.issue()
        ledger.enqueue(issue)
        claimed = ledger.claim_next()
        eligible = dict(issue, author={"login": "owner"}, labels=[{"name": "agent:claude"}])
        with mock.patch.object(WATCHER, "github_login", return_value="owner"), mock.patch.object(
            WATCHER, "list_issues", return_value=[eligible]
        ), mock.patch.object(
            WATCHER, "create_orca_task", return_value="task-1"
        ), mock.patch.object(WATCHER, "create_blocked_worktree", return_value={
            "id": "repo::/tmp/blocked", "path": "/tmp/blocked", "branch": "refs/heads/blocked"
        }):
            result = WATCHER.dispatch_one(config, ledger, "run-1", claimed)
        self.assertEqual("needs-human", result["status"])
        attempt = ledger.snapshot()["issues"][0]["attempt_history"][0]
        self.assertEqual("task-1", attempt["orca_task_id"])
        self.assertEqual("repo::/tmp/blocked", attempt["orca_worktree_id"])

    def test_dispatch_preflight_failure_does_not_leave_claim_stuck(self) -> None:
        config = self.config()
        ledger = self.ledger()
        ledger.enqueue(self.issue())
        claimed = ledger.claim_next()
        with mock.patch.object(WATCHER, "github_login", side_effect=WATCHER.WatcherError("request: EOF")), \
                mock.patch.object(WATCHER, "create_blocked_worktree", return_value={}):
            result = WATCHER.dispatch_one(config, ledger, "run-1", claimed)
        self.assertEqual("needs-human", result["status"])
        self.assertEqual("needs-human", ledger.snapshot()["issues"][0]["status"])

    def test_prompt_stall_preserves_real_orca_worker_without_duplicate(self) -> None:
        config = self.config()
        ledger = self.ledger()
        issue = self.issue()
        ledger.enqueue(issue)
        claimed = ledger.claim_next()
        worktree = self.root / "stalled-worker"
        subprocess.run(
            ["git", "-C", str(self.repo), "worktree", "add", "-b", "stalled-worker",
             str(worktree), "HEAD"], check=True, stdout=subprocess.PIPE,
        )
        response = {"result": {"dispatchId": "dispatch-stalled",
                                "lastError": "agent_prompt_stalled", "effects": [
            {"kind": "worktree", "id": f"repo::{worktree}"}
        ]}}
        eligible = dict(issue, author={"login": "owner"}, labels=[])
        with mock.patch.object(WATCHER, "github_login", return_value="owner"), mock.patch.object(
            WATCHER, "list_issues", return_value=[eligible]
        ), mock.patch.object(
            WATCHER, "create_orca_task", return_value="task-stalled"
        ), mock.patch.object(
            WATCHER, "orca_call", side_effect=WATCHER.OrcaCommandError("Orca command failed", response)
        ), mock.patch.object(WATCHER, "create_blocked_worktree") as blocked:
            result = WATCHER.dispatch_one(config, ledger, "run-1", claimed)
        self.assertEqual("running", result["status"])
        self.assertFalse(blocked.called)
        attempt = ledger.snapshot()["issues"][0]["attempt_history"][0]
        self.assertEqual("dispatch-stalled", attempt["orca_dispatch_id"])
        self.assertEqual(str(worktree), attempt["worktree_path"])

    def test_completed_orca_worker_requires_verified_receipt(self) -> None:
        config = self.config()
        ledger = self.ledger()
        ledger.enqueue(self.issue())
        claimed = ledger.claim_next()
        worktree = self.root / "orca-worktree"
        branch = "issue-1-attempt-1"
        subprocess.run(
            ["git", "-C", str(self.repo), "worktree", "add", "-b", branch, str(worktree), "HEAD"],
            check=True, stdout=subprocess.PIPE,
        )
        sha = subprocess.run(["git", "-C", str(worktree), "rev-parse", "HEAD"], check=True,
                             text=True, stdout=subprocess.PIPE).stdout.strip()
        evidence = self.repair_evidence(worktree, branch, sha, sha)
        ledger.assign_orca(
            claimed["node_id"], claimed["attempt_number"], run_id=evidence["run_id"], agent_id="codex",
            orca_task_id="task-1", orca_dispatch_id="dispatch-1", orca_worktree_id="repo::worktree",
            worktree_path=str(worktree), branch=branch,
        )
        receipt = "AUTOPILOT_RESULT: " + json.dumps({
            "status": "ready-for-review", "summary": "verified", **evidence,
        })
        with mock.patch.object(WATCHER, "orca_call", side_effect=[
            {"ok": True, "result": {"dispatch": {"status": "completed", "outcome": "succeeded"}}},
            {"ok": True, "result": {"rows": [{"text": receipt}]}},
            {"ok": True, "result": {}},
            {"ok": True, "result": {}},
        ]):
            completed = WATCHER.reconcile_workers(config, ledger)
        self.assertEqual("ready-for-review", completed[0]["status"], completed)
        self.assertEqual("ready-for-review", ledger.snapshot()["issues"][0]["status"])

    def test_completed_worker_with_invalid_receipt_is_retryable_failure(self) -> None:
        completed, attempt = self.reconcile_invalid_output(
            'AUTOPILOT_RESULT {"status":"needs-human","summary":"scope expanded"}',
            {"result": {"dispatch": {"status": "completed", "outcome": "succeeded"}}},
        )
        self.assertEqual("failed", completed["status"])
        self.assertIn("missing required colon", completed["summary"])
        self.assertEqual("failed", attempt["status"])
        self.assertIn("missing required colon", attempt["summary"])

    def test_stalled_worker_with_invalid_json_receipt_is_retryable_failure(self) -> None:
        completed, attempt = self.reconcile_invalid_output(
            "AUTOPILOT_RESULT: {not-json}",
            {"result": {"dispatch": {"status": "failed", "lastError": "agent_prompt_stalled"}}},
        )
        self.assertEqual("failed", completed["status"])
        self.assertIn("invalid JSON", completed["summary"])
        self.assertEqual("failed", attempt["status"])
        self.assertIn("invalid JSON", attempt["summary"])

    def test_load_config_accepts_config_without_activation_cutoff(self) -> None:
        path = self.root / "config.json"
        path.write_text(json.dumps({
            "schema_version": 2,
            "state_db": str(self.db),
            "policy": {"scope_approval": "eligible-issue", "publication": "never"},
            "repositories": [{"repository": "owner/repo", "repo_path": str(self.repo), "author": "@me"}],
            "orca": {"cli": sys.executable, "default_agent": "codex", "allowed_agents": ["codex"]},
            "lease_timeout_seconds": 20,
        }), encoding="utf-8")
        loaded = WATCHER.load_config(path)
        self.assertNotIn("activate_after", loaded["repositories"][0])

    def test_load_config_requires_positive_automatic_attempt_limit(self) -> None:
        config = self.config()
        config["max_attempts"] = 0
        config["state_db"] = str(config["state_db"])
        config["repositories"][0]["repo_path"] = str(self.repo)
        path = self.root / "config.json"
        path.write_text(json.dumps(config), encoding="utf-8")

        with self.assertRaisesRegex(WATCHER.WatcherError, "max_attempts must be positive"):
            WATCHER.load_config(path)

    def doctor_with_orca_cli(self, executable: str) -> dict:
        config = self.config()
        config["orca"]["cli"] = executable
        config["repositories"][0]["repo_path"] = self.repo.resolve()
        healthy = subprocess.CompletedProcess([], 0, str(self.repo.resolve()), "")
        with mock.patch.object(WATCHER.shutil, "which", return_value="/usr/bin/gh"), mock.patch.object(
            WATCHER, "command", return_value=healthy
        ), mock.patch.object(WATCHER, "repository_metadata"), mock.patch.object(
            WATCHER, "orca_call", return_value={"result": {"runtime": {"state": "ready"}}}
        ):
            return WATCHER.doctor(config)

    def test_doctor_accepts_executable_absolute_orca_cli(self) -> None:
        executable = self.root / "orca"
        executable.write_text("#!/bin/sh\n", encoding="utf-8")
        executable.chmod(0o700)
        result = self.doctor_with_orca_cli(str(executable))
        self.assertTrue(result["orca"])
        self.assertTrue(result["ok"])

    def test_doctor_rejects_non_executable_absolute_orca_cli(self) -> None:
        executable = self.root / "orca"
        executable.write_text("#!/bin/sh\n", encoding="utf-8")
        executable.chmod(0o600)
        result = self.doctor_with_orca_cli(str(executable))
        self.assertFalse(result["orca"])
        self.assertFalse(result["ok"])

    def test_doctor_rejects_missing_absolute_orca_cli(self) -> None:
        result = self.doctor_with_orca_cli(str(self.root / "missing-orca"))
        self.assertFalse(result["orca"])
        self.assertFalse(result["ok"])

    def test_success_receipt_must_resolve_to_registered_repair_worktree(self) -> None:
        worktree = self.root / "repair-worktree"
        subprocess.run(
            ["git", "-C", str(self.repo), "worktree", "add", "-b", "repair/issue-1-attempt-1",
             str(worktree), "HEAD"], check=True, stdout=subprocess.PIPE,
        )
        sha = subprocess.run(
            ["git", "-C", str(worktree), "rev-parse", "HEAD"], check=True, text=True,
            stdout=subprocess.PIPE,
        ).stdout.strip()
        evidence = self.repair_evidence(worktree, "repair/issue-1-attempt-1", sha, sha)
        WATCHER.validate_attempt(self.repo, evidence)
        invalid = dict(evidence, branch="main")
        with self.assertRaisesRegex(WATCHER.WatcherError, "repair worktree"):
            WATCHER.validate_attempt(self.repo, invalid)

    def test_receipt_identity_must_match_coordinator_assignment(self) -> None:
        repository = {"repo_path": self.repo}
        run = {"run_id": "assigned", "worktree_path": "/assigned", "branch": "repair/assigned"}
        receipt = {"status": "ready-for-review", "summary": "done", "run_id": "other",
                   "worktree_path": "/assigned", "branch": "repair/assigned",
                   "base_sha": "base", "head_sha": "head"}
        status, summary, evidence = WATCHER.verified_receipt(receipt, repository, run)
        self.assertEqual("needs-human", status)
        self.assertIn("coordinator-assigned", summary)
        self.assertEqual({}, evidence)

    def test_explicit_discard_rejects_old_attempt_and_creates_new_number(self) -> None:
        ledger = self.ledger()
        ledger.enqueue(self.issue())
        claimed = ledger.claim_next()
        worktree = self.root / "discard-me"
        branch = "repair/issue-1-attempt-1"
        subprocess.run(
            ["git", "-C", str(self.repo), "worktree", "add", "-b", branch, str(worktree), "HEAD"],
            check=True, stdout=subprocess.PIPE,
        )
        sha = subprocess.run(
            ["git", "-C", str(worktree), "rev-parse", "HEAD"], check=True, text=True,
            stdout=subprocess.PIPE,
        ).stdout.strip()
        evidence = self.repair_evidence(worktree, branch, sha, sha)
        ledger.assign_orca(
            claimed["node_id"], claimed["attempt_number"], run_id=evidence["run_id"], agent_id="codex",
            orca_task_id="task-1", orca_dispatch_id="dispatch-1",
            orca_worktree_id=f"repo::{worktree}", worktree_path=str(worktree), branch=branch,
        )
        ledger.finish(claimed["node_id"], claimed["attempt_number"], "ready-for-review",
                      summary="review me", **evidence)
        self.assertEqual(2, ledger.retry(self.issue()["url"], self.repo, True))
        self.assertFalse(worktree.exists())
        retried = ledger.claim_next()
        self.assertEqual(2, retried["attempt_number"])
        with self.assertRaisesRegex(WATCHER.OrcaIdentityError, "orca_worktree_id"):
            ledger.assign_orca(
                retried["node_id"], retried["attempt_number"], run_id=str(uuid.uuid4()),
                agent_id="codex", orca_task_id="task-2", orca_dispatch_id="dispatch-2",
                orca_worktree_id=f"repo::{worktree}", worktree_path=str(self.root / "attempt-2"),
                branch="issue-1-attempt-2",
            )
        ledger.assign_orca(
            retried["node_id"], retried["attempt_number"], run_id=str(uuid.uuid4()), agent_id="codex",
            orca_task_id="task-2", orca_dispatch_id="dispatch-2",
            orca_worktree_id=f"repo::{self.root / 'attempt-2'}",
            worktree_path=str(self.root / "attempt-2"), branch="issue-1-attempt-2",
        )
        history = ledger.snapshot()["issues"][0]["attempt_history"]
        self.assertEqual("rejected", history[0]["status"])
        self.assertNotEqual(history[0]["orca_worktree_id"], history[1]["orca_worktree_id"])

    def test_discard_refuses_receipt_branch_that_does_not_match_worktree(self) -> None:
        ledger = self.ledger()
        ledger.enqueue(self.issue())
        claimed = ledger.claim_next()
        worktree = self.root / "keep-me"
        branch = "repair/actual"
        subprocess.run(
            ["git", "-C", str(self.repo), "worktree", "add", "-b", branch, str(worktree), "HEAD"],
            check=True, stdout=subprocess.PIPE,
        )
        sha = subprocess.run(
            ["git", "-C", str(worktree), "rev-parse", "HEAD"], check=True, text=True,
            stdout=subprocess.PIPE,
        ).stdout.strip()
        evidence = self.repair_evidence(worktree, "repair/not-actual", sha, sha)
        ledger.finish(claimed["node_id"], claimed["attempt_number"], "needs-human",
                      summary="bad receipt", **evidence)
        with self.assertRaisesRegex(WATCHER.WatcherError, "do not match"):
            ledger.retry(self.issue()["url"], self.repo, True)
        self.assertTrue(worktree.exists())

    def test_explicit_accept_closes_issue_and_retries_after_close_failure(self) -> None:
        ledger = self.ledger()
        ledger.enqueue(self.issue())
        claimed = ledger.claim_next()
        base = subprocess.run(
            ["git", "-C", str(self.repo), "rev-parse", "HEAD"], check=True, text=True,
            stdout=subprocess.PIPE,
        ).stdout.strip()
        worktree = self.root / "accept-me"
        branch = "repair/issue-1-attempt-1"
        subprocess.run(
            ["git", "-C", str(self.repo), "worktree", "add", "-b", branch, str(worktree), "HEAD"],
            check=True, stdout=subprocess.PIPE,
        )
        change = worktree / "fixed.txt"
        change.write_text("fixed\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(worktree), "add", "fixed.txt"], check=True)
        subprocess.run(["git", "-C", str(worktree), "commit", "-m", "fix"], check=True,
                       stdout=subprocess.PIPE)
        head = subprocess.run(
            ["git", "-C", str(worktree), "rev-parse", "HEAD"], check=True, text=True,
            stdout=subprocess.PIPE,
        ).stdout.strip()
        evidence = self.repair_evidence(worktree, branch, base, head)
        ledger.finish(claimed["node_id"], claimed["attempt_number"], "ready-for-review",
                      summary="review me", **evidence)
        with mock.patch.object(
            WATCHER, "close_github_issue",
            side_effect=[WATCHER.WatcherError("close failed"), None],
        ) as close_issue:
            with self.assertRaisesRegex(WATCHER.WatcherError, "close failed"):
                ledger.accept(self.issue()["url"], self.repo, "main")
            self.assertTrue(worktree.exists())
            self.assertEqual("ready-for-review", ledger.snapshot()["issues"][0]["status"])
            result = ledger.accept(self.issue()["url"], self.repo, "main")
        self.assertEqual("accepted", result["status"])
        self.assertEqual("closed", result["issue"])
        self.assertEqual(2, close_issue.call_count)
        close_issue.assert_called_with(self.issue()["url"])
        self.assertTrue((self.repo / "fixed.txt").is_file())
        self.assertFalse(worktree.exists())
        self.assertEqual("accepted", ledger.snapshot()["issues"][0]["status"])

    def test_accept_recovers_when_recorded_head_was_already_merged(self) -> None:
        ledger = self.ledger()
        ledger.enqueue(self.issue())
        claimed = ledger.claim_next()
        base = subprocess.run(
            ["git", "-C", str(self.repo), "rev-parse", "HEAD"], check=True, text=True,
            stdout=subprocess.PIPE,
        ).stdout.strip()
        worktree = self.root / "merged-before-accept"
        branch = "repair/issue-1-attempt-1"
        subprocess.run(
            ["git", "-C", str(self.repo), "worktree", "add", "-b", branch, str(worktree), "HEAD"],
            check=True, stdout=subprocess.PIPE,
        )
        (worktree / "fixed.txt").write_text("fixed\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(worktree), "add", "fixed.txt"], check=True)
        subprocess.run(["git", "-C", str(worktree), "commit", "-m", "fix"], check=True,
                       stdout=subprocess.PIPE)
        head = subprocess.run(
            ["git", "-C", str(worktree), "rev-parse", "HEAD"], check=True, text=True,
            stdout=subprocess.PIPE,
        ).stdout.strip()
        evidence = self.repair_evidence(worktree, branch, base, head)
        ledger.finish(claimed["node_id"], claimed["attempt_number"], "ready-for-review",
                      summary="already merged", **evidence)
        subprocess.run(["git", "-C", str(self.repo), "merge", "--no-ff", "--no-edit", head],
                       check=True, stdout=subprocess.PIPE)
        subprocess.run(["git", "-C", str(self.repo), "worktree", "remove", str(worktree)],
                       check=True, stdout=subprocess.PIPE)

        with mock.patch.object(WATCHER, "close_github_issue") as close_issue:
            result = ledger.accept(self.issue()["url"], self.repo, "main")

        self.assertEqual("accepted", result["status"])
        self.assertEqual("closed", result["issue"])
        self.assertIn("cleanup_warning", result)
        close_issue.assert_called_once_with(self.issue()["url"])
        self.assertEqual("accepted", ledger.snapshot()["issues"][0]["status"])

    def test_parse_issue_dependencies_supports_english_chinese_and_urls(self) -> None:
        body = (
            "## 参考信息\n"
            "- Blocked by: #12, #4\n"
            "- **Depends on**: https://github.com/owner/repo/issues/7\n"
            "- 前置依赖：#4, #9\n"
            "- Blocked by: https://github.com/other/repo/issues/99\n"
        )
        deps = WATCHER.parse_issue_dependencies(body, "owner/repo")
        self.assertEqual([4, 7, 9, 12], deps)

    def test_claim_many_blocks_dependent_issue_until_dependency_accepted_or_closed(self) -> None:
        ledger = self.ledger()
        issue1 = self.issue("I_1", 1)
        issue2 = {**self.issue("I_2", 2), "body": "Blocked by: #1"}
        issue3 = {**self.issue("I_3", 3), "body": "Depends on: #99"}
        issue4 = self.issue("I_4", 4)
        for item in (issue1, issue2, issue3, issue4):
            ledger.enqueue(item)

        first_batch = ledger.claim_many(3, is_dependency_satisfied=lambda repo, num: False)
        self.assertEqual([1, 4], [item["issue_number"] for item in first_batch])

        snapshot = ledger.snapshot()
        self.assertEqual(2, snapshot["summary"]["waiting_on_dependencies"])
        by_num = {item["issue_number"]: item for item in snapshot["issues"]}
        self.assertEqual([1], by_num[2]["waiting_on"])
        self.assertEqual([99], by_num[3]["waiting_on"])

        # Once external #99 is closed, #3 can be claimed even while #1 is still running.
        second_batch = ledger.claim_many(3, is_dependency_satisfied=lambda repo, num: num == 99)
        self.assertEqual([3], [item["issue_number"] for item in second_batch])

        # Mark #1 accepted directly in ledger to simulate local merge & closure.
        ledger.connection.execute("UPDATE issues SET status='accepted' WHERE node_id='I_1'")
        third_batch = ledger.claim_many(3, is_dependency_satisfied=lambda repo, num: False)
        self.assertEqual([2], [item["issue_number"] for item in third_batch])

    def test_claim_many_detects_dependency_cycle_and_blocks_issue(self) -> None:
        ledger = self.ledger()
        ledger.enqueue({**self.issue("I_1", 1), "body": "Blocked by: #2"})
        ledger.enqueue({**self.issue("I_2", 2), "body": "Blocked by: #1"})

        claimed = ledger.claim_many(3)
        self.assertEqual([], claimed)
        by_num = {item["issue_number"]: item for item in ledger.snapshot()["issues"]}
        self.assertEqual("blocked", by_num[1]["status"])
        self.assertEqual("blocked", by_num[2]["status"])
        self.assertIn("dependency cycle", by_num[1]["summary"])

    def test_reconcile_refreshes_heartbeat_on_new_output_and_stops_stalled_worker(self) -> None:
        config = self.config()
        config["worker_timeout_seconds"] = 2700
        config["heartbeat_timeout_seconds"] = 600
        ledger = self.ledger(attempts=2)
        ledger.enqueue(self.issue())
        t0 = dt.datetime(2026, 8, 27, 1, 0, 0, tzinfo=dt.timezone.utc)
        claimed = ledger.claim_next(at=t0)
        ledger.assign_orca(
            claimed["node_id"], claimed["attempt_number"], run_id=str(uuid.uuid4()), agent_id="codex",
            orca_task_id="task-1", orca_dispatch_id="dispatch-1",
            orca_worktree_id=f"repo::{self.root / 'wt-1'}",
            worktree_path=str(self.root / "wt-1"), branch="owner/issue-1-attempt-1",
            last_heartbeat=WATCHER.iso(t0),
        )

        # At t0 + 500s, new output arrives -> heartbeat refreshes, worker stays running.
        t1 = t0 + dt.timedelta(seconds=500)
        with mock.patch.object(WATCHER, "orca_call", side_effect=[
            {"ok": True, "result": {"status": "running"}},
            {"ok": True, "result": {"rows": [{"text": "running tests..."}]}},
        ]):
            completed = WATCHER.reconcile_workers(config, ledger, at=t1)
        self.assertEqual([], completed)
        attempt = ledger.snapshot()["issues"][0]["attempt_history"][0]
        self.assertEqual(WATCHER.iso(t1), attempt["last_heartbeat"])

        # At t1 + 650s, same output -> heartbeat stalled -> worker stopped & marked failed (retryable).
        t2 = t1 + dt.timedelta(seconds=650)
        with mock.patch.object(WATCHER, "orca_call", side_effect=[
            {"ok": True, "result": {"status": "running"}},
            {"ok": True, "result": {"rows": [{"text": "running tests..."}]}},
            {"ok": True, "result": {}},  # worker-stop
            {"ok": True, "result": {}},  # worktree set
            {"ok": True, "result": {}},  # worker-release
        ]) as call:
            completed = WATCHER.reconcile_workers(config, ledger, at=t2)
        self.assertEqual(1, len(completed))
        self.assertEqual("failed", completed[0]["status"])
        self.assertIn("heartbeat stalled", completed[0]["summary"])
        self.assertIn(mock.call(config, "orchestration", "worker-stop", "--dispatch", "dispatch-1"),
                      call.call_args_list)

    def test_reconcile_stops_worker_exceeding_hard_timeout_and_exports_patch(self) -> None:
        config = self.config()
        config["worker_timeout_seconds"] = 1000
        config["heartbeat_timeout_seconds"] = 900
        config["max_attempts"] = 1
        ledger = self.ledger(attempts=1)
        ledger.enqueue(self.issue())
        t0 = dt.datetime(2026, 8, 27, 1, 0, 0, tzinfo=dt.timezone.utc)
        claimed = ledger.claim_next(at=t0)
        worktree = self.root / "wt-timeout"
        branch = "repair/issue-1-attempt-1"
        subprocess.run(
            ["git", "-C", str(self.repo), "worktree", "add", "-b", branch, str(worktree), "HEAD"],
            check=True, stdout=subprocess.PIPE,
        )
        (worktree / "partial.txt").write_text("wip\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(worktree), "add", "partial.txt"], check=True)
        ledger.assign_orca(
            claimed["node_id"], claimed["attempt_number"], run_id=str(uuid.uuid4()), agent_id="codex",
            orca_task_id="task-1", orca_dispatch_id="dispatch-1",
            orca_worktree_id=f"repo::{worktree}",
            worktree_path=str(worktree), branch=branch,
            last_heartbeat=WATCHER.iso(t0),
        )

        t_late = t0 + dt.timedelta(seconds=1200)
        with mock.patch.object(WATCHER, "orca_call", side_effect=[
            {"ok": True, "result": {"status": "running"}},
            {"ok": True, "result": {"rows": [{"text": "still printing"}]}},
            {"ok": True, "result": {}},  # worker-stop
            {"ok": True, "result": {}},  # worktree set
            {"ok": True, "result": {}},  # worker-release
        ]):
            completed = WATCHER.reconcile_workers(config, ledger, at=t_late)
        self.assertEqual(1, len(completed))
        self.assertEqual("needs-human", completed[0]["status"])
        self.assertIn("hard timeout", completed[0]["summary"])
        patch_path = Path(completed[0]["failure_patch_path"])
        self.assertTrue(patch_path.is_file())
        self.assertIn("partial.txt", patch_path.read_text(encoding="utf-8"))

    def test_prune_cleans_old_failed_worktrees_after_exporting_patch(self) -> None:
        ledger = self.ledger()
        t0 = dt.datetime(2026, 8, 25, 0, 0, 0, tzinfo=dt.timezone.utc)
        ledger.enqueue(self.issue("I_1", 1))
        claimed = ledger.claim_next(at=t0)
        worktree = self.root / "wt-old-failed"
        branch = "repair/issue-1-attempt-1"
        subprocess.run(
            ["git", "-C", str(self.repo), "worktree", "add", "-b", branch, str(worktree), "HEAD"],
            check=True, stdout=subprocess.PIPE,
        )
        (worktree / "leftover.txt").write_text("broken\n", encoding="utf-8")
        ledger.finish(
            claimed["node_id"], claimed["attempt_number"], "failed",
            run_id=str(uuid.uuid4()), worktree_path=str(worktree), branch=branch,
            summary="failed attempt",
        )

        # Dry run lists candidate without deleting.
        now_time = t0 + dt.timedelta(hours=30)
        dry = ledger.prune(self.repo, older_than_hours=24.0, dry_run=True, at=now_time)
        self.assertEqual("dry-run", dry["status"])
        self.assertEqual(1, len(dry["candidates"]))
        self.assertEqual(0, len(dry["pruned"]))
        self.assertTrue(worktree.exists())

        # Real prune exports patch and removes worktree.
        done = ledger.prune(self.repo, older_than_hours=24.0, dry_run=False, at=now_time)
        self.assertEqual("pruned", done["status"])
        self.assertEqual(1, len(done["pruned"]))
        self.assertFalse(worktree.exists())
        patch_path = Path(done["pruned"][0]["failure_patch_path"])
        self.assertTrue(patch_path.is_file())
        self.assertIn("leftover.txt", patch_path.read_text(encoding="utf-8"))

    def test_ledger_migrates_v3_database_to_v4(self) -> None:
        import sqlite3
        conn = sqlite3.connect(self.db)
        conn.executescript(
            """
            CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO metadata VALUES ('schema_version', '3');
            CREATE TABLE issues (
              node_id TEXT PRIMARY KEY, repository TEXT NOT NULL, issue_number INTEGER NOT NULL,
              url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, created_at TEXT NOT NULL,
              issue_updated_at TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
              lease_started_at TEXT, lease_owner TEXT, pid INTEGER, summary TEXT,
              returncode INTEGER, log_path TEXT
            );
            CREATE TABLE events (
              id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL, at TEXT NOT NULL,
              kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}'
            );
            CREATE TABLE attempts (
              node_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, status TEXT NOT NULL,
              lease_started_at TEXT, lease_owner TEXT, pid INTEGER, run_id TEXT,
              worktree_path TEXT, branch TEXT, base_sha TEXT, head_sha TEXT, summary TEXT,
              returncode INTEGER, log_path TEXT, agent_id TEXT, orca_task_id TEXT,
              orca_dispatch_id TEXT, orca_worktree_id TEXT, PRIMARY KEY(node_id, attempt_number)
            );
            """
        )
        conn.close()
        ledger = self.ledger()
        self.assertEqual("5", ledger.metadata("schema_version"))
        issue_cols = {row[1] for row in ledger.connection.execute("PRAGMA table_info(issues)")}
        attempt_cols = {row[1] for row in ledger.connection.execute("PRAGMA table_info(attempts)")}
        self.assertIn("depends_on", issue_cols)
        self.assertTrue(
            {"last_heartbeat", "output_digest", "failure_patch_path", "pr_number", "pr_url", "merged_at"}
            .issubset(attempt_cols)
        )

    def test_auto_merge_publishes_pr_waits_for_ci_merges_and_unblocks_dependent_issue(self) -> None:
        config = self.config()
        config["policy"]["publication"] = "auto-merge"
        config["policy"]["merge_method"] = "squash"
        config["policy"]["require_ci"] = True
        ledger = self.ledger()

        issue1 = self.issue("I_1", 1)
        issue2 = {**self.issue("I_2", 2), "body": "Blocked by: #1"}
        ledger.enqueue(issue1)
        ledger.enqueue(issue2)
        claimed = ledger.claim_many(3)
        self.assertEqual([1], [item["issue_number"] for item in claimed])

        base = subprocess.run(
            ["git", "-C", str(self.repo), "rev-parse", "HEAD"], check=True, text=True,
            stdout=subprocess.PIPE,
        ).stdout.strip()
        worktree = self.root / "wt-pr-1"
        branch = "repair/issue-1-attempt-1"
        subprocess.run(
            ["git", "-C", str(self.repo), "worktree", "add", "-b", branch, str(worktree), "HEAD"],
            check=True, stdout=subprocess.PIPE,
        )
        (worktree / "ok.txt").write_text("done\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(worktree), "add", "ok.txt"], check=True)
        subprocess.run(["git", "-C", str(worktree), "commit", "-m", "fix #1"], check=True, stdout=subprocess.PIPE)
        head = subprocess.run(
            ["git", "-C", str(worktree), "rev-parse", "HEAD"], check=True, text=True,
            stdout=subprocess.PIPE,
        ).stdout.strip()
        evidence = self.repair_evidence(worktree, branch, base, head)
        ledger.assign_orca(
            claimed[0]["node_id"], claimed[0]["attempt_number"],
            run_id=evidence["run_id"], agent_id="codex",
            orca_task_id="task-1", orca_dispatch_id="dispatch-1",
            orca_worktree_id=f"repo::{worktree}", worktree_path=str(worktree), branch=branch,
        )
        receipt = json.dumps({"status": "ready-for-review", "summary": "all tests green", **evidence})
        with mock.patch.object(WATCHER, "orca_call", side_effect=[
            {"ok": True, "result": {"status": "completed"}},
            {"ok": True, "result": {"rows": [{"text": f"AUTOPILOT_RESULT: {receipt}"}]}},
            {"ok": True, "result": {}},  # worktree set
            {"ok": True, "result": {}},  # worker-release
        ]), mock.patch.object(
            WATCHER, "publish_attempt_pr",
            return_value={"pr_number": 42, "pr_url": "https://github.com/owner/repo/pull/42"},
        ) as pub:
            completed = WATCHER.reconcile_workers(config, ledger)
        pub.assert_called_once()
        self.assertEqual("pr-open", completed[0]["status"])
        self.assertEqual("https://github.com/owner/repo/pull/42", completed[0]["pr_url"])
        # While PR is open, #2 is still blocked.
        self.assertEqual([], ledger.claim_many(3))

        # CI pending -> stays pr-open.
        with mock.patch.object(WATCHER, "github_pr_view", return_value={
            "number": 42, "url": "https://github.com/owner/repo/pull/42",
            "state": "OPEN", "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
            "statusCheckRollup": [{"name": "test", "status": "IN_PROGRESS", "conclusion": ""}],
        }):
            self.assertEqual([], WATCHER.reconcile_pull_requests(config, ledger))
        self.assertEqual("pr-open", ledger.snapshot()["issues"][0]["status"])

        # CI green -> auto-merges PR, closes Issue, cleans worktree, and unblocks #2.
        with mock.patch.object(WATCHER, "github_pr_view", return_value={
            "number": 42, "url": "https://github.com/owner/repo/pull/42",
            "state": "OPEN", "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
            "statusCheckRollup": [{"name": "test", "status": "COMPLETED", "conclusion": "SUCCESS"}],
        }), mock.patch.object(WATCHER, "merge_github_pr") as merge_pr, mock.patch.object(
            WATCHER, "close_github_issue"
        ) as close_issue, mock.patch.object(WATCHER, "cleanup_attempt") as cleanup, mock.patch.object(
            WATCHER, "command", return_value=subprocess.CompletedProcess([], 0, "", "")
        ):
            merged = WATCHER.reconcile_pull_requests(config, ledger)
        self.assertEqual("merged", merged[0]["status"])
        merge_pr.assert_called_once_with("https://github.com/owner/repo/pull/42", "squash")
        close_issue.assert_called_once_with(issue1["url"])
        cleanup.assert_called_once()
        self.assertEqual("merged", ledger.snapshot()["issues"][0]["status"])

        # Now #2 is unblocked and immediately claimable.
        next_batch = ledger.claim_many(3)
        self.assertEqual([2], [item["issue_number"] for item in next_batch])

    def test_pr_reconcile_stops_at_needs_human_on_ci_failure_or_conflict(self) -> None:
        config = self.config()
        config["policy"]["publication"] = "auto-merge"
        for case, pr_payload, expected_text in [
            ("ci_fail", {
                "number": 10, "url": "https://github.com/owner/repo/pull/10",
                "state": "OPEN", "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
                "statusCheckRollup": [{"name": "pytest", "status": "COMPLETED", "conclusion": "FAILURE"}],
            }, "CI checks failed: pytest"),
            ("conflict", {
                "number": 11, "url": "https://github.com/owner/repo/pull/11",
                "state": "OPEN", "mergeable": "CONFLICTING", "mergeStateStatus": "DIRTY",
                "statusCheckRollup": [],
            }, "merge conflicts"),
        ]:
            with self.subTest(case=case):
                db = self.root / f"{case}.sqlite3"
                ledger = WATCHER.Ledger(db, lease_seconds=20, max_attempts=2)
                ledger.enqueue(self.issue("I_1", 1))
                claimed = ledger.claim_next()
                ledger.finish(
                    claimed["node_id"], claimed["attempt_number"], "pr-open",
                    pr_number=pr_payload["number"], pr_url=pr_payload["url"],
                    summary="PR opened",
                )
                with mock.patch.object(WATCHER, "github_pr_view", return_value=pr_payload):
                    updated = WATCHER.reconcile_pull_requests(config, ledger)
                self.assertEqual(1, len(updated))
                self.assertEqual("needs-human", updated[0]["status"])
                self.assertIn(expected_text, updated[0]["summary"])


if __name__ == "__main__":
    unittest.main()
