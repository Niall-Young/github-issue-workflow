from __future__ import annotations

import hashlib
import importlib.machinery
import importlib.util
import io
import json
import shutil
import subprocess
import tarfile
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
            (fake_src / "orca-plugin.json").write_text('{"version": "0.2.1"}\n')
            (fake_src / "orca-plugin" / "src" / "tui" / "app.ts").write_text("// tui\n")
            (fake_src / "scripts").mkdir(parents=True)
            shutil.copy2(SCRIPT_PATH, fake_src / "scripts" / "orca-autopilot")
            for skill in self.mod.MANAGED_SKILLS:
                (fake_src / skill).mkdir(parents=True)
                (fake_src / skill / "SKILL.md").write_text(f"# {skill}\n")

            dest = self.mod.install_standalone_files(source_root=fake_src, install_dir=install_dir)
            shutil.rmtree(fake_src)

            self.assertEqual(dest, install_dir.resolve())
            self.assertTrue((dest / "orca-plugin.json").is_file())
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

    def test_fetch_latest_release_bundle_verifies_sha256_and_extracts(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            tar_buf = io.BytesIO()
            with tarfile.open(fileobj=tar_buf, mode="w:gz") as tar:
                manifest_bytes = b'{"version": "0.9.0"}\n'
                info = tarfile.TarInfo("github-issue-workflow-full-v0.9.0/orca-plugin.json")
                info.size = len(manifest_bytes)
                tar.addfile(info, io.BytesIO(manifest_bytes))
            archive_bytes = tar_buf.getvalue()
            sha = hashlib.sha256(archive_bytes).hexdigest()
            archive_name = "github-issue-workflow-full-v0.9.0.tar.gz"
            checksum_name = f"{archive_name}.sha256"

            release_json = json.dumps({
                "tag_name": "v0.9.0",
                "assets": [
                    {"name": archive_name, "browser_download_url": f"https://example.test/{archive_name}"},
                    {"name": checksum_name, "browser_download_url": f"https://example.test/{checksum_name}"},
                ],
            }).encode("utf-8")

            def fake_fetcher(url: str) -> bytes:
                if url.endswith("/releases/latest"):
                    return release_json
                if url.endswith(archive_name):
                    return archive_bytes
                if url.endswith(checksum_name):
                    return f"{sha}  {archive_name}\n".encode("utf-8")
                raise AssertionError(f"Unexpected URL: {url}")

            extracted, tag = self.mod.fetch_latest_release_bundle(tmp_path, fetcher=fake_fetcher)
            self.assertEqual(tag, "v0.9.0")
            self.assertTrue((extracted / "orca-plugin.json").is_file())
            self.assertEqual(self.mod.read_installed_version(extracted), "0.9.0")

            # Tampered checksum must fail
            def bad_fetcher(url: str) -> bytes:
                if url.endswith(checksum_name):
                    return f"{'0' * 64}  {archive_name}\n".encode("utf-8")
                return fake_fetcher(url)

            with self.assertRaises(RuntimeError) as ctx:
                self.mod.fetch_latest_release_bundle(tmp_path / "bad", fetcher=bad_fetcher)
            self.assertIn("SHA-256", str(ctx.exception))

    def test_update_from_local_checkout_syncs_files_skills_and_refreshes_runtimes(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            install_dir = tmp_path / "share"
            bin_dir = tmp_path / "bin"
            skills_dir = tmp_path / "skills"
            rc = self.mod.main([
                "update",
                "--from",
                str(REPO_ROOT),
                "--install-dir",
                str(install_dir),
                "--bin-dir",
                str(bin_dir),
                "--skills-dir",
                str(skills_dir),
                "--no-plugin",
                "--no-refresh-runtimes",
            ])
            self.assertEqual(rc, 0)
            self.assertTrue((install_dir / "orca-plugin.json").is_file())
            self.assertTrue((bin_dir / "orca-autopilot").is_symlink())
            self.assertTrue((skills_dir / "github-issue-autopilot" / "SKILL.md").is_file())

    def test_refresh_installed_runtimes_invokes_admin_script(self):
        calls = []

        def fake_runner(cmd, cwd=None):
            calls.append(cmd)
            return make_proc(0, json.dumps({
                "status": "refreshed",
                "installations": 2,
                "repositories": ["a/b", "c/d"],
            }))

        result = self.mod.refresh_installed_runtimes(REPO_ROOT, runner=fake_runner)
        self.assertEqual(result["installations"], 2)
        self.assertEqual(len(calls), 1)
        self.assertIn("refresh-runtimes", calls[0])
        self.assertIn("--all", calls[0])


if __name__ == "__main__":
    unittest.main()
