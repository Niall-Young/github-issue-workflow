from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = REPO_ROOT / "scripts" / "orca-board"


def load_orca_board_module():
    loader = importlib.machinery.SourceFileLoader("orca_board_cli", str(SCRIPT_PATH))
    spec = importlib.util.spec_from_loader("orca_board_cli", loader)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_proc(returncode: int = 0, stdout: str = "", stderr: str = ""):
    return subprocess.CompletedProcess(
        args=[],
        returncode=returncode,
        stdout=stdout,
        stderr=stderr,
    )


class OrcaBoardCliTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_orca_board_module()

    def test_install_cli_creates_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir = Path(tmp) / "bin"
            installed = self.mod.install_cli(bin_dir=bin_dir, script_path=SCRIPT_PATH)
            self.assertEqual([p.name for p in installed], ["orca-board", "issue-board"])
            for link in installed:
                self.assertTrue(link.is_symlink())
                self.assertEqual(link.resolve(), SCRIPT_PATH.resolve())

    def test_ensure_anchor_file_creates_payload_and_excludes_in_git(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "demo-repo"
            repo.mkdir()
            exclude = repo / ".git" / "info" / "exclude"

            def fake_runner(cmd, cwd=None):
                if cmd[:3] == ["git", "remote", "get-url"]:
                    return make_proc(0, "git@github.com:acme/demo-repo.git\n")
                if cmd[:3] == ["git", "rev-parse", "--git-path"]:
                    return make_proc(0, str(exclude) + "\n")
                return make_proc(1)

            anchor = self.mod.ensure_anchor_file(repo, runner=fake_runner)
            self.assertTrue(anchor.exists())
            payload = json.loads(anchor.read_text(encoding="utf-8"))
            self.assertEqual(payload["repository"], "acme/demo-repo")
            self.assertEqual(payload["projectName"], "demo-repo")
            self.assertIn(".orca-board.issue-board", exclude.read_text(encoding="utf-8").splitlines())

    def test_ensure_plugin_ready_approves_interactively_when_pending(self):
        calls = []

        def fake_runner(cmd, cwd=None):
            calls.append(cmd)
            if cmd == ["orca", "plugin", "list", "--json"]:
                return make_proc(
                    0,
                    json.dumps(
                        {
                            "ok": True,
                            "result": {
                                "plugins": [
                                    {
                                        "pluginKey": "local.issue-board",
                                        "status": "pending",
                                        "needsReconsent": True,
                                    }
                                ]
                            },
                        }
                    ),
                )
            if cmd == ["orca", "plugin", "enable", "local.issue-board"]:
                return make_proc(
                    1,
                    stderr="Fingerprint: ap1-deadbeef1234\nNext step: approve",
                )
            if cmd == [
                "orca",
                "plugin",
                "enable",
                "local.issue-board",
                "--approve",
                "ap1-deadbeef1234",
            ]:
                return make_proc(0, "enabled")
            raise AssertionError(f"Unexpected command: {cmd}")

        key = self.mod.ensure_plugin_ready(
            runner=fake_runner,
            is_tty=True,
            input_fn=lambda _: "",
        )
        self.assertEqual(key, "local.issue-board")
        self.assertIn(
            ["orca", "plugin", "enable", "local.issue-board", "--approve", "ap1-deadbeef1234"],
            calls,
        )

    def test_ensure_plugin_ready_rejects_noninteractive_without_approval(self):
        def fake_runner(cmd, cwd=None):
            if cmd == ["orca", "plugin", "list", "--json"]:
                return make_proc(
                    0,
                    json.dumps(
                        {
                            "ok": True,
                            "result": {
                                "plugins": [
                                    {
                                        "pluginKey": "local.issue-board",
                                        "status": "pending",
                                        "needsReconsent": True,
                                    }
                                ]
                            },
                        }
                    ),
                )
            if cmd == ["orca", "plugin", "enable", "local.issue-board"]:
                return make_proc(1, stderr="Fingerprint: ap1-deadbeef1234\n")
            raise AssertionError(f"Unexpected command: {cmd}")

        with self.assertRaises(RuntimeError) as ctx:
            self.mod.ensure_plugin_ready(runner=fake_runner, is_tty=False)
        self.assertIn("orca plugin enable local.issue-board --approve ap1-deadbeef1234", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
