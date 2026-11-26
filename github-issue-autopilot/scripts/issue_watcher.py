#!/usr/bin/env python3
"""Poll GitHub Issues and dispatch visible, supervised Orca worktrees."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Callable

CONFIG_VERSIONS = {2, 3}
LEDGER_VERSION = 5
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
ANSI_ESCAPE = re.compile(r"\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))")
RECEIPT = re.compile(r"(?m)^[ \t]*AUTOPILOT_RESULT: (\{[^\r\n]+\})[ \t]*$")
RECEIPT_START = re.compile(r"^[ \t]*AUTOPILOT_RESULT: (\{.*)$")
DEPENDENCY_LINE = re.compile(
    r"(?im)^\s*(?:[-*]\s*)?(?:\*\*)?(?:blocked[\s_-]*by|depends[\s_-]*on|前置依赖|依赖|阻塞于)(?:\*\*)?\s*[:：]\s*(.+)$"
)
ISSUE_REF = re.compile(r"(?:#|https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/)(\d+)\b")
CHILD_STATES = {"succeeded", "ready-for-review", "needs-human", "blocked", "failed"}
STOPPED_STATES = {"ready-for-review", "pr-open", "merged", "needs-human", "blocked", "failed", "discarded"}
RESOLVED_DEPENDENCY_STATES = {"accepted", "merged"}
PRUNABLE_ATTEMPT_STATES = {"failed", "discarded", "rejected"}
PROTECTED_ISSUE_STATES = {"claimed", "running", "ready-for-review", "pr-open", "needs-human"}
PUBLICATION_MODES = {"auto-merge", "pr-only", "never"}
MERGE_METHODS = {"squash", "merge", "rebase"}
CI_FAILURE_CONCLUSIONS = {
    "FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE",
}
CI_PENDING_STATES = {"PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "EXPECTED", "REQUESTED"}


class WatcherError(RuntimeError):
    pass


class OrcaIdentityError(WatcherError):
    pass


class OrcaEvidenceError(WatcherError):
    pass


class OrcaCommandError(WatcherError):
    def __init__(self, message: str, response: dict[str, Any]) -> None:
        super().__init__(message)
        self.response = response


def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(value: dt.datetime | None = None) -> str:
    return (value or now()).replace(microsecond=0).isoformat()


def parse_time(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise WatcherError(f"timestamp must include a timezone: {value}")
    return parsed.astimezone(dt.timezone.utc)


def load_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise WatcherError(f"file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise WatcherError(f"invalid JSON in {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise WatcherError(f"expected a JSON object: {path}")
    return value


def expand_path(value: str, base: Path) -> Path:
    path = Path(os.path.expandvars(os.path.expanduser(value)))
    return (path if path.is_absolute() else base / path).resolve()


def load_config(path: Path) -> dict[str, Any]:
    config = load_object(path)
    if config.get("schema_version") not in CONFIG_VERSIONS:
        raise WatcherError("config schema_version must be 2 or 3")
    base = path.resolve().parent
    config["state_db"] = expand_path(str(config.get("state_db", "autopilot.sqlite3")), base)
    repositories = config.get("repositories")
    if not isinstance(repositories, list) or not repositories:
        raise WatcherError("repositories must be a non-empty array")
    for item in repositories:
        if not isinstance(item, dict) or not REPOSITORY.fullmatch(str(item.get("repository", ""))):
            raise WatcherError("every repository must use owner/name")
        if not isinstance(item.get("author"), str) or not item["author"].strip():
            raise WatcherError(f"{item.get('repository')}: author is required")
        if "activate_after" in item:
            item["activate_after"] = parse_time(str(item["activate_after"]))
        item["repo_path"] = expand_path(str(item.get("repo_path", "")), base)
        if not item["repo_path"].is_dir():
            raise WatcherError(f"repo_path is not a directory: {item['repo_path']}")
        labels = item.get("labels", [])
        if not isinstance(labels, list) or any(not isinstance(label, str) or not label for label in labels):
            raise WatcherError(f"{item['repository']}: labels must be strings")
        try:
            config["state_db"].relative_to(item["repo_path"])
        except ValueError:
            pass
        else:
            raise WatcherError("state_db must be outside every managed repository")
    orca = config.get("orca")
    if not isinstance(orca, dict) or not isinstance(orca.get("cli"), str) or not orca["cli"]:
        raise WatcherError("orca.cli is required")
    default_agent = orca.get("default_agent")
    allowed_agents = orca.get("allowed_agents")
    if not isinstance(default_agent, str) or not default_agent:
        raise WatcherError("orca.default_agent is required")
    if (not isinstance(allowed_agents, list) or not allowed_agents
            or any(not isinstance(agent, str) or not agent for agent in allowed_agents)):
        raise WatcherError("orca.allowed_agents must be a non-empty string array")
    if default_agent not in allowed_agents:
        raise WatcherError("orca.default_agent must be included in orca.allowed_agents")
    orca["setup"] = orca.get("setup", "run")
    if orca["setup"] not in {"run", "skip", "inherit"}:
        raise WatcherError("orca.setup must be run, skip, or inherit")
    lease = int(config.get("lease_timeout_seconds", 3000))
    if lease < 1:
        raise WatcherError("lease_timeout_seconds must be positive")
    config["lease_timeout_seconds"] = lease
    worker_timeout = int(config.get("worker_timeout_seconds", 2700))
    if worker_timeout < 1:
        raise WatcherError("worker_timeout_seconds must be positive")
    config["worker_timeout_seconds"] = worker_timeout
    heartbeat_timeout = int(config.get("heartbeat_timeout_seconds", 900))
    if heartbeat_timeout < 0:
        raise WatcherError("heartbeat_timeout_seconds must be non-negative")
    config["heartbeat_timeout_seconds"] = heartbeat_timeout
    config["poll_interval_seconds"] = max(1, int(config.get("poll_interval_seconds", 180)))
    config["max_attempts"] = int(config.get("max_attempts", 2))
    if config["max_attempts"] < 1:
        raise WatcherError("max_attempts must be positive")
    config["max_concurrent_workers"] = max(1, min(3, int(config.get("max_concurrent_workers", 3))))
    policy = config.get("policy", {})
    if policy.get("scope_approval") != "eligible-issue":
        raise WatcherError("policy.scope_approval must be eligible-issue")
    publication = policy.get("publication", "auto-merge")
    if publication not in PUBLICATION_MODES:
        raise WatcherError("policy.publication must be auto-merge, pr-only, or never")
    policy["publication"] = publication
    merge_method = policy.get("merge_method", "squash")
    if merge_method not in MERGE_METHODS:
        raise WatcherError("policy.merge_method must be squash, merge, or rebase")
    policy["merge_method"] = merge_method
    pre_merge_commands = policy.get("pre_merge_commands", [])
    if (not isinstance(pre_merge_commands, list)
            or any(not isinstance(cmd, str) or not cmd.strip() for cmd in pre_merge_commands)):
        raise WatcherError("policy.pre_merge_commands must be an array of non-empty command strings")
    policy["pre_merge_commands"] = pre_merge_commands
    policy["require_ci"] = bool(policy.get("require_ci", True))
    if policy.get("max_risk", "medium") not in {"low", "medium"}:
        raise WatcherError("policy.max_risk must be low or medium")
    config["policy"] = policy
    if config.get("schema_version") == 3:
        scheduler = config.get("scheduler")
        if (not isinstance(scheduler, dict)
                or scheduler.get("backend") != "orca-automation"
                or not isinstance(scheduler.get("automation_id"), str)
                or not scheduler["automation_id"]):
            raise WatcherError("schema v3 requires an Orca Automation scheduler ID")
    return config


def parse_issue_dependencies(body: str, repository: str | None = None) -> list[int]:
    if not isinstance(body, str) or not body:
        return []
    found: set[int] = set()
    for match in DEPENDENCY_LINE.finditer(body):
        segment = match.group(1)
        for ref in ISSUE_REF.finditer(segment):
            raw = ref.group(0)
            if repository and raw.startswith("https://github.com/"):
                expected_prefix = f"https://github.com/{repository.lower()}/issues/"
                if not raw.lower().startswith(expected_prefix):
                    continue
            number = int(ref.group(1))
            if number > 0:
                found.add(number)
    return sorted(found)


def normalize_depends_on(value: Any) -> list[int]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return []
    if not isinstance(value, list):
        return []
    result: set[int] = set()
    for item in value:
        if isinstance(item, int) and not isinstance(item, bool) and item > 0:
            result.add(item)
    return sorted(result)


def find_dependency_cycle(start: int, graph: dict[int, list[int]]) -> list[int] | None:
    path: list[int] = []
    index: dict[int, int] = {}
    visited: set[int] = set()

    def dfs(node: int) -> list[int] | None:
        if node in index:
            return [*path[index[node]:], node]
        if node in visited:
            return None
        index[node] = len(path)
        path.append(node)
        for dep in graph.get(node, []):
            cycle = dfs(dep)
            if cycle is not None:
                return cycle
        path.pop()
        del index[node]
        visited.add(node)
        return None

    return dfs(start)


class Ledger:
    """SQLite queue with immutable Issue identities and per-attempt history."""

    def __init__(self, path: Path, lease_seconds: int, max_attempts: int = 2) -> None:
        self.path = path
        self.lease_seconds = lease_seconds
        self.max_attempts = max_attempts
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, timeout=30, isolation_level=None)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA foreign_keys=ON")
        self._initialize()

    def _initialize(self) -> None:
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS issues (
              node_id TEXT PRIMARY KEY, repository TEXT NOT NULL, issue_number INTEGER NOT NULL,
              url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, created_at TEXT NOT NULL,
              issue_updated_at TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
              lease_started_at TEXT, lease_owner TEXT, pid INTEGER, summary TEXT,
              returncode INTEGER, log_path TEXT, depends_on TEXT NOT NULL DEFAULT '[]'
            );
            CREATE TABLE IF NOT EXISTS events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              node_id TEXT NOT NULL REFERENCES issues(node_id), at TEXT NOT NULL,
              kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}'
            );
            CREATE TABLE IF NOT EXISTS attempts (
              node_id TEXT NOT NULL REFERENCES issues(node_id), attempt_number INTEGER NOT NULL,
              status TEXT NOT NULL, lease_started_at TEXT, lease_owner TEXT, pid INTEGER,
              run_id TEXT, worktree_path TEXT, branch TEXT, base_sha TEXT, head_sha TEXT,
              summary TEXT, returncode INTEGER, log_path TEXT, agent_id TEXT,
              orca_task_id TEXT, orca_dispatch_id TEXT, orca_worktree_id TEXT,
              last_heartbeat TEXT, output_digest TEXT, failure_patch_path TEXT,
              pr_number INTEGER, pr_url TEXT, merged_at TEXT,
              PRIMARY KEY(node_id, attempt_number)
            );
            """
        )
        row = self.connection.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone()
        if row is None:
            self.connection.execute("INSERT INTO metadata(key, value) VALUES ('schema_version', ?)",
                                    (str(LEDGER_VERSION),))
        elif row[0] == "1":
            self._migrate_v1()
            self._migrate_v2()
            self._migrate_v3()
            self._migrate_v4()
            self.connection.execute("UPDATE metadata SET value=? WHERE key='schema_version'",
                                    (str(LEDGER_VERSION),))
        elif row[0] == "2":
            self._migrate_v2()
            self._migrate_v3()
            self._migrate_v4()
            self.connection.execute("UPDATE metadata SET value=? WHERE key='schema_version'",
                                    (str(LEDGER_VERSION),))
        elif row[0] == "3":
            self._migrate_v3()
            self._migrate_v4()
            self.connection.execute("UPDATE metadata SET value=? WHERE key='schema_version'",
                                    (str(LEDGER_VERSION),))
        elif row[0] == "4":
            self._migrate_v4()
            self.connection.execute("UPDATE metadata SET value=? WHERE key='schema_version'",
                                    (str(LEDGER_VERSION),))
        elif row[0] != str(LEDGER_VERSION):
            raise WatcherError(f"unsupported ledger schema version: {row[0]}")

    def _migrate_v1(self) -> None:
        for row in self.connection.execute("SELECT * FROM issues WHERE attempts > 0").fetchall():
            status = "ready-for-review" if row["status"] == "succeeded" else row["status"]
            self.connection.execute(
                """INSERT OR IGNORE INTO attempts
                   (node_id, attempt_number, status, lease_started_at, lease_owner, pid,
                    summary, returncode, log_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (row["node_id"], row["attempts"], status, row["lease_started_at"], row["lease_owner"],
                 row["pid"], row["summary"], row["returncode"], row["log_path"]),
            )
            self.connection.execute("UPDATE issues SET status=? WHERE node_id=?", (status, row["node_id"]))

    def _migrate_v2(self) -> None:
        existing = {row[1] for row in self.connection.execute("PRAGMA table_info(attempts)")}
        for name in ("agent_id", "orca_task_id", "orca_dispatch_id", "orca_worktree_id"):
            if name not in existing:
                self.connection.execute(f"ALTER TABLE attempts ADD COLUMN {name} TEXT")

    def _migrate_v3(self) -> None:
        issue_columns = {row[1] for row in self.connection.execute("PRAGMA table_info(issues)")}
        if "depends_on" not in issue_columns:
            self.connection.execute("ALTER TABLE issues ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'")
        attempt_columns = {row[1] for row in self.connection.execute("PRAGMA table_info(attempts)")}
        for name in ("last_heartbeat", "output_digest", "failure_patch_path"):
            if name not in attempt_columns:
                self.connection.execute(f"ALTER TABLE attempts ADD COLUMN {name} TEXT")

    def _migrate_v4(self) -> None:
        attempt_columns = {row[1] for row in self.connection.execute("PRAGMA table_info(attempts)")}
        if "pr_number" not in attempt_columns:
            self.connection.execute("ALTER TABLE attempts ADD COLUMN pr_number INTEGER")
        for name in ("pr_url", "merged_at"):
            if name not in attempt_columns:
                self.connection.execute(f"ALTER TABLE attempts ADD COLUMN {name} TEXT")

    def metadata(self, key: str) -> str | None:
        row = self.connection.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
        return str(row[0]) if row else None

    def set_metadata(self, key: str, value: str) -> None:
        self.connection.execute(
            "INSERT INTO metadata(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value),
        )

    def enqueue(self, issue: dict[str, Any]) -> bool:
        depends_on = normalize_depends_on(
            issue.get("depends_on")
            if "depends_on" in issue
            else parse_issue_dependencies(str(issue.get("body", "")), issue.get("repository"))
        )
        depends_json = json.dumps(depends_on, separators=(",", ":"))
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            cursor = self.connection.execute(
                """INSERT OR IGNORE INTO issues
                   (node_id, repository, issue_number, url, title, created_at, issue_updated_at,
                    status, depends_on)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)""",
                (issue["id"], issue["repository"], issue["number"], issue["url"], issue.get("title", ""),
                 issue["createdAt"], issue["updatedAt"], depends_json),
            )
            if cursor.rowcount:
                self._event(issue["id"], "discovered", {"url": issue["url"], "depends_on": depends_on})
            else:
                self.connection.execute(
                    """UPDATE issues SET depends_on=?
                       WHERE node_id=? AND status IN ('queued', 'retry-pending', 'failed')""",
                    (depends_json, issue["id"]),
                )
                cursor = self.connection.execute(
                    """UPDATE issues SET status='retry-pending', title=?, issue_updated_at=?,
                       depends_on=?, lease_started_at=NULL, lease_owner=NULL, pid=NULL, summary=NULL,
                       returncode=NULL, log_path=NULL
                       WHERE node_id=? AND status='failed' AND attempts < ?""",
                    (issue.get("title", ""), issue["updatedAt"], depends_json, issue["id"],
                     self.max_attempts),
                )
                if cursor.rowcount:
                    self._event(issue["id"], "automatic_retry_queued", {
                        "attempts": int(self.connection.execute(
                            "SELECT attempts FROM issues WHERE node_id=?", (issue["id"],)
                        ).fetchone()[0]),
                        "max_attempts": self.max_attempts,
                    })
            self.connection.execute("COMMIT")
            return bool(cursor.rowcount)
        except Exception:
            self.connection.execute("ROLLBACK")
            raise

    def _repository_graph(self, repository: str) -> tuple[dict[int, str], dict[int, list[int]]]:
        statuses: dict[int, str] = {}
        graph: dict[int, list[int]] = {}
        for row in self.connection.execute(
            "SELECT issue_number, status, depends_on FROM issues WHERE repository=?", (repository,)
        ).fetchall():
            number = int(row["issue_number"])
            statuses[number] = str(row["status"])
            graph[number] = normalize_depends_on(row["depends_on"])
        return statuses, graph

    def _resolve_external_dependencies(
        self, is_dependency_satisfied: Callable[[str, int], bool] | None
    ) -> dict[tuple[str, int], bool]:
        if is_dependency_satisfied is None:
            return {}
        candidates = self.connection.execute(
            "SELECT repository, depends_on FROM issues WHERE status IN ('queued', 'retry-pending')"
        ).fetchall()
        known = {
            (str(row["repository"]), int(row["issue_number"]))
            for row in self.connection.execute("SELECT repository, issue_number FROM issues").fetchall()
        }
        resolved: dict[tuple[str, int], bool] = {}
        for row in candidates:
            repo = str(row["repository"])
            for dep in normalize_depends_on(row["depends_on"]):
                key = (repo, dep)
                if key not in known and key not in resolved:
                    try:
                        resolved[key] = bool(is_dependency_satisfied(repo, dep))
                    except Exception:
                        resolved[key] = False
        return resolved

    def claim_many(
        self,
        limit: int,
        at: dt.datetime | None = None,
        is_dependency_satisfied: Callable[[str, int], bool] | None = None,
    ) -> list[dict[str, Any]]:
        current = at or now()
        external_satisfied = self._resolve_external_dependencies(is_dependency_satisfied)
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            for row in self.connection.execute(
                "SELECT * FROM issues WHERE status='claimed' ORDER BY created_at"
            ).fetchall():
                local_live = row["lease_owner"] == socket.gethostname() and pid_alive(int(row["pid"] or 0))
                lease_live = bool(row["lease_started_at"]) and (
                    current - parse_time(row["lease_started_at"])
                ).total_seconds() <= self.lease_seconds
                if local_live or lease_live:
                    continue
                self._finish_stale(row)
            active = int(self.connection.execute(
                "SELECT COUNT(*) FROM issues WHERE status IN ('claimed', 'running')"
            ).fetchone()[0])
            available = max(0, limit - active)
            if available <= 0:
                self.connection.execute("COMMIT")
                return []
            candidates = self.connection.execute(
                """SELECT * FROM issues WHERE status IN ('queued', 'retry-pending')
                   ORDER BY created_at, issue_number"""
            ).fetchall()
            if not candidates:
                self.connection.execute("COMMIT")
                return []
            repo_cache: dict[str, tuple[dict[int, str], dict[int, list[int]]]] = {}
            chosen: list[sqlite3.Row] = []
            for row in candidates:
                if len(chosen) >= available:
                    break
                deps = normalize_depends_on(row["depends_on"])
                if deps:
                    repo = str(row["repository"])
                    if repo not in repo_cache:
                        repo_cache[repo] = self._repository_graph(repo)
                    statuses, graph = repo_cache[repo]
                    cycle = find_dependency_cycle(int(row["issue_number"]), graph)
                    if cycle is not None:
                        chain = " -> ".join(f"#{num}" for num in cycle)
                        summary = f"dependency cycle detected: {chain}"
                        self.connection.execute(
                            "UPDATE issues SET status='blocked', summary=? WHERE node_id=?",
                            (summary, row["node_id"]),
                        )
                        self._event(row["node_id"], "dependency_cycle", {"cycle": cycle})
                        continue
                    unmet = []
                    for dep in deps:
                        if dep in statuses:
                            if statuses[dep] not in RESOLVED_DEPENDENCY_STATES:
                                unmet.append(dep)
                        elif not external_satisfied.get((repo, dep), False):
                            unmet.append(dep)
                    if unmet:
                        continue
                chosen.append(row)
            if not chosen:
                self.connection.execute("COMMIT")
                return []
            claimed: list[dict[str, Any]] = []
            for row in chosen:
                attempt = int(self.connection.execute(
                    "SELECT COALESCE(MAX(attempt_number), 0) + 1 FROM attempts WHERE node_id=?",
                    (row["node_id"],),
                ).fetchone()[0])
                started, owner = iso(current), socket.gethostname()
                self.connection.execute(
                    """UPDATE issues SET status='claimed', attempts=?, lease_started_at=?, lease_owner=?,
                       pid=NULL, summary=NULL, returncode=NULL, log_path=NULL WHERE node_id=?""",
                    (attempt, started, owner, row["node_id"]),
                )
                self.connection.execute(
                    "INSERT INTO attempts(node_id, attempt_number, status, lease_started_at, lease_owner, last_heartbeat) "
                    "VALUES (?, ?, 'claimed', ?, ?, ?)", (row["node_id"], attempt, started, owner, started),
                )
                self._event(row["node_id"], "claimed", {"attempt": attempt})
                value = dict(row)
                value["depends_on"] = normalize_depends_on(row["depends_on"])
                value["attempt_number"] = attempt
                claimed.append(value)
            self.connection.execute("COMMIT")
            return claimed
        except Exception:
            self.connection.execute("ROLLBACK")
            raise

    def claim_next(
        self,
        at: dt.datetime | None = None,
        is_dependency_satisfied: Callable[[str, int], bool] | None = None,
    ) -> dict[str, Any] | None:
        values = self.claim_many(1, at, is_dependency_satisfied=is_dependency_satisfied)
        return values[0] if values else None

    def _finish_stale(self, row: sqlite3.Row) -> None:
        summary = "worker lease expired; inspect the recorded attempt before retrying"
        self.connection.execute("UPDATE issues SET status='needs-human', summary=?, pid=NULL WHERE node_id=?",
                                (summary, row["node_id"]))
        self.connection.execute(
            "UPDATE attempts SET status='needs-human', summary=?, pid=NULL WHERE node_id=? AND attempt_number=?",
            (summary, row["node_id"], row["attempts"]),
        )
        self._event(row["node_id"], "stale_worker", {"attempt": row["attempts"]})

    def running(self, node_id: str, attempt: int, pid: int) -> None:
        self._update(node_id, attempt, "running", {"pid": pid}, "started")

    def assign_artifacts(self, node_id: str, attempt: int, run_id: str, worktree: Path, branch: str) -> None:
        self._update(node_id, attempt, "claimed", {
            "run_id": run_id, "worktree_path": str(worktree), "branch": branch,
        }, "artifacts_assigned")

    def assign_orca(self, node_id: str, attempt: int, **fields: Any) -> None:
        required = ("orca_task_id", "orca_dispatch_id", "orca_worktree_id", "worktree_path")
        if any(not isinstance(fields.get(name), str) or not fields[name] for name in required):
            raise OrcaIdentityError("Orca dispatch evidence is incomplete")
        worktree = Path(fields["worktree_path"])
        if not worktree.is_absolute():
            raise OrcaIdentityError("Orca worktree path must be absolute")
        fields.setdefault("last_heartbeat", iso())
        self._update(node_id, attempt, "running", fields, "orca_dispatched", validate_orca=True)

    def heartbeat(
        self,
        node_id: str,
        attempt: int,
        at: dt.datetime | None = None,
        output_digest: str | None = None,
    ) -> None:
        timestamp = iso(at)
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            if output_digest is None:
                cursor = self.connection.execute(
                    "UPDATE attempts SET last_heartbeat=? WHERE node_id=? AND attempt_number=? AND status='running'",
                    (timestamp, node_id, attempt),
                )
            else:
                cursor = self.connection.execute(
                    "UPDATE attempts SET last_heartbeat=?, output_digest=? "
                    "WHERE node_id=? AND attempt_number=? AND status='running'",
                    (timestamp, output_digest, node_id, attempt),
                )
            if cursor.rowcount:
                self._event(node_id, "heartbeat", {"attempt": attempt, "at": timestamp})
            self.connection.execute("COMMIT")
        except Exception:
            self.connection.execute("ROLLBACK")
            raise

    def ensure_orca_identity_available(self, node_id: str, attempt: int, name: str, value: str) -> None:
        if name not in {"orca_task_id", "orca_dispatch_id", "orca_worktree_id", "worktree_path"}:
            raise WatcherError("unsupported Orca identity field")
        if not isinstance(value, str) or not value:
            raise OrcaIdentityError(f"Orca {name} is missing")
        if name == "worktree_path" and not Path(value).is_absolute():
            raise OrcaIdentityError("Orca worktree path must be absolute")
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            self._ensure_orca_identity_available(node_id, attempt, name, value)
            self.connection.execute("COMMIT")
        except Exception:
            self.connection.execute("ROLLBACK")
            raise

    def active_attempts(self) -> list[dict[str, Any]]:
        return [dict(row) for row in self.connection.execute(
            """SELECT attempts.*, issues.repository, issues.issue_number, issues.url, issues.title
               FROM attempts JOIN issues USING(node_id)
               WHERE attempts.status='running' ORDER BY issues.created_at, issues.issue_number"""
        )]

    def open_pr_attempts(self) -> list[dict[str, Any]]:
        return [dict(row) for row in self.connection.execute(
            """SELECT attempts.*, issues.repository, issues.issue_number, issues.url, issues.title
               FROM attempts JOIN issues USING(node_id)
               WHERE attempts.status='pr-open' ORDER BY issues.created_at, issues.issue_number"""
        )]

    def finish(self, node_id: str, attempt: int, status: str,
               validate_orca: bool = False, **fields: Any) -> None:
        if status == "succeeded":
            status = "ready-for-review"
        if status not in STOPPED_STATES:
            raise WatcherError(f"invalid result status: {status}")
        fields["pid"] = None
        self._update(node_id, attempt, status, fields, "finished", validate_orca=validate_orca)

    def _update(self, node_id: str, attempt: int, status: str, fields: dict[str, Any], kind: str,
                validate_orca: bool = False) -> None:
        allowed = {"pid", "run_id", "worktree_path", "branch", "base_sha", "head_sha",
                   "summary", "returncode", "log_path", "agent_id", "orca_task_id",
                   "orca_dispatch_id", "orca_worktree_id", "last_heartbeat",
                   "output_digest", "failure_patch_path", "pr_number", "pr_url", "merged_at"}
        if any(key not in allowed for key in fields):
            raise WatcherError("unsupported attempt field")
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            if validate_orca:
                for name in ("orca_task_id", "orca_dispatch_id", "orca_worktree_id", "worktree_path"):
                    if name in fields:
                        self._ensure_orca_identity_available(node_id, attempt, name, fields[name])
            assignments = ["status=?", *[f"{key}=?" for key in fields]]
            cursor = self.connection.execute(
                f"UPDATE attempts SET {', '.join(assignments)} WHERE node_id=? AND attempt_number=?",
                [status, *fields.values(), node_id, attempt],
            )
            if not cursor.rowcount:
                raise WatcherError("attempt not found")
            issue_fields = {key: value for key, value in fields.items()
                            if key in {"pid", "summary", "returncode", "log_path"}}
            issue_assignments = ["status=?", *[f"{key}=?" for key in issue_fields]]
            self.connection.execute(
                f"UPDATE issues SET {', '.join(issue_assignments)} WHERE node_id=?",
                [status, *issue_fields.values(), node_id],
            )
            self._event(node_id, kind, {"attempt": attempt, "status": status})
            self.connection.execute("COMMIT")
        except Exception:
            self.connection.execute("ROLLBACK")
            raise

    def _ensure_orca_identity_available(self, node_id: str, attempt: int,
                                        name: str, value: str) -> None:
        current = self.connection.execute(
            f"SELECT {name} FROM attempts WHERE node_id=? AND attempt_number=?",
            (node_id, attempt),
        ).fetchone()
        if current is None:
            raise WatcherError("attempt not found")
        recorded = current[name]
        normalized = str(Path(value).resolve()) if name == "worktree_path" else value
        if recorded is not None:
            recorded_normalized = (str(Path(recorded).resolve())
                                   if name == "worktree_path" else recorded)
            if recorded_normalized != normalized:
                raise OrcaIdentityError(f"Orca attempted to replace recorded {name}")
        candidates = self.connection.execute(
            f"""SELECT node_id, attempt_number, {name} FROM attempts
                WHERE {name} IS NOT NULL AND NOT (node_id=? AND attempt_number=?)""",
            (node_id, attempt),
        ).fetchall()
        conflict = next((row for row in candidates if (
            str(Path(row[name]).resolve()) if name == "worktree_path" else row[name]
        ) == normalized), None)
        if conflict:
            raise OrcaIdentityError(f"Orca reused recorded {name} from another Issue or attempt")

    def retry(self, url: str, repo: Path, discard: bool, orca_cli: str | None = None) -> int:
        issue = self.connection.execute("SELECT * FROM issues WHERE url=?", (url,)).fetchone()
        if issue is None:
            raise WatcherError(f"unknown Issue URL: {url}")
        if issue["status"] not in STOPPED_STATES:
            raise WatcherError("only a stopped Issue can be retried")
        row = self.connection.execute(
            "SELECT * FROM attempts WHERE node_id=? AND attempt_number=?", (issue["node_id"], issue["attempts"])
        ).fetchone()
        attempt = dict(row) if row else {}
        if pid_alive(int(attempt.get("pid") or 0)):
            raise WatcherError("the recorded worker is still running")
        if attempt.get("orca_dispatch_id") and orca_cli:
            try:
                state = json_command([orca_cli, "orchestration", "worker-show", "--dispatch",
                                      attempt["orca_dispatch_id"], "--json"])
            except WatcherError:
                state = {}
            if state and worker_state(state) == "running":
                raise WatcherError("the recorded Orca worker is still running")
        if discard:
            cleanup_attempt(repo, attempt, force=True, orca_cli=orca_cli)
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            if row:
                self.connection.execute(
                    "UPDATE attempts SET status='rejected', pid=NULL WHERE node_id=? AND attempt_number=?",
                    (issue["node_id"], issue["attempts"]),
                )
            self.connection.execute(
                """UPDATE issues SET status='retry-pending', lease_started_at=NULL, lease_owner=NULL,
                   pid=NULL, summary=NULL, returncode=NULL, log_path=NULL WHERE node_id=?""", (issue["node_id"],),
            )
            self._event(issue["node_id"], "retry_requested", {"discarded": discard})
            self.connection.execute("COMMIT")
        except Exception:
            self.connection.execute("ROLLBACK")
            raise
        return int(issue["attempts"]) + 1

    def discard(self, url: str, repo: Path, orca_cli: str | None = None) -> dict[str, Any]:
        issue = self.connection.execute("SELECT * FROM issues WHERE url=?", (url,)).fetchone()
        if issue is None:
            raise WatcherError(f"unknown Issue URL: {url}")
        if issue["status"] in RESOLVED_DEPENDENCY_STATES:
            raise WatcherError("an accepted or merged Issue cannot be discarded")
        row = self.connection.execute(
            "SELECT * FROM attempts WHERE node_id=? AND attempt_number=?",
            (issue["node_id"], issue["attempts"]),
        ).fetchone()
        if row is None:
            raise WatcherError("Issue has no recorded attempt to discard")
        attempt = dict(row)
        if pid_alive(int(attempt.get("pid") or 0)):
            raise WatcherError("the recorded worker is still running")
        dispatch_id = attempt.get("orca_dispatch_id")
        if dispatch_id and orca_cli:
            try:
                state = json_command([orca_cli, "orchestration", "worker-show", "--dispatch",
                                      dispatch_id, "--json"])
            except WatcherError:
                state = {}
            if state and worker_state(state) == "running":
                raise WatcherError("the recorded Orca worker is still running")
        cleanup_attempt(repo, attempt, force=True, orca_cli=orca_cli)
        summary = "explicitly discarded after confirming no live worker"
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            self.connection.execute(
                "UPDATE attempts SET status='discarded', pid=NULL, summary=? "
                "WHERE node_id=? AND attempt_number=?",
                (summary, issue["node_id"], issue["attempts"]),
            )
            self.connection.execute(
                "UPDATE issues SET status='discarded', pid=NULL, summary=? WHERE node_id=?",
                (summary, issue["node_id"]),
            )
            self._event(issue["node_id"], "discarded", {"attempt": issue["attempts"]})
            self.connection.execute("COMMIT")
        except Exception:
            self.connection.execute("ROLLBACK")
            raise
        return {"status": "discarded", "url": url,
                "attempt": int(issue["attempts"]), "summary": summary}

    def accept(self, url: str, repo: Path, target_branch: str, orca_cli: str | None = None) -> dict[str, str]:
        issue = self.connection.execute("SELECT * FROM issues WHERE url=?", (url,)).fetchone()
        if issue is None or issue["status"] != "ready-for-review":
            raise WatcherError("Issue must be ready-for-review before acceptance")
        attempt = dict(self.connection.execute(
            "SELECT * FROM attempts WHERE node_id=? AND attempt_number=?", (issue["node_id"], issue["attempts"])
        ).fetchone())
        if git(repo, "branch", "--show-current") != target_branch:
            raise WatcherError(f"target branch {target_branch} is not checked out")
        if git(repo, "status", "--porcelain"):
            raise WatcherError("target worktree must be clean before merging")
        worktree_value = attempt.get("worktree_path")
        registered = (isinstance(worktree_value, str) and Path(worktree_value).is_absolute()
                      and Path(worktree_value).resolve() in worktree_paths(repo))
        if registered:
            validate_attempt(repo, attempt)
            result = command(["git", "-C", str(repo), "merge", "--no-ff", "--no-edit",
                              attempt["head_sha"]])
            if result.returncode:
                raise WatcherError(result.stderr.strip() or "local merge failed")
        else:
            validate_already_merged_attempt(repo, attempt, url)
        close_github_issue(url)
        self._update(issue["node_id"], issue["attempts"], "accepted",
                     {"summary": "merged locally and closed Issue"}, "accepted")
        response = {"status": "accepted", "target_branch": target_branch,
                    "head": git(repo, "rev-parse", "HEAD"), "issue": "closed"}
        try:
            cleanup_attempt(repo, attempt, force=False, orca_cli=orca_cli)
        except WatcherError as exc:
            response["cleanup_warning"] = str(exc)
        return response

    def prune(
        self,
        repo: Path,
        older_than_hours: float = 24.0,
        dry_run: bool = False,
        orca_cli: str | None = None,
        at: dt.datetime | None = None,
    ) -> dict[str, Any]:
        if older_than_hours < 0:
            raise WatcherError("older_than_hours must be non-negative")
        current = at or now()
        cutoff_seconds = older_than_hours * 3600.0
        rows = self.connection.execute(
            """SELECT attempts.*, issues.issue_number, issues.status AS issue_status,
                      issues.attempts AS latest_attempt, issues.url
               FROM attempts JOIN issues USING(node_id)
               WHERE attempts.status IN ('failed', 'discarded', 'rejected')
                 AND attempts.worktree_path IS NOT NULL
               ORDER BY issues.issue_number, attempts.attempt_number"""
        ).fetchall()
        candidates: list[dict[str, Any]] = []
        pruned: list[dict[str, Any]] = []
        skipped: list[dict[str, Any]] = []
        for row in rows:
            attempt = dict(row)
            if (attempt["attempt_number"] == attempt["latest_attempt"]
                    and attempt["issue_status"] in PROTECTED_ISSUE_STATES):
                continue
            worktree_path = Path(attempt["worktree_path"])
            branch = attempt.get("branch")
            branch_exists = bool(branch) and command(
                ["git", "-C", str(repo), "show-ref", "--verify", "--quiet", f"refs/heads/{branch}"]
            ).returncode == 0
            if not worktree_path.exists() and not branch_exists:
                continue
            ref_time = attempt.get("last_heartbeat") or attempt.get("lease_started_at")
            if not ref_time:
                continue
            age_seconds = (current - parse_time(ref_time)).total_seconds()
            if age_seconds < cutoff_seconds:
                continue
            if pid_alive(int(attempt.get("pid") or 0)):
                skipped.append({"url": attempt["url"], "attempt": attempt["attempt_number"],
                                "reason": "local worker PID is still running"})
                continue
            dispatch_id = attempt.get("orca_dispatch_id")
            if dispatch_id and orca_cli:
                try:
                    state = json_command([orca_cli, "orchestration", "worker-show", "--dispatch",
                                          dispatch_id, "--json"])
                except WatcherError:
                    state = {}
                if state and worker_state(state) == "running":
                    skipped.append({"url": attempt["url"], "attempt": attempt["attempt_number"],
                                    "reason": "Orca worker is still running"})
                    continue
            entry = {
                "url": attempt["url"],
                "issue_number": attempt["issue_number"],
                "attempt": attempt["attempt_number"],
                "status": attempt["status"],
                "worktree_path": attempt["worktree_path"],
                "branch": branch,
                "age_hours": round(age_seconds / 3600.0, 2),
                "failure_patch_path": attempt.get("failure_patch_path"),
            }
            candidates.append(entry)
            if dry_run:
                continue
            patch_path = attempt.get("failure_patch_path")
            if not patch_path and worktree_path.is_dir():
                patch_path = export_failure_patch(repo, self.path, attempt)
                if patch_path:
                    entry["failure_patch_path"] = patch_path
                    self.connection.execute("BEGIN IMMEDIATE")
                    try:
                        self.connection.execute(
                            "UPDATE attempts SET failure_patch_path=? WHERE node_id=? AND attempt_number=?",
                            (patch_path, attempt["node_id"], attempt["attempt_number"]),
                        )
                        self.connection.execute("COMMIT")
                    except Exception:
                        self.connection.execute("ROLLBACK")
                        raise
            try:
                cleanup_attempt(repo, attempt, force=True, orca_cli=orca_cli)
            except WatcherError as exc:
                skipped.append({"url": attempt["url"], "attempt": attempt["attempt_number"],
                                "reason": str(exc)})
                continue
            self.connection.execute("BEGIN IMMEDIATE")
            try:
                self._event(attempt["node_id"], "pruned", {
                    "attempt": attempt["attempt_number"],
                    "worktree_path": attempt["worktree_path"],
                    "failure_patch_path": patch_path,
                })
                self.connection.execute("COMMIT")
            except Exception:
                self.connection.execute("ROLLBACK")
                raise
            pruned.append(entry)
        return {
            "status": "dry-run" if dry_run else "pruned",
            "older_than_hours": older_than_hours,
            "candidates": candidates,
            "pruned": pruned,
            "skipped": skipped,
        }

    def snapshot(self) -> dict[str, Any]:
        issues = [dict(row) for row in self.connection.execute(
            "SELECT * FROM issues ORDER BY created_at, issue_number"
        )]
        repo_statuses: dict[str, dict[int, str]] = {}
        for issue in issues:
            repo_statuses.setdefault(issue["repository"], {})[int(issue["issue_number"])] = str(issue["status"])
        status_counts: dict[str, int] = {}
        waiting_on_dependencies = 0
        for issue in issues:
            deps = normalize_depends_on(issue.get("depends_on"))
            issue["depends_on"] = deps
            waiting = [
                dep for dep in deps
                if repo_statuses.get(issue["repository"], {}).get(dep) not in RESOLVED_DEPENDENCY_STATES
            ] if issue["status"] in {"queued", "retry-pending"} and deps else []
            issue["waiting_on"] = waiting
            if waiting:
                waiting_on_dependencies += 1
            status_counts[issue["status"]] = status_counts.get(issue["status"], 0) + 1
            issue["attempt_history"] = [dict(row) for row in self.connection.execute(
                "SELECT * FROM attempts WHERE node_id=? ORDER BY attempt_number", (issue["node_id"],)
            )]
        return {
            "schema_version": LEDGER_VERSION,
            "summary": {
                "total": len(issues),
                "by_status": status_counts,
                "waiting_on_dependencies": waiting_on_dependencies,
            },
            "issues": issues,
        }

    def _event(self, node_id: str, kind: str, detail: dict[str, Any]) -> None:
        self.connection.execute("INSERT INTO events(node_id, at, kind, detail) VALUES (?, ?, ?, ?)",
                                (node_id, iso(), kind, json.dumps(detail, ensure_ascii=False, sort_keys=True)))


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def command(argv: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    is_github = Path(argv[0]).name == "gh"
    if is_github:
        environment.setdefault("GODEBUG", "http2client=0")
    attempts = 3 if is_github else 1
    for attempt in range(attempts):
        result = subprocess.run(argv, cwd=cwd, env=environment, check=False, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode == 0 or "EOF" not in result.stderr or attempt == attempts - 1:
            return result
    return result


def github_issue_state(url: str) -> str:
    result = command(["gh", "issue", "view", url, "--json", "state,url"])
    if result.returncode:
        raise WatcherError(result.stderr.strip() or "could not read GitHub Issue state")
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise WatcherError("gh issue view returned invalid JSON") from exc
    if not isinstance(value, dict) or value.get("url") != url or value.get("state") not in {"OPEN", "CLOSED"}:
        raise WatcherError("gh issue view returned an unexpected Issue")
    return str(value["state"])


def close_github_issue(url: str) -> None:
    if github_issue_state(url) == "CLOSED":
        return
    result = command(["gh", "issue", "close", url, "--reason", "completed"])
    if result.returncode and github_issue_state(url) != "CLOSED":
        raise WatcherError(result.stderr.strip() or "GitHub Issue close failed")
    if github_issue_state(url) != "CLOSED":
        raise WatcherError("GitHub Issue remained open after close")


def json_command(argv: list[str], cwd: Path | None = None) -> dict[str, Any]:
    result = command(argv, cwd)
    try:
        value = json.loads(result.stdout or result.stderr)
    except json.JSONDecodeError as exc:
        raise WatcherError(result.stderr.strip() or result.stdout.strip() or f"{argv[0]} returned invalid JSON") from exc
    if result.returncode or value.get("ok") is False:
        error = value.get("error") or {}
        raise WatcherError(error.get("message") or result.stderr.strip() or f"{argv[0]} command failed")
    return value


def nested_value(value: Any, *paths: tuple[str, ...]) -> Any:
    for path in paths:
        current = value
        for key in path:
            if not isinstance(current, dict) or key not in current:
                break
            current = current[key]
        else:
            if current is not None:
                return current
    return None


def string_content(value: Any) -> str:
    values: list[str] = []
    if isinstance(value, str):
        values.append(value)
    elif isinstance(value, dict):
        for item in value.values():
            values.append(string_content(item))
    elif isinstance(value, list):
        for item in value:
            values.append(string_content(item))
    return "\n".join(item for item in values if item)


def named_values(value: Any, names: set[str]) -> list[str]:
    found: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            if key in names and isinstance(item, str):
                found.append(item.lower())
            found.extend(named_values(item, names))
    elif isinstance(value, list):
        for item in value:
            found.extend(named_values(item, names))
    return found


def find_worktree(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        identity = value.get("id") or value.get("worktreeId")
        path = value.get("path") or value.get("worktreePath")
        if isinstance(identity, str) and isinstance(path, str) and "::" in identity:
            return value
        for item in value.values():
            found = find_worktree(item)
            if found:
                return found
    elif isinstance(value, list):
        for item in value:
            found = find_worktree(item)
            if found:
                return found
    return {}


def find_worktree_id(value: Any) -> str | None:
    if isinstance(value, dict):
        for key in ("worktreeId", "worktree_id", "workspace"):
            identity = value.get(key)
            if isinstance(identity, str) and "::" in identity:
                return identity
            if isinstance(identity, dict):
                nested_id = identity.get("id") or identity.get("worktreeId")
                if isinstance(nested_id, str) and "::" in nested_id:
                    return nested_id
        if value.get("kind") == "worktree":
            identity = value.get("id")
            if isinstance(identity, str) and "::" in identity:
                return identity
        for item in value.values():
            found = find_worktree_id(item)
            if found:
                return found
    elif isinstance(value, list):
        for item in value:
            found = find_worktree_id(item)
            if found:
                return found
    return None


def find_named_string(value: Any, names: set[str]) -> str | None:
    if isinstance(value, dict):
        for key, item in value.items():
            if key in names and isinstance(item, str) and item:
                return item
            found = find_named_string(item, names)
            if found:
                return found
    elif isinstance(value, list):
        for item in value:
            found = find_named_string(item, names)
            if found:
                return found
    return None


def orca_call(config: dict[str, Any], *args: str) -> dict[str, Any]:
    argv = [config["orca"]["cli"], *args, "--json"]
    result = command(argv)
    try:
        value = json.loads(result.stdout or result.stderr)
    except json.JSONDecodeError as exc:
        raise OrcaCommandError(result.stderr.strip() or "Orca returned invalid JSON", {}) from exc
    if result.returncode or value.get("ok") is False:
        error = value.get("error") or {}
        raise OrcaCommandError(error.get("message") or result.stderr.strip() or "Orca command failed", value)
    return value


def git(repo: Path, *args: str) -> str:
    result = command(["git", "-C", str(repo), *args])
    if result.returncode:
        raise WatcherError(result.stderr.strip() or "Git command failed")
    return result.stdout.strip()


def worktree_paths(repo: Path) -> set[Path]:
    return {Path(line.removeprefix("worktree ")).resolve()
            for line in git(repo, "worktree", "list", "--porcelain").splitlines()
            if line.startswith("worktree ")}


def validate_attempt(repo: Path, attempt: dict[str, Any]) -> None:
    required = ("run_id", "worktree_path", "branch", "base_sha", "head_sha")
    if any(not isinstance(attempt.get(key), str) or not attempt[key] for key in required):
        raise WatcherError("successful receipt is missing worktree evidence")
    worktree = Path(attempt["worktree_path"])
    if not worktree.is_absolute() or worktree.resolve() == repo.resolve() or worktree.resolve() not in worktree_paths(repo):
        raise WatcherError("receipt worktree is not a registered isolated worktree")
    if ((not attempt.get("orca_worktree_id") and not attempt["branch"].startswith("repair/"))
            or git(worktree, "branch", "--show-current") != attempt["branch"]):
        raise WatcherError("receipt branch does not match a repair worktree")
    if git(worktree, "rev-parse", "HEAD") != attempt["head_sha"]:
        raise WatcherError("receipt head SHA does not match the worktree")
    if git(worktree, "status", "--porcelain"):
        raise WatcherError("receipt worktree is not clean")
    if git(repo, "rev-parse", f"{attempt['base_sha']}^{{commit}}") != attempt["base_sha"]:
        raise WatcherError("receipt base SHA is invalid")
    state = repair_run_state(repo, attempt["run_id"])
    if (state.get("base_sha") != attempt["base_sha"]
            or state.get("state") not in {"REVIEW", "AWAIT_PUBLICATION_APPROVAL"}):
        raise WatcherError("repair run ledger does not confirm a reviewed local result")


def validate_already_merged_attempt(repo: Path, attempt: dict[str, Any], url: str) -> None:
    required = ("run_id", "worktree_path", "branch", "base_sha", "head_sha")
    if any(not isinstance(attempt.get(key), str) or not attempt[key] for key in required):
        raise WatcherError("successful receipt is missing worktree evidence")
    for name in ("base_sha", "head_sha"):
        if git(repo, "rev-parse", f"{attempt[name]}^{{commit}}") != attempt[name]:
            raise WatcherError(f"receipt {name.removesuffix('_sha')} SHA is invalid")
    state = load_repair_run_state(repo, attempt["run_id"])
    commit_receipts = [receipt.get("value") for receipt in state.get("receipts", {}).values()
                       if isinstance(receipt, dict) and receipt.get("kind") == "commit"]
    if (state.get("base_sha") != attempt["base_sha"]
            or state.get("source_url") != url
            or attempt["head_sha"] not in commit_receipts
            or state.get("state") not in {"REVIEW", "AWAIT_PUBLICATION_APPROVAL"}):
        raise WatcherError("repair run ledger does not confirm a reviewed local result")
    merged = command(["git", "-C", str(repo), "merge-base", "--is-ancestor",
                      attempt["head_sha"], "HEAD"])
    if merged.returncode:
        raise WatcherError("recorded head is not merged into the target branch")


def repair_run_state(repo: Path, run_id: str) -> dict[str, Any]:
    state = load_repair_run_state(repo, run_id)
    common = git_common_dir(repo)
    recorded_repo = Path(state.get("repository", "")).resolve()
    try:
        same_git_repository = git_common_dir(recorded_repo) == common
    except (WatcherError, OSError):
        same_git_repository = False
    if recorded_repo != repo.resolve() and not same_git_repository:
        raise WatcherError("repair run ledger belongs to a different run or repository")
    return state


def load_repair_run_state(repo: Path, run_id: str) -> dict[str, Any]:
    try:
        uuid.UUID(run_id)
    except ValueError as exc:
        raise WatcherError("receipt run ID is not a UUID") from exc
    common = git_common_dir(repo)
    state_path = common / "issue-repair" / "runs" / run_id / "state.json"
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        raise WatcherError("repair run ledger is missing or invalid") from exc
    if state.get("run_id") != run_id:
        raise WatcherError("repair run ledger belongs to a different run")
    return state


def git_common_dir(repo: Path) -> Path:
    value = Path(git(repo, "rev-parse", "--git-common-dir"))
    return (value if value.is_absolute() else repo / value).resolve()


def export_failure_patch(repo: Path, state_db: Path, attempt: dict[str, Any]) -> str | None:
    worktree_value = attempt.get("worktree_path")
    if not isinstance(worktree_value, str) or not worktree_value:
        return None
    worktree = Path(worktree_value)
    if not worktree.is_dir():
        return None
    sections: list[str] = []
    try:
        base_sha = attempt.get("base_sha")
        if isinstance(base_sha, str) and base_sha:
            committed = command(["git", "-C", str(worktree), "diff", f"{base_sha}..HEAD"])
            if committed.returncode == 0 and committed.stdout.strip():
                sections.append(f"# Committed diff ({base_sha}..HEAD)\n{committed.stdout}")
        unstaged = command(["git", "-C", str(worktree), "diff", "HEAD"])
        if unstaged.returncode == 0 and unstaged.stdout.strip():
            sections.append(f"# Working tree diff (HEAD)\n{unstaged.stdout}")
        status = command(["git", "-C", str(worktree), "status", "--short"])
        if status.returncode == 0 and status.stdout.strip():
            sections.append(f"# Working tree status\n{status.stdout}")
    except OSError:
        return None
    if not sections:
        return None
    patch_dir = state_db.parent / "patches"
    patch_dir.mkdir(parents=True, exist_ok=True)
    issue_num = attempt.get("issue_number", "unknown")
    attempt_num = attempt.get("attempt_number", 0)
    patch_path = patch_dir / f"issue-{issue_num}-attempt-{attempt_num}.patch"
    patch_path.write_text("\n".join(sections).rstrip() + "\n", encoding="utf-8")
    return str(patch_path)


def cleanup_attempt(repo: Path, attempt: dict[str, Any], force: bool, orca_cli: str | None = None) -> None:
    worktree_value, branch = attempt.get("worktree_path"), attempt.get("branch")
    if not worktree_value and not branch:
        return
    if not worktree_value or not branch or not attempt.get("run_id"):
        raise WatcherError("recorded attempt lacks a complete cleanup identity")
    worktree = Path(worktree_value)
    branch_exists = command(
        ["git", "-C", str(repo), "show-ref", "--verify", "--quiet", f"refs/heads/{branch}"]
    ).returncode == 0
    orca_worktree_id = attempt.get("orca_worktree_id")
    if orca_worktree_id and orca_cli:
        if not worktree.exists() and not branch_exists:
            return
        result = json_command([orca_cli, "worktree", "rm", "--worktree", f"id:{orca_worktree_id}",
                               "--force", "--json"])
        if result.get("ok") is False:
            raise WatcherError("Orca refused to remove the recorded worktree")
        return
    if not branch.startswith("repair/"):
        raise WatcherError("refusing to delete a non-repair branch")
    if not worktree.is_absolute() or worktree.resolve() == repo.resolve():
        raise WatcherError("refusing to remove an unsafe worktree path")
    registered = worktree.resolve() in worktree_paths(repo)
    if not registered and not branch_exists:
        return
    if not registered:
        raise WatcherError("recorded worktree is no longer registered; inspect it manually")
    if git(worktree, "branch", "--show-current") != branch:
        raise WatcherError("recorded worktree and branch do not match")
    if worktree_value:
        argv = ["git", "-C", str(repo), "worktree", "remove"]
        if force:
            argv.append("--force")
        result = command([*argv, str(worktree)])
        if result.returncode:
            raise WatcherError(result.stderr.strip() or "failed to remove worktree")
    if branch:
        if branch_exists:
            result = command(["git", "-C", str(repo), "branch", "-D" if force else "-d", branch])
            if result.returncode:
                raise WatcherError(result.stderr.strip() or "failed to delete repair branch")


def github_login() -> str:
    result = command(["gh", "api", "user", "--jq", ".login"])
    if result.returncode:
        raise WatcherError(result.stderr.strip() or "gh api user failed")
    return result.stdout.strip()


def repository_metadata(repository: dict[str, Any]) -> dict[str, Any]:
    result = command(["gh", "repo", "view", repository["repository"], "--json",
                      "id,nameWithOwner,isArchived,hasIssuesEnabled"])
    if result.returncode:
        raise WatcherError(result.stderr.strip() or f"failed to inspect {repository['repository']}")
    metadata = json.loads(result.stdout)
    if metadata.get("nameWithOwner", "").lower() != repository["repository"].lower():
        raise WatcherError(f"repository canonical name mismatch: {metadata.get('nameWithOwner')}")
    if metadata.get("isArchived") or not metadata.get("hasIssuesEnabled"):
        raise WatcherError(f"repository is archived or Issues are disabled: {repository['repository']}")
    if repository.get("repository_id") and repository["repository_id"] != metadata.get("id"):
        raise WatcherError(f"repository node ID mismatch: {repository['repository']}")
    return metadata


def list_issues(repository: dict[str, Any], login: str,
                created_through: dt.datetime | None = None) -> list[dict[str, Any]]:
    repository_metadata(repository)
    slug = repository["repository"]
    author = login if repository["author"] == "@me" else repository["author"]
    result = command(["gh", "issue", "list", "--repo", slug, "--state", "open", "--limit", "1000",
                      "--author", author, "--json", "id,number,url,title,body,author,labels,createdAt,updatedAt"])
    if result.returncode:
        raise WatcherError(result.stderr.strip() or f"failed to list Issues for {slug}")
    values = json.loads(result.stdout)
    labels = set(repository.get("labels", []))
    eligible = []
    for issue in values:
        created = parse_time(issue["createdAt"])
        actual_labels = {item.get("name") for item in issue.get("labels", [])}
        if ((issue.get("author") or {}).get("login", "").lower() == author.lower()
                and labels.issubset(actual_labels)
                and (created_through is None or created <= created_through)):
            issue["repository"] = slug
            issue["depends_on"] = parse_issue_dependencies(str(issue.get("body", "")), slug)
            eligible.append(issue)
    return eligible


def poll(config: dict[str, Any], ledger: Ledger) -> dict[str, Any]:
    login, observed, enqueued = github_login(), 0, 0
    for repository in config["repositories"]:
        boundary = now()
        for issue in list_issues(repository, login, created_through=boundary):
            observed += 1
            enqueued += int(ledger.enqueue(issue))
    return {"observed": observed, "enqueued": enqueued}


def strip_ansi(text: str) -> str:
    return ANSI_ESCAPE.sub("", text).replace("\r\n", "\n").replace("\r", "\n")


def _valid_receipt_dict(payload: str) -> dict[str, Any] | None:
    try:
        value = json.loads(payload)
    except json.JSONDecodeError:
        return None
    if (isinstance(value, dict) and value.get("status") in CHILD_STATES
            and isinstance(value.get("summary"), str)):
        return value
    return None


def is_placeholder_receipt(receipt: dict[str, Any]) -> bool:
    return (
        receipt.get("run_id") == "<assigned run ID>"
        or receipt.get("worktree_path") == "<absolute worktree path>"
        or receipt.get("branch") == "<assigned branch>"
    )


def parse_receipt(output: str) -> dict[str, Any] | None:
    cleaned = strip_ansi(output)
    lines = cleaned.splitlines()
    parsed: list[dict[str, Any]] = []
    for idx, raw_line in enumerate(lines):
        match = RECEIPT_START.match(raw_line)
        if not match:
            continue
        first_chunk = match.group(1).rstrip()
        direct = _valid_receipt_dict(first_chunk)
        if direct is not None:
            parsed.append(direct)
            continue
        # Terminal output (e.g. PTY fallback for antigravity/claude/codex) often
        # soft-wraps long JSON receipt lines across multiple indented rows.
        parts = [first_chunk]
        for cont in lines[idx + 1:idx + 31]:
            stripped = cont.strip()
            if not stripped or "AUTOPILOT_RESULT" in stripped:
                break
            parts.append(stripped)
            for joiner in ("", " "):
                candidate = _valid_receipt_dict(joiner.join(parts))
                if candidate is not None:
                    parsed.append(candidate)
                    break
            else:
                continue
            break
    if parsed:
        return parsed[-1]
    return None


def recover_receipt_from_repair_ledger(
    repository: dict[str, Any] | None,
    attempt: dict[str, Any],
) -> dict[str, Any] | None:
    """Recover a verified success receipt from the durable repair ledger when
    a completed worker's terminal output was unavailable, truncated, or raced
    against `worker_done`. The recovered receipt still passes `validate_attempt`.
    """
    if repository is None:
        return None
    run_id = attempt.get("run_id")
    worktree_path = attempt.get("worktree_path")
    branch = attempt.get("branch")
    if not all(isinstance(v, str) and v for v in (run_id, worktree_path, branch)):
        return None
    worktree = Path(str(worktree_path))
    if not worktree.is_dir():
        return None
    try:
        state = repair_run_state(repository["repo_path"], str(run_id))
    except WatcherError:
        return None
    if state.get("state") not in {"REVIEW", "AWAIT_PUBLICATION_APPROVAL"}:
        return None
    base_sha = state.get("base_sha")
    if not isinstance(base_sha, str) or not base_sha:
        return None
    try:
        head_sha = git(worktree, "rev-parse", "HEAD")
    except WatcherError:
        return None
    receipts = state.get("receipts") if isinstance(state.get("receipts"), dict) else {}
    commit_receipts = [
        item.get("value") for item in receipts.values()
        if isinstance(item, dict) and item.get("kind") == "commit" and isinstance(item.get("value"), str)
    ]
    if commit_receipts and head_sha not in commit_receipts:
        return None
    summary = ""
    verification = receipts.get("verification")
    if isinstance(verification, dict) and isinstance(verification.get("value"), str):
        summary = verification["value"].strip()
    if not summary:
        try:
            summary = git(worktree, "log", "-1", "--format=%s")
        except WatcherError:
            summary = "Verified repair ledger result ready for review"
    return {
        "status": "ready-for-review",
        "summary": summary or "Verified repair ledger result ready for review",
        "run_id": str(run_id),
        "worktree_path": str(worktree_path),
        "branch": str(branch),
        "base_sha": base_sha,
        "head_sha": head_sha,
    }


def invalid_receipt_summary(output: str) -> str:
    cleaned = strip_ansi(output)
    candidates = [
        line.strip() for line in cleaned.splitlines()
        if "AUTOPILOT_RESULT" in line and "<assigned run ID>" not in line
    ]
    if not candidates:
        return "Orca worker returned no valid AUTOPILOT_RESULT receipt"
    line = candidates[-1]
    if line.startswith("AUTOPILOT_RESULT "):
        return "invalid AUTOPILOT_RESULT receipt: missing required colon after the prefix"
    if line.startswith("AUTOPILOT_RESULT:"):
        if not line.startswith("AUTOPILOT_RESULT: "):
            return "invalid AUTOPILOT_RESULT receipt: expected the literal prefix `AUTOPILOT_RESULT: `"
        try:
            json.loads(line.removeprefix("AUTOPILOT_RESULT: "))
        except json.JSONDecodeError:
            return "invalid AUTOPILOT_RESULT receipt: payload is invalid JSON"
    return "invalid AUTOPILOT_RESULT receipt: expected one exact standalone receipt line"


def verified_receipt(receipt: dict[str, Any] | None, repository: dict[str, Any],
                     run: dict[str, Any], output: str = "") -> tuple[str, str, dict[str, Any]]:
    if receipt is None:
        return "failed", invalid_receipt_summary(output), {}
    status = "ready-for-review" if receipt["status"] in {"succeeded", "ready-for-review"} else receipt["status"]
    identity = {key: receipt.get(key) for key in ("run_id", "worktree_path", "branch")}
    expected = {key: run.get(key) for key in identity}
    if identity != expected:
        return "needs-human", "receipt does not match the coordinator-assigned run, worktree, and branch", {}
    fields = {"base_sha": receipt.get("base_sha"), "head_sha": receipt.get("head_sha")}
    if status == "ready-for-review":
        try:
            validate_attempt(repository["repo_path"], {
                **expected, **fields, "orca_worktree_id": run.get("orca_worktree_id")
            })
        except WatcherError as exc:
            return "needs-human", f"unverified success receipt: {exc}", fields
    return status, receipt["summary"], fields if status == "ready-for-review" else {}


def prompt_for(run: dict[str, Any], config: dict[str, Any]) -> str:
    publication = config.get("policy", {}).get("publication", "auto-merge")
    if publication == "auto-merge":
        handoff_note = (
            "The coordinator will push your verified commit, open a PR, verify PR checks, and auto-merge "
            "once checks pass. Do not push, create a PR, merge, close, comment, or relabel Issues yourself. "
        )
    elif publication == "pr-only":
        handoff_note = (
            "The coordinator will push your verified commit and open a PR for review. "
            "Do not push, create a PR, merge, close, comment, or relabel Issues yourself. "
        )
    else:
        handoff_note = (
            "Never push, create a PR, merge, close, comment, label, release, or deploy. "
        )
    return (
        f"Use $github-issue-repair {run['url']} in GitHub Issue Autopilot mode for attempt "
        f"{run['attempt_number']}. Use repair run ID {run['run_id']} and the current Orca-managed worktree and branch. "
        "The dispatcher verified this open Issue against its repository, "
        "current open state, author, and labels. Implement one bounded local package at risk no greater than "
        f"{config['policy'].get('max_risk', 'medium')} in the isolated Orca worktree and verify it independently. "
        "Update the active Orca worktree comment at investigation, implementation, and test checkpoints. "
        "Stop on ambiguity, unsafe work, expansion, dependency upgrades, migrations, security/auth/payment changes, "
        f"public API changes, destructive operations, or a broad diff. {handoff_note}"
        "Commit only the isolated task changes. Finish with exactly one single-line receipt "
        "using the literal prefix `AUTOPILOT_RESULT: `. Example (replace the placeholders):\n"
        "AUTOPILOT_RESULT: "
        '{"status":"needs-human","summary":"explain why","run_id":"<assigned run ID>",'
        '"worktree_path":"<absolute worktree path>","branch":"<assigned branch>"}\n'
        "Then send the Orca worker_done required by the injected dispatch. Success uses ready-for-review and includes "
        "summary, run_id, absolute worktree_path, branch, base_sha, and head_sha. Other statuses are needs-human, "
        "blocked, or failed."
    )


def select_agent(issue: dict[str, Any], config: dict[str, Any]) -> str:
    labels = sorted({item.get("name", "") for item in issue.get("labels", [])
                     if isinstance(item, dict) and item.get("name", "").startswith("agent:")})
    if len(labels) > 1:
        raise WatcherError(f"multiple agent labels conflict: {', '.join(labels)}")
    agent = labels[0].split(":", 1)[1] if labels else config["orca"]["default_agent"]
    if not agent or agent not in config["orca"]["allowed_agents"]:
        raise WatcherError(f"agent is not allowed for this repository: {agent or '<empty>'}")
    return agent


def ensure_orca_run(config: dict[str, Any], ledger: Ledger) -> str:
    run_id = ledger.metadata("orca_run_id")
    if run_id:
        orca_call(config, "orchestration", "run-use", "--id", run_id)
        return run_id
    response = orca_call(config, "orchestration", "run-create", "--objective",
                         "Supervise eligible GitHub Issue Autopilot repair worktrees")
    run_id = nested_value(response, ("result", "run", "id"), ("result", "runId"), ("result", "id"))
    if not isinstance(run_id, str) or not run_id:
        raise WatcherError("Orca did not return an orchestration Run ID")
    ledger.set_metadata("orca_run_id", run_id)
    return run_id


def create_orca_task(config: dict[str, Any], run_id: str, run: dict[str, Any]) -> str:
    response = orca_call(
        config, "orchestration", "task-create", "--run", run_id,
        "--task-title", f"#{run['issue_number']} {run['title']}",
        "--display-name", f"#{run['issue_number']} {run['title']}",
        "--spec", prompt_for(run, config),
    )
    task_id = nested_value(response, ("result", "task", "id"), ("result", "taskId"), ("result", "id"))
    if not isinstance(task_id, str) or not task_id:
        raise WatcherError("Orca did not return a Task ID")
    return task_id


def preferred_worktree_base_branch(repo: Path) -> str | None:
    branch_result = command(["git", "-C", str(repo), "branch", "--show-current"])
    if branch_result.returncode != 0:
        return None
    branch = branch_result.stdout.strip()
    if not branch:
        return None
    upstream_result = command([
        "git", "-C", str(repo), "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}",
    ])
    if upstream_result.returncode != 0:
        return branch
    upstream = upstream_result.stdout.strip()
    if not upstream:
        return branch
    counts = command([
        "git", "-C", str(repo), "rev-list", "--left-right", "--count", f"{upstream}...{branch}",
    ])
    if counts.returncode != 0:
        return None
    parts = counts.stdout.strip().split()
    if len(parts) != 2:
        return None
    try:
        ahead = int(parts[1])
    except ValueError:
        return None
    return branch if ahead > 0 else None


def create_blocked_worktree(config: dict[str, Any], repository: dict[str, Any], run: dict[str, Any],
                            summary: str) -> dict[str, Any]:
    base_branch = preferred_worktree_base_branch(repository["repo_path"])
    extra = ("--base-branch", base_branch) if base_branch else ()
    response = orca_call(
        config, "worktree", "create", "--repo", f"path:{repository['repo_path']}",
        "--name", f"issue-{run['issue_number']}-attempt-{run['attempt_number']}",
        "--parent-worktree", f"path:{repository['repo_path']}", "--issue", str(run["issue_number"]),
        "--comment", f"Needs human: {summary}", "--setup", config["orca"]["setup"],
        *extra,
    )
    worktree = nested_value(response, ("result", "worktree"), ("result",))
    return worktree if isinstance(worktree, dict) else {}


def resolve_worker_worktree(config: dict[str, Any], response: dict[str, Any]) -> dict[str, Any] | None:
    worktree = nested_value(
        response,
        ("result", "worktree"),
        ("result", "worker", "worktree"),
        ("result", "placement", "worktree"),
    )
    if isinstance(worktree, dict):
        return worktree
    worktree_id = find_worktree_id(response)
    if not worktree_id:
        return None
    candidate_path = Path(worktree_id.split("::", 1)[1])
    if candidate_path.is_dir():
        try:
            branch = git(candidate_path, "branch", "--show-current")
        except WatcherError:
            branch = ""
        if branch:
            return {"id": worktree_id, "path": str(candidate_path), "branch": branch}
    try:
        shown = orca_call(config, "worktree", "show", "--worktree", f"id:{worktree_id}")
    except WatcherError:
        return None
    resolved = nested_value(shown, ("result", "worktree"), ("result",))
    return resolved if isinstance(resolved, dict) else None


def dispatch_one(config: dict[str, Any], ledger: Ledger, run_id: str, run: dict[str, Any]) -> dict[str, Any]:
    attempt = run["attempt_number"]
    repository = next((item for item in config["repositories"] if item["repository"] == run["repository"]), None)
    if repository is None:
        ledger.finish(run["node_id"], attempt, "blocked", summary="repository removed from policy")
        return {"url": run["url"], "status": "blocked"}
    repair_run_id = str(uuid.uuid4())
    run["run_id"] = repair_run_id
    try:
        current = {item["id"]: item for item in list_issues(repository, github_login())}
        issue = current.get(run["node_id"])
        if issue is None:
            ledger.finish(run["node_id"], attempt, "blocked", summary="Issue is no longer open or eligible",
                          run_id=repair_run_id)
            return {"url": run["url"], "status": "blocked"}
        candidate_task_id = create_orca_task(config, run_id, run)
        ledger.ensure_orca_identity_available(
            run["node_id"], attempt, "orca_task_id", candidate_task_id
        )
        task_id = candidate_task_id
        agent = select_agent(issue, config)
        base_branch = preferred_worktree_base_branch(repository["repo_path"])
        base_args = ("--base-branch", base_branch) if base_branch else ()
        response = orca_call(
            config, "orchestration", "worker-start", "--run", run_id, "--task", task_id,
            "--worktree", "new-child", "--repo", f"path:{repository['repo_path']}",
            *base_args,
            "--name", f"issue-{run['issue_number']}-attempt-{attempt}",
            "--display-name", f"#{run['issue_number']} {run['title']}",
            "--comment", f"Starting {agent}", "--agent", agent, "--setup", config["orca"]["setup"],
            "--timeout-ms", "60000",
        )
        dispatch_id = nested_value(response, ("result", "dispatch", "id"),
                                   ("result", "dispatchId"), ("result", "worker", "dispatchId"))
        if not isinstance(dispatch_id, str) or not dispatch_id:
            raise OrcaEvidenceError("Orca worker receipt omitted its Dispatch identity")
        ledger.ensure_orca_identity_available(run["node_id"], attempt, "orca_dispatch_id", dispatch_id)
        dispatch_identity_verified = True
        worktree = resolve_worker_worktree(config, response)
        if not isinstance(worktree, dict):
            raise OrcaEvidenceError("Orca worker receipt omitted its worktree identity")
        worktree_id = worktree.get("id") or worktree.get("worktreeId")
        worktree_path = worktree.get("path") or worktree.get("worktreePath")
        branch = str(worktree.get("branch", "")).removeprefix("refs/heads/")
        if not all(isinstance(value, str) and value for value in (worktree_id, worktree_path, branch)):
            raise OrcaEvidenceError("Orca worker receipt omitted worktree path or branch")
        ledger.assign_orca(
            run["node_id"], attempt, run_id=repair_run_id, agent_id=agent,
            orca_task_id=task_id, orca_dispatch_id=dispatch_id, orca_worktree_id=worktree_id,
            worktree_path=worktree_path, branch=branch,
        )
        orca_call(config, "worktree", "set", "--worktree", f"id:{worktree_id}",
                  "--issue", str(run["issue_number"]), "--workspace-status", "in-progress",
                  "--comment", f"{agent}: investigating")
        return {"url": run["url"], "attempt": attempt, "status": "running", "agent": agent,
                "orca_task_id": task_id, "orca_dispatch_id": dispatch_id,
                "orca_worktree_id": worktree_id}
    except WatcherError as exc:
        summary = str(exc)
        task_id = locals().get("task_id")
        residual_dispatch = (find_named_string(exc.response, {"dispatchId", "dispatch_id"})
                             if isinstance(exc, OrcaCommandError) else None)
        stalled = (find_named_string(exc.response, {"lastError", "last_error"})
                   if isinstance(exc, OrcaCommandError) else None) == "agent_prompt_stalled"
        blocked = find_worktree(exc.response) if isinstance(exc, OrcaCommandError) else {}
        worker_started = "response" in locals()
        if worker_started:
            local_worktree = locals().get("worktree")
            if isinstance(local_worktree, dict):
                blocked = local_worktree
            local_dispatch = locals().get("dispatch_id")
            if isinstance(local_dispatch, str) and local_dispatch:
                residual_dispatch = local_dispatch
        if worker_started and locals().get("dispatch_identity_verified") is True:
            try:
                orca_call(config, "orchestration", "worker-stop", "--dispatch", residual_dispatch)
            except WatcherError as stop_error:
                summary = f"{summary}; failed to fence the new Orca worker: {stop_error}"
        if not blocked and isinstance(exc, OrcaCommandError):
            residual_worktree_id = find_worktree_id(exc.response)
            if residual_worktree_id:
                residual_path = Path(residual_worktree_id.split("::", 1)[1])
                if residual_path.is_dir():
                    blocked = {"id": residual_worktree_id, "path": str(residual_path),
                               "branch": git(residual_path, "branch", "--show-current")}
        if stalled and residual_dispatch and blocked and isinstance(task_id, str):
            worktree_id = blocked.get("id") or blocked.get("worktreeId")
            worktree_path = blocked.get("path") or blocked.get("worktreePath")
            branch = str(blocked.get("branch", "")).removeprefix("refs/heads/")
            if all(isinstance(value, str) and value
                   for value in (worktree_id, worktree_path, branch)):
                try:
                    ledger.ensure_orca_identity_available(
                        run["node_id"], attempt, "orca_dispatch_id", residual_dispatch
                    )
                    stalled_dispatch_verified = True
                    ledger.assign_orca(
                        run["node_id"], attempt, run_id=repair_run_id, agent_id=agent,
                        orca_task_id=task_id, orca_dispatch_id=residual_dispatch,
                        orca_worktree_id=worktree_id, worktree_path=worktree_path, branch=branch,
                    )
                except OrcaIdentityError as identity_error:
                    summary = str(identity_error)
                    if locals().get("stalled_dispatch_verified") is True:
                        try:
                            orca_call(config, "orchestration", "worker-stop",
                                      "--dispatch", residual_dispatch)
                        except WatcherError as stop_error:
                            summary = f"{summary}; failed to fence the new Orca worker: {stop_error}"
                    failure_fields = {"summary": summary, "run_id": repair_run_id,
                                      "orca_task_id": task_id}
                    if locals().get("stalled_dispatch_verified") is True:
                        failure_fields["orca_dispatch_id"] = residual_dispatch
                    ledger.finish(run["node_id"], attempt, "needs-human",
                                  validate_orca=True, **failure_fields)
                    return {"url": run["url"], "attempt": attempt,
                            "status": "needs-human", "summary": summary}
                return {"url": run["url"], "attempt": attempt, "status": "running",
                        "agent": agent, "orca_task_id": task_id,
                        "orca_dispatch_id": residual_dispatch, "orca_worktree_id": worktree_id,
                        "warning": "Orca readiness timed out after the Agent received its prompt"}
        if not blocked and not worker_started and not isinstance(exc, OrcaIdentityError):
            try:
                blocked = create_blocked_worktree(config, repository, run, summary)
            except WatcherError:
                blocked = {}
        worktree_id = blocked.get("id") or blocked.get("worktreeId")
        fields = {"summary": summary, "run_id": repair_run_id}
        if isinstance(task_id, str):
            fields["orca_task_id"] = task_id
        dispatch_safe = locals().get("dispatch_identity_verified") is True
        if residual_dispatch and not dispatch_safe:
            try:
                ledger.ensure_orca_identity_available(
                    run["node_id"], attempt, "orca_dispatch_id", residual_dispatch
                )
                dispatch_safe = True
            except OrcaIdentityError as identity_error:
                summary = str(identity_error)
                fields["summary"] = summary
                blocked = {}
                worktree_id = None
        if residual_dispatch and dispatch_safe:
            fields["orca_dispatch_id"] = residual_dispatch
        if isinstance(worktree_id, str):
            worktree_path = blocked.get("path") or blocked.get("worktreePath")
            try:
                ledger.ensure_orca_identity_available(
                    run["node_id"], attempt, "orca_worktree_id", worktree_id
                )
                ledger.ensure_orca_identity_available(
                    run["node_id"], attempt, "worktree_path", worktree_path
                )
                fields["orca_worktree_id"] = worktree_id
                fields["worktree_path"] = worktree_path
                fields["branch"] = str(blocked.get("branch", "")).removeprefix("refs/heads/")
            except OrcaIdentityError as identity_error:
                summary = str(identity_error)
                fields["summary"] = summary
        ledger.finish(run["node_id"], attempt, "needs-human", validate_orca=True, **fields)
        return {"url": run["url"], "attempt": attempt, "status": "needs-human", "summary": summary,
                "orca_worktree_id": worktree_id}


def worker_state(value: dict[str, Any]) -> str:
    states = set(named_values(value, {"outcome", "status", "state", "taskStatus", "dispatchStatus"}))
    if states.intersection({"failed", "stopped", "blocked", "cancelled"}):
        return "failed"
    if states.intersection({"succeeded", "completed", "settled"}):
        return "completed"
    return "running"


def run_pre_merge_commands(worktree: Path, commands: list[str]) -> str | None:
    for cmd in commands:
        result = subprocess.run(
            cmd, cwd=worktree, shell=True, check=False, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        if result.returncode != 0:
            detail = (result.stderr.strip() or result.stdout.strip() or f"exit code {result.returncode}")
            return f"pre-merge verification failed (`{cmd}`): {detail[:240]}"
    return None


def find_existing_open_pr(repository: str, branch: str) -> dict[str, Any] | None:
    result = command([
        "gh", "pr", "list", "--repo", repository, "--head", branch,
        "--state", "open", "--json", "number,url",
    ])
    if result.returncode:
        raise WatcherError(result.stderr.strip() or "failed to check existing open PRs")
    try:
        items = json.loads(result.stdout or "[]")
    except json.JSONDecodeError as exc:
        raise WatcherError("gh pr list returned invalid JSON") from exc
    if isinstance(items, list) and items:
        first = items[0]
        if isinstance(first, dict) and isinstance(first.get("url"), str) and isinstance(first.get("number"), int):
            return {"pr_number": first["number"], "pr_url": first["url"]}
    return None


def publish_attempt_pr(
    config: dict[str, Any],
    repository: dict[str, Any],
    attempt: dict[str, Any],
    summary: str,
) -> dict[str, Any]:
    worktree = Path(str(attempt["worktree_path"]))
    branch = str(attempt["branch"])
    slug = str(repository["repository"])
    push = command(["git", "-C", str(worktree), "push", "-u", "origin", branch])
    if push.returncode:
        raise WatcherError(push.stderr.strip() or push.stdout.strip() or f"git push failed for {branch}")
    existing = find_existing_open_pr(slug, branch)
    if existing is not None:
        return existing
    issue_num = attempt["issue_number"]
    title = f"{attempt.get('title') or f'Fix issue #{issue_num}'} (#{issue_num})"
    body = (
        f"Closes #{issue_num}\n\n"
        f"## Automated Repair Summary\n\n"
        f"{summary}\n\n"
        f"- Issue: {attempt['url']}\n"
        f"- Attempt: {attempt['attempt_number']}\n"
        f"- Branch: `{branch}`\n"
        f"- Base SHA: `{attempt.get('base_sha') or ''}`\n"
        f"- Head SHA: `{attempt.get('head_sha') or ''}`\n"
    )
    created = command([
        "gh", "pr", "create", "--repo", slug, "--head", branch,
        "--title", title, "--body", body,
    ])
    if created.returncode:
        existing = find_existing_open_pr(slug, branch)
        if existing is not None:
            return existing
        raise WatcherError(created.stderr.strip() or created.stdout.strip() or "gh pr create failed")
    existing = find_existing_open_pr(slug, branch)
    if existing is not None:
        return existing
    pr_url = next((line.strip() for line in reversed(created.stdout.splitlines())
                   if line.strip().startswith("https://github.com/")), "")
    if not pr_url:
        raise WatcherError("gh pr create did not return a PR URL")
    pr_view = github_pr_view(pr_url)
    return {"pr_number": int(pr_view["number"]), "pr_url": str(pr_view["url"])}


def github_pr_view(pr_url: str) -> dict[str, Any]:
    result = command([
        "gh", "pr", "view", pr_url, "--json",
        "number,url,state,mergeable,mergeStateStatus,statusCheckRollup,headRefOid",
    ])
    if result.returncode:
        raise WatcherError(result.stderr.strip() or f"gh pr view failed for {pr_url}")
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise WatcherError("gh pr view returned invalid JSON") from exc
    if not isinstance(value, dict) or not value.get("state"):
        raise WatcherError("gh pr view returned an unexpected payload")
    return value


def evaluate_pr_checks(rollup: Any) -> tuple[str, str]:
    if not isinstance(rollup, list) or not rollup:
        return "passed", "no CI checks configured"
    failed: list[str] = []
    pending: list[str] = []
    for item in rollup:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or item.get("context") or "check")
        conclusion = str(item.get("conclusion") or "").upper()
        state = str(item.get("state") or item.get("status") or "").upper()
        if conclusion in CI_FAILURE_CONCLUSIONS or state in CI_FAILURE_CONCLUSIONS:
            failed.append(f"{name} ({conclusion or state})")
        elif state in CI_PENDING_STATES or (not conclusion and state not in {"SUCCESS", "COMPLETED", "NEUTRAL", "SKIPPED"}):
            pending.append(name)
    if failed:
        return "failed", f"CI checks failed: {', '.join(failed[:5])}"
    if pending:
        return "pending", f"waiting for CI checks: {', '.join(pending[:5])}"
    return "passed", f"all {len(rollup)} CI check(s) passed"


def merge_github_pr(pr_url: str, method: str) -> None:
    flag = {"squash": "--squash", "merge": "--merge", "rebase": "--rebase"}[method]
    result = command(["gh", "pr", "merge", pr_url, flag, "--delete-branch"])
    if result.returncode:
        state = github_pr_view(pr_url)
        if state.get("state") != "MERGED":
            raise WatcherError(result.stderr.strip() or result.stdout.strip() or "gh pr merge failed")
    confirmed = github_pr_view(pr_url)
    if confirmed.get("state") != "MERGED":
        raise WatcherError(f"PR remained in state {confirmed.get('state')} after merge")


def reconcile_pull_requests(
    config: dict[str, Any],
    ledger: Ledger,
    at: dt.datetime | None = None,
) -> list[dict[str, Any]]:
    policy = config.get("policy", {})
    publication = policy.get("publication", "auto-merge")
    merge_method = policy.get("merge_method", "squash")
    require_ci = bool(policy.get("require_ci", True))
    pre_merge_commands = list(policy.get("pre_merge_commands", []))
    orca_cli = config.get("orca", {}).get("cli")
    current = at or now()
    updated: list[dict[str, Any]] = []
    for attempt in ledger.open_pr_attempts():
        pr_url = attempt.get("pr_url")
        if not pr_url:
            continue
        repository = next((item for item in config["repositories"]
                           if item["repository"] == attempt["repository"]), None)
        if repository is None:
            continue
        try:
            pr = github_pr_view(pr_url)
        except WatcherError:
            continue
        pr_state = str(pr.get("state", "")).upper()
        if pr_state == "MERGED":
            try:
                close_github_issue(attempt["url"])
            except WatcherError:
                pass
            ledger.finish(
                attempt["node_id"], attempt["attempt_number"], "merged",
                summary=f"PR merged: {pr_url}", merged_at=iso(current),
            )
            try:
                cleanup_attempt(repository["repo_path"], attempt, force=True, orca_cli=orca_cli)
            except WatcherError:
                pass
            command(["git", "-C", str(repository["repo_path"]), "fetch", "origin"])
            updated.append({"url": attempt["url"], "status": "merged", "pr_url": pr_url})
            continue
        if pr_state == "CLOSED":
            summary = f"PR was closed without merging: {pr_url}"
            ledger.finish(attempt["node_id"], attempt["attempt_number"], "needs-human", summary=summary)
            if attempt.get("orca_worktree_id"):
                try:
                    orca_call(config, "worktree", "set", "--worktree", f"id:{attempt['orca_worktree_id']}",
                              "--workspace-status", "in-review", "--comment", f"needs-human: {summary[:180]}")
                except WatcherError:
                    pass
            updated.append({"url": attempt["url"], "status": "needs-human", "pr_url": pr_url, "summary": summary})
            continue
        if pr_state != "OPEN" or publication != "auto-merge":
            continue
        mergeable = str(pr.get("mergeable") or "").upper()
        merge_status = str(pr.get("mergeStateStatus") or "").upper()
        if mergeable == "CONFLICTING" or merge_status == "DIRTY":
            summary = f"PR has merge conflicts ({pr_url}); manual resolution or retry required"
            patch_path = export_failure_patch(repository["repo_path"], ledger.path, attempt)
            extra = {"failure_patch_path": patch_path} if patch_path else {}
            ledger.finish(attempt["node_id"], attempt["attempt_number"], "needs-human",
                          summary=summary, **extra)
            if attempt.get("orca_worktree_id"):
                try:
                    orca_call(config, "worktree", "set", "--worktree", f"id:{attempt['orca_worktree_id']}",
                              "--workspace-status", "in-review", "--comment", f"needs-human: {summary[:180]}")
                except WatcherError:
                    pass
            updated.append({"url": attempt["url"], "status": "needs-human", "pr_url": pr_url, "summary": summary})
            continue
        if mergeable == "UNKNOWN":
            continue
        if require_ci:
            ci_state, ci_detail = evaluate_pr_checks(pr.get("statusCheckRollup"))
            if ci_state == "pending":
                continue
            if ci_state == "failed":
                summary = f"PR blocked by {ci_detail} ({pr_url})"
                patch_path = export_failure_patch(repository["repo_path"], ledger.path, attempt)
                extra = {"failure_patch_path": patch_path} if patch_path else {}
                ledger.finish(attempt["node_id"], attempt["attempt_number"], "needs-human",
                              summary=summary, **extra)
                if attempt.get("orca_worktree_id"):
                    try:
                        orca_call(config, "worktree", "set", "--worktree", f"id:{attempt['orca_worktree_id']}",
                                  "--workspace-status", "in-review", "--comment", f"needs-human: {summary[:180]}")
                    except WatcherError:
                        pass
                updated.append({"url": attempt["url"], "status": "needs-human", "pr_url": pr_url, "summary": summary})
                continue
        if pre_merge_commands and attempt.get("worktree_path") and Path(attempt["worktree_path"]).is_dir():
            failure = run_pre_merge_commands(Path(attempt["worktree_path"]), pre_merge_commands)
            if failure is not None:
                patch_path = export_failure_patch(repository["repo_path"], ledger.path, attempt)
                extra = {"failure_patch_path": patch_path} if patch_path else {}
                ledger.finish(attempt["node_id"], attempt["attempt_number"], "needs-human",
                              summary=failure, **extra)
                updated.append({"url": attempt["url"], "status": "needs-human", "pr_url": pr_url, "summary": failure})
                continue
        try:
            merge_github_pr(pr_url, merge_method)
        except WatcherError as exc:
            summary = f"automatic PR merge failed ({pr_url}): {exc}"
            ledger.finish(attempt["node_id"], attempt["attempt_number"], "needs-human", summary=summary)
            updated.append({"url": attempt["url"], "status": "needs-human", "pr_url": pr_url, "summary": summary})
            continue
        try:
            close_github_issue(attempt["url"])
        except WatcherError:
            pass
        ledger.finish(
            attempt["node_id"], attempt["attempt_number"], "merged",
            summary=f"PR automatically verified and merged: {pr_url}", merged_at=iso(current),
        )
        try:
            cleanup_attempt(repository["repo_path"], attempt, force=True, orca_cli=orca_cli)
        except WatcherError:
            pass
        command(["git", "-C", str(repository["repo_path"]), "fetch", "origin"])
        updated.append({"url": attempt["url"], "status": "merged", "pr_url": pr_url})
    return updated


def reconcile_workers(
    config: dict[str, Any],
    ledger: Ledger,
    at: dt.datetime | None = None,
) -> list[dict[str, Any]]:
    current = at or now()
    worker_timeout = int(config.get("worker_timeout_seconds", 2700))
    heartbeat_timeout = int(config.get("heartbeat_timeout_seconds", 900))
    max_attempts = int(config.get("max_attempts", ledger.max_attempts))
    completed: list[dict[str, Any]] = []
    for attempt in ledger.active_attempts():
        dispatch_id = attempt.get("orca_dispatch_id")
        if not dispatch_id:
            continue
        try:
            show = orca_call(config, "orchestration", "worker-show", "--dispatch", dispatch_id)
        except WatcherError:
            continue
        state = worker_state(show)
        repository = next((item for item in config["repositories"]
                           if item["repository"] == attempt["repository"]), None)
        if state == "running":
            last_hb_str = attempt.get("last_heartbeat") or attempt.get("lease_started_at")
            try:
                probe = orca_call(config, "orchestration", "worker-read", "--dispatch", dispatch_id,
                                  "--source", "auto", "--limit", "50")
                probe_text = string_content(probe)
                if probe_text:
                    digest = hashlib.sha256(probe_text.encode("utf-8")).hexdigest()
                    if digest != attempt.get("output_digest") or not attempt.get("last_heartbeat"):
                        ledger.heartbeat(attempt["node_id"], attempt["attempt_number"],
                                         at=current, output_digest=digest)
                        last_hb_str = iso(current)
            except WatcherError:
                pass
            started_str = attempt.get("lease_started_at")
            elapsed = (current - parse_time(started_str)).total_seconds() if started_str else 0.0
            silent = (current - parse_time(last_hb_str)).total_seconds() if last_hb_str else elapsed
            timeout_reason: str | None = None
            if worker_timeout > 0 and elapsed > worker_timeout:
                timeout_reason = f"worker exceeded hard timeout of {worker_timeout}s ({int(elapsed)}s elapsed)"
            elif heartbeat_timeout > 0 and silent > heartbeat_timeout:
                timeout_reason = (
                    f"worker heartbeat stalled for {int(silent)}s without new output "
                    f"(limit {heartbeat_timeout}s)"
                )
            if timeout_reason is None:
                continue
            stop_failed: str | None = None
            try:
                orca_call(config, "orchestration", "worker-stop", "--dispatch", dispatch_id)
            except WatcherError as exc:
                stop_failed = str(exc)
            patch_path = (
                export_failure_patch(repository["repo_path"], ledger.path, attempt)
                if repository is not None else None
            )
            extra: dict[str, Any] = {}
            if patch_path:
                extra["failure_patch_path"] = patch_path
            if stop_failed:
                status = "needs-human"
                summary = f"{timeout_reason}; failed to stop Orca worker: {stop_failed}"
            elif int(attempt["attempt_number"]) >= max_attempts:
                status = "needs-human"
                summary = f"{timeout_reason}; worker stopped after reaching max attempts ({max_attempts})"
            else:
                status = "failed"
                summary = f"{timeout_reason}; worker stopped"
            ledger.finish(attempt["node_id"], attempt["attempt_number"], status,
                          summary=summary, **extra)
            if attempt.get("orca_worktree_id"):
                try:
                    orca_call(config, "worktree", "set", "--worktree", f"id:{attempt['orca_worktree_id']}",
                              "--workspace-status", "in-review", "--comment", f"{status}: {summary[:180]}")
                except WatcherError:
                    pass
            if not stop_failed:
                try:
                    orca_call(config, "orchestration", "worker-release", "--dispatch", dispatch_id)
                except WatcherError:
                    pass
            completed.append({"url": attempt["url"], "status": status, "summary": summary,
                              **({"failure_patch_path": patch_path} if patch_path else {})})
            continue
        receipt = None
        receipt_output = ""
        last_error = find_named_string(show, {"lastError", "last_error"})
        if state == "failed" and last_error == "agent_prompt_stalled":
            try:
                output = orca_call(config, "orchestration", "worker-read", "--dispatch", dispatch_id,
                                   "--source", "auto", "--limit", "200")
                receipt_output = string_content(output)
                receipt = parse_receipt(receipt_output)
                if receipt is not None and is_placeholder_receipt(receipt):
                    receipt = None
            except WatcherError:
                continue
            if receipt is None:
                non_placeholder_lines = [
                    line.strip() for line in strip_ansi(receipt_output).splitlines()
                    if line.strip().startswith("AUTOPILOT_RESULT")
                    and "<assigned run ID>" not in line
                ]
                if not non_placeholder_lines:
                    continue
            state = "completed"
        elif state == "failed":
            try:
                output = orca_call(config, "orchestration", "worker-read", "--dispatch", dispatch_id,
                                   "--source", "auto", "--limit", "200")
                receipt_output = string_content(output)
                receipt = parse_receipt(receipt_output)
                if receipt is not None and is_placeholder_receipt(receipt):
                    receipt = None
            except WatcherError:
                receipt = None
            if receipt is not None:
                state = "completed"
        default_fail_summary = (
            f"Orca worker failed ({last_error})" if last_error else "Orca worker failed or stopped"
        )
        status, summary, evidence = "failed", default_fail_summary, {}
        if state == "completed":
            if receipt is None and not receipt_output:
                try:
                    output = orca_call(config, "orchestration", "worker-read", "--dispatch", dispatch_id,
                                       "--source", "auto", "--limit", "200")
                    receipt_output = string_content(output)
                    receipt = parse_receipt(receipt_output)
                    if receipt is not None and is_placeholder_receipt(receipt):
                        receipt = None
                except WatcherError:
                    receipt = None
            if repository is None:
                repository = next(item for item in config["repositories"]
                                  if item["repository"] == attempt["repository"])
            if receipt is None:
                receipt = recover_receipt_from_repair_ledger(repository, attempt)
            status, summary, evidence = verified_receipt(receipt, repository, attempt, output=receipt_output)
        if status == "ready-for-review" and repository is not None:
            publication = config.get("policy", {}).get("publication", "auto-merge")
            if publication in {"pr-only", "auto-merge"}:
                pre_merge_commands = list(config.get("policy", {}).get("pre_merge_commands", []))
                worktree_path = Path(str(attempt["worktree_path"]))
                failure = (
                    run_pre_merge_commands(worktree_path, pre_merge_commands)
                    if pre_merge_commands and worktree_path.is_dir() else None
                )
                if failure is not None:
                    status = "needs-human" if int(attempt["attempt_number"]) >= max_attempts else "failed"
                    summary = failure
                else:
                    merged_attempt = {**attempt, **evidence}
                    try:
                        pr_info = publish_attempt_pr(config, repository, merged_attempt, summary)
                    except WatcherError as exc:
                        status = "needs-human"
                        summary = f"automatic PR publication failed: {exc}"
                    else:
                        status = "pr-open"
                        evidence = {**evidence, **pr_info}
                        summary = f"PR opened ({pr_info['pr_url']}): {summary}"
        if status in {"failed", "needs-human", "blocked"} and repository is not None:
            patch_path = export_failure_patch(repository["repo_path"], ledger.path, attempt)
            if patch_path:
                evidence = {**evidence, "failure_patch_path": patch_path}
        ledger.finish(attempt["node_id"], attempt["attempt_number"], status, summary=summary, **evidence)
        if attempt.get("orca_worktree_id"):
            orca_call(config, "worktree", "set", "--worktree", f"id:{attempt['orca_worktree_id']}",
                      "--workspace-status", "in-review", "--comment", f"{status}: {summary[:180]}")
        orca_call(config, "orchestration", "worker-release", "--dispatch", dispatch_id)
        completed.append({"url": attempt["url"], "status": status, "summary": summary,
                          **({"pr_url": evidence["pr_url"]} if "pr_url" in evidence else {})})
    return completed


def external_dependency_checker() -> Callable[[str, int], bool]:
    cache: dict[tuple[str, int], bool] = {}

    def check(repository: str, issue_number: int) -> bool:
        key = (repository, issue_number)
        if key not in cache:
            url = f"https://github.com/{repository}/issues/{issue_number}"
            try:
                cache[key] = github_issue_state(url) == "CLOSED"
            except WatcherError:
                cache[key] = False
        return cache[key]

    return check


def work_available(config: dict[str, Any], ledger: Ledger, run_id: str) -> list[dict[str, Any]]:
    checker = external_dependency_checker()
    return [dispatch_one(config, ledger, run_id, run)
            for run in ledger.claim_many(config["max_concurrent_workers"],
                                         is_dependency_satisfied=checker)]


def doctor(config: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {"gh": shutil.which("gh") is not None,
        "orca": Path(config["orca"]["cli"]).is_file() and os.access(config["orca"]["cli"], os.X_OK),
        "repositories": []}
    result["gh_auth"] = result["gh"] and command(
        ["gh", "api", "user", "--silent"]
    ).returncode == 0
    result["orca_runtime"] = False
    if result["orca"]:
        try:
            status = orca_call(config, "status")
            result["orca_runtime"] = nested_value(status, ("result", "runtime", "state")) == "ready"
        except WatcherError:
            pass
    for item in config["repositories"]:
        root = command(["git", "-C", str(item["repo_path"]), "rev-parse", "--show-toplevel"])
        check = {"repository": item["repository"], "repo_path": str(item["repo_path"]),
                 "git_root": root.returncode == 0 and Path(root.stdout.strip()).resolve() == item["repo_path"]}
        try:
            repository_metadata(item)
            check["github"] = True
        except WatcherError as exc:
            check["github"], check["error"] = False, str(exc)
        result["repositories"].append(check)
    result["ok"] = bool(result["gh"] and result["gh_auth"] and result["orca"] and result["orca_runtime"]
                        and all(item["git_root"] and item["github"] for item in result["repositories"]))
    return result


def scheduler_enabled(config: dict[str, Any]) -> bool:
    if config.get("schema_version") == 2:
        return True
    scheduler = config["scheduler"]
    response = orca_call(config, "automations", "show", scheduler["automation_id"])
    enabled = nested_value(
        response,
        ("result", "automation", "enabled"),
        ("result", "enabled"),
        ("automation", "enabled"),
        ("enabled",),
    )
    if not isinstance(enabled, bool):
        raise WatcherError("Orca Automation status omitted enabled state")
    return enabled


def runtime_workspace_error(config: dict[str, Any]) -> str | None:
    repository = config["repositories"][0]
    path = Path(repository["repo_path"])
    root = command(["git", "-C", str(path), "rev-parse", "--show-toplevel"])
    if root.returncode or Path(root.stdout.strip()).resolve() != path.resolve():
        return "repository path is missing or is not the configured Git root"
    status = orca_call(config, "status")
    if nested_value(status, ("result", "runtime", "state")) != "ready":
        raise WatcherError("Orca runtime is not ready")
    try:
        orca_call(config, "repo", "show", "--repo", f"path:{path}")
    except WatcherError:
        return "repository is no longer registered in Orca"
    return None


def pause_for_missing_workspace(config: dict[str, Any], reason: str) -> dict[str, Any]:
    scheduler = config.get("scheduler", {})
    identifier = scheduler.get("automation_id")
    if not identifier:
        raise WatcherError("Orca Automation ID is missing")
    orca_call(config, "automations", "edit", identifier, "--disabled")
    return {"status": "paused-missing-workspace", "reason": reason,
            "automation_id": identifier, "state_preserved": True}


def repository_for_issue(config: dict[str, Any], url: str) -> dict[str, Any]:
    repository = next((item for item in config["repositories"]
                       if url.startswith(f"https://github.com/{item['repository']}/issues/")), None)
    if repository is None:
        raise WatcherError("Issue URL does not belong to a configured repository")
    return repository


def parser() -> argparse.ArgumentParser:
    main = argparse.ArgumentParser(description=__doc__)
    commands = main.add_subparsers(dest="command_name", required=True)
    for name in ("doctor", "poll", "work", "once", "run", "status", "retry", "discard", "accept", "prune"):
        sub = commands.add_parser(name)
        sub.add_argument("--config", type=Path, required=True)
        if name in {"retry", "discard", "accept"}:
            sub.add_argument("--issue-url", required=True)
        if name == "retry":
            sub.add_argument("--discard-worktree", action="store_true")
        if name == "accept":
            sub.add_argument("--target-branch", required=True)
        if name == "prune":
            sub.add_argument("--older-than-hours", type=float, default=24.0)
            sub.add_argument("--dry-run", action="store_true")
    return main


def main() -> int:
    args = parser().parse_args()
    try:
        config = load_config(args.config)
        if args.command_name == "doctor":
            result, code = doctor(config), 0
            code = 0 if result["ok"] else 2
        else:
            ledger = Ledger(config["state_db"], config["lease_timeout_seconds"],
                            int(config.get("max_attempts", 2)))
            if args.command_name == "status":
                result, code = ledger.snapshot(), 0
            elif args.command_name == "retry":
                repository = repository_for_issue(config, args.issue_url)
                number = ledger.retry(args.issue_url, repository["repo_path"], args.discard_worktree,
                                      config["orca"]["cli"])
                result, code = {"status": "retry-pending", "url": args.issue_url,
                                "next_attempt": number}, 0
            elif args.command_name == "discard":
                repository = repository_for_issue(config, args.issue_url)
                result, code = ledger.discard(args.issue_url, repository["repo_path"],
                                              config["orca"]["cli"]), 0
            elif args.command_name == "accept":
                repository = repository_for_issue(config, args.issue_url)
                result, code = ledger.accept(args.issue_url, repository["repo_path"], args.target_branch,
                                             config["orca"]["cli"]), 0
            elif args.command_name == "prune":
                repository = config["repositories"][0]
                result, code = ledger.prune(
                    repository["repo_path"], older_than_hours=args.older_than_hours,
                    dry_run=args.dry_run, orca_cli=config["orca"]["cli"],
                ), 0
            elif args.command_name == "poll":
                result, code = poll(config, ledger), 0
            elif args.command_name == "work":
                run_id = ensure_orca_run(config, ledger)
                result, code = {
                    "completed": reconcile_workers(config, ledger),
                    "pull_requests": reconcile_pull_requests(config, ledger),
                    "started": work_available(config, ledger, run_id),
                }, 0
            elif args.command_name == "once":
                run_id = ensure_orca_run(config, ledger)
                result, code = {
                    "detection": poll(config, ledger),
                    "completed": reconcile_workers(config, ledger),
                    "pull_requests": reconcile_pull_requests(config, ledger),
                }, 0
                result["started"] = work_available(config, ledger, run_id)
            else:
                run_id = None
                code = 0
                while True:
                    missing = runtime_workspace_error(config)
                    if missing:
                        result = pause_for_missing_workspace(config, missing)
                        break
                    try:
                        active_scheduler = scheduler_enabled(config)
                    except WatcherError as exc:
                        result = {"status": "scheduler-unavailable", "error": str(exc)}
                        code = 2
                        break
                    if not active_scheduler:
                        result = {"status": "scheduler-paused"}
                        break
                    try:
                        run_id = run_id or ensure_orca_run(config, ledger)
                        value = {
                            "detection": poll(config, ledger),
                            "completed": reconcile_workers(config, ledger),
                            "pull_requests": reconcile_pull_requests(config, ledger),
                        }
                        value["started"] = work_available(config, ledger, run_id)
                        print(json.dumps(value, ensure_ascii=False), flush=True)
                    except (WatcherError, OSError, ValueError, json.JSONDecodeError, sqlite3.Error) as exc:
                        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False),
                              file=sys.stderr, flush=True)
                    time.sleep(config["poll_interval_seconds"])
    except (WatcherError, OSError, ValueError, json.JSONDecodeError, sqlite3.Error) as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
