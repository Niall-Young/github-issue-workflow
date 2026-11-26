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

    def test_build_tui_command_prefers_bun_and_resolves_git_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "demo-repo"
            sub = repo / "src"
            sub.mkdir(parents=True)

            def fake_runner(cmd, cwd=None):
                if cmd == ["git", "rev-parse", "--show-toplevel"]:
                    return make_proc(0, str(repo) + "\n")
                return make_proc(1)

            cmd = self.mod.build_tui_command(
                sub,
                runner=fake_runner,
                which=lambda name: "/usr/local/bin/bun" if name == "bun" else None,
            )
            self.assertEqual(cmd[0], "/usr/local/bin/bun")
            self.assertTrue(cmd[1].endswith("orca-plugin/src/tui/app.ts"))
            self.assertEqual(cmd[2], str(repo.resolve()))

    def test_build_tui_command_falls_back_to_node(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "demo-repo"
            repo.mkdir()
            cmd = self.mod.build_tui_command(
                repo,
                runner=lambda cmd, cwd=None: make_proc(1),
                which=lambda name: "/opt/homebrew/bin/node" if name == "node" else None,
            )
            self.assertEqual(cmd[0], "/opt/homebrew/bin/node")
            self.assertEqual(cmd[2], str(repo.resolve()))

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
        self.assertIn(
            "orca plugin enable local.issue-board --approve ap1-deadbeef1234",
            str(ctx.exception),
        )


if __name__ == "__main__":
    unittest.main()
