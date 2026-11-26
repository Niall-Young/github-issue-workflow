from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = REPO_ROOT / "scripts" / "orca-autopilot"


def load_orca_autopilot_module():
    loader = importlib.machinery.SourceFileLoader("orca_autopilot_cli", str(SCRIPT_PATH))
    spec = importlib.util.spec_from_loader("orca_autopilot_cli", loader)
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


class OrcaAutopilotCliTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_orca_autopilot_module()

    def test_install_cli_creates_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir = Path(tmp) / "bin"
            installed = self.mod.install_cli(bin_dir=bin_dir, script_path=SCRIPT_PATH)
            self.assertEqual([p.name for p in installed], ["orca-autopilot", "orca-board"])
            for link in installed:
                self.assertTrue(link.is_symlink())
                self.assertEqual(link.resolve(), SCRIPT_PATH.resolve())

    def test_install_standalone_files_survives_source_deletion(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            fake_src = tmp_path / "source-checkout"
            install_dir = tmp_path / "installed"
            (fake_src / "orca-plugin" / "src" / "tui").mkdir(parents=True)
            (fake_src / "orca-plugin" / "orca-plugin.json").write_text('{"version": "0.2.1"}\n')
            (fake_src / "orca-plugin" / "src" / "tui" / "app.ts").write_text("// tui\n")
            (fake_src / "scripts").mkdir(parents=True)
            shutil.copy2(SCRIPT_PATH, fake_src / "scripts" / "orca-autopilot")
            for skill in self.mod.MANAGED_SKILLS:
                (fake_src / skill).mkdir(parents=True)
                (fake_src / skill / "SKILL.md").write_text(f"# {skill}\n")

            dest = self.mod.install_standalone_files(source_root=fake_src, install_dir=install_dir)
            shutil.rmtree(fake_src)

            self.assertEqual(dest, install_dir.resolve())
            self.assertTrue((dest / "orca-plugin" / "orca-plugin.json").is_file())
            self.assertTrue((dest / "orca-plugin" / "src" / "tui" / "app.ts").is_file())
            self.assertTrue((dest / "scripts" / "orca-autopilot").is_file())
            for skill in self.mod.MANAGED_SKILLS:
                self.assertTrue((dest / skill / "SKILL.md").is_file())

    def test_detect_and_install_skills_into_detected_agent_runtimes(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake_home = Path(tmp) / "home"
            (fake_home / ".claude").mkdir(parents=True)
            (fake_home / ".codex").mkdir(parents=True)
            detected = self.mod.detect_skill_dirs(home=fake_home)
            self.assertEqual(
                detected,
                [fake_home / ".claude" / "skills", fake_home / ".codex" / "skills"],
            )

            installed = self.mod.install_skills(source_root=REPO_ROOT, home=fake_home)
            self.assertEqual(set(installed.keys()), set(detected))
            for skill_root in detected:
                for skill in self.mod.MANAGED_SKILLS:
                    self.assertTrue((skill_root / skill / "SKILL.md").is_file())

    def test_detect_skill_dirs_falls_back_to_agents_skills(self):
        with tempfile.TemporaryDirectory() as tmp:
            empty_home = Path(tmp) / "empty-home"
            empty_home.mkdir()
            self.assertEqual(
                self.mod.detect_skill_dirs(home=empty_home),
                [empty_home / ".agents" / "skills"],
            )

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

    def test_ensure_plugin_ready_installs_standalone_and_unloads_prior_dev_plugin(self):
        calls = []
        state = {
            "plugin": {
                "pluginKey": "local.issue-autopilot",
                "isDev": True,
                "version": "0.2.1",
                "status": "running",
            }
        }

        def runner(cmd, cwd=None):
            calls.append(cmd)
            if cmd == ["orca", "plugin", "list", "--json"]:
                plugins = [state["plugin"]] if state["plugin"] else []
                return make_proc(0, json.dumps({"result": {"plugins": plugins}}))
            if cmd == ["orca", "plugin", "dev", "unload", "local.issue-autopilot"]:
                state["plugin"] = None
                return make_proc(0)
            if cmd == ["orca", "plugin", "install", str(self.mod.PLUGIN_DIR)]:
                return make_proc(1, stderr="Re-run with --approve ap1-standalone1234\n")
            if cmd == [
                "orca",
                "plugin",
                "install",
                str(self.mod.PLUGIN_DIR),
                "--approve",
                "ap1-standalone1234",
            ]:
                state["plugin"] = {
                    "pluginKey": "local.issue-autopilot",
                    "isDev": False,
                    "version": "0.2.1",
                    "status": "running",
                }
                return make_proc(0)
            raise AssertionError(f"Unexpected command: {cmd}")

        key = self.mod.ensure_plugin_ready(
            runner=runner,
            is_tty=True,
            input_fn=lambda _: "",
            dev_mode=False,
        )
        self.assertEqual(key, "local.issue-autopilot")
        self.assertIn(["orca", "plugin", "dev", "unload", "local.issue-autopilot"], calls)
        self.assertIn(
            ["orca", "plugin", "install", str(self.mod.PLUGIN_DIR), "--approve", "ap1-standalone1234"],
            calls,
        )

    def test_dev_mode_loads_bundled_plugin_over_older_dev_version(self):
        bundled = json.loads((self.mod.PLUGIN_DIR / "orca-plugin.json").read_text())["version"]
        plugin = {"pluginKey": "local.issue-autopilot", "isDev": True,
                  "version": "0.0.1", "status": "running"}

        def runner(cmd, cwd=None):
            if cmd == ["orca", "plugin", "list", "--json"]:
                return make_proc(0, json.dumps({"result": {"plugins": [plugin]}}))
            self.assertEqual(cmd, ["orca", "plugin", "dev", "load", str(self.mod.PLUGIN_DIR)])
            plugin["version"] = bundled
            return make_proc()

        self.assertEqual(
            self.mod.ensure_plugin_ready(runner=runner, dev_mode=True),
            "local.issue-autopilot",
        )
        self.assertEqual(plugin["version"], bundled)

    def test_ensure_plugin_ready_approves_interactively_when_pending_in_dev_mode(self):
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
                                        "pluginKey": "local.issue-autopilot",
                                        "status": "pending",
                                        "needsReconsent": True,
                                    }
                                ]
                            },
                        }
                    ),
                )
            if cmd == ["orca", "plugin", "enable", "local.issue-autopilot"]:
                return make_proc(
                    1,
                    stderr="Fingerprint: ap1-deadbeef1234\nNext step: approve",
                )
            if cmd == [
                "orca",
                "plugin",
                "enable",
                "local.issue-autopilot",
                "--approve",
                "ap1-deadbeef1234",
            ]:
                return make_proc(0, "enabled")
            raise AssertionError(f"Unexpected command: {cmd}")

        key = self.mod.ensure_plugin_ready(
            runner=fake_runner,
            is_tty=True,
            input_fn=lambda _: "",
            dev_mode=True,
        )
        self.assertEqual(key, "local.issue-autopilot")
        self.assertIn(
            ["orca", "plugin", "enable", "local.issue-autopilot", "--approve", "ap1-deadbeef1234"],
            calls,
        )

    def test_ensure_plugin_ready_rejects_noninteractive_without_approval(self):
        def fake_runner(cmd, cwd=None):
            if cmd == ["orca", "plugin", "list", "--json"]:
                return make_proc(0, json.dumps({"ok": True, "result": {"plugins": []}}))
            if cmd == ["orca", "plugin", "install", str(self.mod.PLUGIN_DIR)]:
                return make_proc(1, stderr="Fingerprint: ap1-deadbeef1234\n")
            raise AssertionError(f"Unexpected command: {cmd}")

        with self.assertRaises(RuntimeError) as ctx:
            self.mod.ensure_plugin_ready(runner=fake_runner, is_tty=False, dev_mode=False)
        self.assertIn(
            f"orca plugin install {self.mod.PLUGIN_DIR} --approve ap1-deadbeef1234",
            str(ctx.exception),
        )


if __name__ == "__main__":
    unittest.main()
