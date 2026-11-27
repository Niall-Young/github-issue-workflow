# Autopilot configuration

For normal Orca setup, run the idempotent administrator from the installed Skill:

```sh
python3 scripts/autopilot_admin.py install \
  --repo-path /absolute/repository/root \
  --agent codex \
  --allow-agent claude
```

It creates the missing `agent-ready` GitHub label, a repository-specific state directory under `~/.local/state/github-issue-autopilot/`, a native Orca Automation, and an untracked marker in the Git common directory. The GUI Automation checks every three minutes and invokes an Agent only when the visible `Issue Autopilot Coordinator` terminal needs recovery. That terminal owns polling and supervised worker dispatch; no hidden Agent CLI fallback is permitted.

`--agent` is the repository default. Each `--allow-agent ID` adds an agent that an Issue may select with one `agent:ID` label. No agent label uses the default; exactly one label overrides it; conflicting, disallowed, or unavailable choices stop visibly at `needs-human`.

Version 3 has this shape:

```json
{
  "schema_version": 3,
  "state_db": "/Users/me/.local/state/github-issue-autopilot/state.sqlite3",
  "poll_interval_seconds": 180,
  "lease_timeout_seconds": 3000,
  "worker_timeout_seconds": 2700,
  "heartbeat_timeout_seconds": 900,
  "max_attempts": 2,
  "max_concurrent_workers": 3,
  "policy": {
    "scope_approval": "eligible-issue",
    "publication": "auto-merge",
    "merge_method": "squash",
    "pre_merge_commands": [],
    "require_ci": true,
    "sync_local_branch": true,
    "max_conflict_resolutions": 2,
    "worker_mode": "standard",
    "max_risk": "medium"
  },
  "repositories": [
    {
      "repository": "owner/repo",
      "repository_id": "R_kgDOExample",
      "repo_path": "/absolute/path/to/local/clone",
      "author": "@me",
      "labels": ["agent-ready"]
    }
  ],
  "orca": {
    "cli": "/Users/me/.local/bin/orca",
    "default_agent": "codex",
    "allowed_agents": ["codex", "claude"],
    "setup": "run"
  },
  "scheduler": {
    "backend": "orca-automation",
    "automation_id": "generated-by-orca",
    "name": "Issue Autopilot · owner/repo · stable-key",
    "trigger": "*/3 * * * *",
    "provider": "codex",
    "workspace_mode": "existing",
    "session_mode": "fresh",
    "precheck_timeout_seconds": 60,
    "missed_run_grace_minutes": 5
  }
}
```

`author` is required, and `@me` resolves through the authenticated GitHub CLI. Every poll scans the current open Issues that match the configured author and all intake labels, including matching Issues created before installation. Immutable Issue node IDs in the SQLite ledger keep active, review-ready, and human-stopped work idempotent. A failed attempt is requeued when the same Issue remains open and eligible, up to `max_attempts` total automatic attempts; the default is two. Explicit `retry` remains available beyond that automatic limit. Existing configurations may retain `activate_after` as ignored compatibility metadata. `repository_id` is optional but recommended to detect a renamed or transferred repository.

`max_concurrent_workers` accepts 1–3. Polling records every eligible Issue and parses same-repository dependency declarations (`Blocked by: #123`, `Depends on: #123`, `前置依赖: #123`) from the Issue body; the coordinator skips any Issue whose dependencies are not yet `merged` or `accepted` locally or `CLOSED` on GitHub, and blocks dependency cycles visibly instead of deadlocking. The coordinator starts only the available number of Orca workers and fills a free slot on a later cycle. Orca is the source of truth for Task, Dispatch, agent terminal, worktree lineage, comments, and workspace status. SQLite (schema v5) stores immutable Issue node IDs, dependency lists, attempt history, heartbeats, failure patch paths, PR numbers/URLs, merge timestamps, and those Orca IDs for recovery.

After a worker finishes self-testing and independent review and emits a verified `AUTOPILOT_RESULT`, `policy.publication` controls the handoff:

- `auto-merge` (default): the coordinator runs any configured `policy.pre_merge_commands`, pushes the branch, opens a GitHub PR (`pr-open`), monitors GitHub PR status checks (`require_ci: true`) and mergeability, and automatically merges the PR (`merge_method`: `squash` / `merge` / `rebase`), closes the Issue, cleans up the worktree, deterministically fast-forwards the local base branch (`sync_local_branch: true`, 0 AI tokens; safely skips if dirty or diverged and catches up once clean), and marks the Issue `merged` (immediately unblocking dependent Issues). To prevent remote/local divergence while developing directly on the local base branch, auto-merge is automatically deferred (keeping the PR `pr-open`) whenever an active local direct-dev lock (`<git-common-dir>/autopilot-local-dev.lock.json`) exists or the local base branch is dirty or ahead of `origin`. When an open PR becomes `CONFLICTING`/`DIRTY`, the coordinator first tries a clean merge of the latest base branch in the existing worktree and otherwise automatically queues a bounded conflict-resolution worker (up to `policy.max_conflict_resolutions`, default `2`; `0` disables) that resolves conflicts, verifies tests, and updates the existing PR branch in place. CI failures or conflicts remaining after exhausting `max_conflict_resolutions` stop visibly at `needs-human` with a `.patch` archive instead of force-merging.
- `pr-only`: pushes the branch and opens the PR (`pr-open`), leaving merging to a human.
- `never`: stops at local `ready-for-review` for manual `accept`.

`policy.worker_mode` selects the worker execution profile:

- `standard` (default): invokes `$github-issue-repair` with full repair-ledger state transitions and an independent fresh-context reviewer.
- `lite`: runs a single-session worker in the isolated worktree without a separate reviewer subagent or repair-ledger ceremony, cutting per-Issue token usage while preserving worktree isolation, test execution, clean commit checks, and deterministic PR/auto-merge handling.

Manual `accept` remains available for `publication: "never"` workflows; `retry`, `discard`, and `prune` remain available in all modes.

During reconciliation, each `running` worker's recent output is hashed to refresh `last_heartbeat`. If a worker exceeds `worker_timeout_seconds` (default 2700s / 45m) or produces no new output for `heartbeat_timeout_seconds` (default 900s / 15m; `0` disables stall detection), the coordinator stops and releases the Orca Dispatch, exports any uncommitted or committed worktree diff to `<state_dir>/patches/issue-<num>-attempt-<n>.patch`, and records `failed` (retryable while below `max_attempts`) or `needs-human` (once `max_attempts` is exhausted or if stopping the worker fails). Failed, human-stopped, and blocked runs also archive their local diff patch automatically. Use `autopilot_admin.py prune --older-than-hours 24 [--dry-run]` to safely remove stale `failed`/`discarded`/`rejected` worktrees after confirming no live worker and preserving their patch archives.

Workers run in visible `new-child` worktrees under the configured Orca project. They update comments at investigation, implementation, and verification checkpoints. A successful worker sends Orca `worker_done` and leaves one `AUTOPILOT_RESULT` in its final transcript. The watcher reads the preserved worker transcript and independently validates the worktree, branch, repair ledger, and base/head SHAs before marking it `ready-for-review`.

Every attempt must receive a fresh Orca Task ID, Dispatch ID, worktree ID, and absolute worktree path that have never appeared in another historical attempt or Issue. The ledger rejects identity reuse before recording the new dispatch. An already-ledgered failed Issue may continue through the bounded automatic retry; an abandoned or unsatisfactory review result continues only through explicit `retry` (or finishes through `accept`). Standalone repairs, manual `git worktree` creation, shared worktrees, manual merges, and ledger backfills are not substitutes. Missing or malformed worker completion receipts are retryable failures; Orca identity conflicts, unverifiable success evidence, and explicit requests for judgment stop visibly at `needs-human` without a fallback.

Successful worktrees remain `in-review` until explicit acceptance. Accepting requires a clean, explicitly named target branch, merges without pushing, and closes the exact configured GitHub Issue only after the merge succeeds. If a repair was merged manually and its worktree is gone, acceptance continues only when Git proves the recorded reviewed head is already an ancestor of the checked-out target. The command reads the Issue back as closed before recording acceptance or cleaning the worktree; a closure failure remains retryable. Retrying with `--discard-worktree` removes only the exact recorded Orca worktree after its Dispatch is no longer live. Automated publication remains fixed to `never`.

The scheduler fields are installer-owned safety settings. Pausing and resuming in Orca's GUI is supported; changing the trigger, provider, workspace, prompt, or precheck makes `doctor` report configuration drift. See [`orca-automation.md`](orca-automation.md) for migration, recovery, and pause behavior.

## Repository removal and uninstall

List every active installation before removing a checkout:

```sh
python3 scripts/autopilot_admin.py list
python3 scripts/autopilot_admin.py stop --repository owner/repo
```

`list`, `stop`, and `uninstall` can select by `--repo-path`, `--repository owner/repo`, or immutable `--repository-id`. The name and ID selectors read the repository-isolated configuration under `~/.local/state/github-issue-autopilot/`, so they still work after the checkout path is gone.

If the precheck or running coordinator finds that the path is missing, is no longer the exact Git root, or is no longer registered in Orca, it disables the Automation and returns `paused-missing-workspace`. This is a fail-safe pause: the SQLite ledger, logs, branches, and worktrees are preserved.

Settle every outstanding result before uninstalling. `accept` keeps a reviewed result; `discard` explicitly abandons one attempt after proving that neither its local PID nor its Orca Dispatch is live. `discard` removes only the recorded worktree when present and records a terminal `discarded` state; it does not queue another attempt.

```sh
python3 scripts/autopilot_admin.py discard \
  --repo-path /absolute/repository/root \
  --issue-url https://github.com/owner/repo/issues/123

python3 scripts/autopilot_admin.py uninstall --repository-id R_kgDOExample
```

`uninstall` pauses first and refuses queued, claimed, running, retry-pending, review-ready, or human-action attempts. A failed or blocked attempt also blocks while its recorded worktree still exists. After the gate passes, the command exports Orca Automation run history, removes the Automation and Git marker, and atomically moves configuration, SQLite, logs, and runtime copies to `~/.local/state/github-issue-autopilot/archives/`. It never deletes the local repository.
