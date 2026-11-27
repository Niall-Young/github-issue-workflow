from __future__ import annotations

import hashlib
import importlib.machinery
import importlib.util
import io
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

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
                if link.is_symlink():
                    self.assertEqual(link.resolve(), SCRIPT_PATH.resolve())
                else:
                    self.assertEqual(os.name, "nt")
                    self.assertTrue(link.is_file())
                    self.assertTrue(link.with_suffix(".cmd").is_file())

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
            self.assertTrue(Path(cmd[1]).as_posix().endswith("orca-plugin/src/tui/app.ts"))
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
            self.assertTrue(
                (bin_dir / "orca-autopilot").is_symlink()
                or (os.name == "nt" and (bin_dir / "orca-autopilot").is_file())
            )
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

    def test_http_get_bytes_uses_gh_auth_token_only_for_api_github(self):
        captured_requests = []

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self):
                return b'{"tag_name": "v0.9.0"}'

        def fake_urlopen(req, timeout=30):
            captured_requests.append((req.full_url, dict(req.header_items())))
            return FakeResponse()

        env = {k: v for k, v in os.environ.items() if k not in ("GITHUB_TOKEN", "GH_TOKEN")}
        with mock.patch.dict(os.environ, env, clear=True), \
             mock.patch.object(self.mod.shutil, "which", return_value="/usr/local/bin/gh"), \
             mock.patch.object(
                 self.mod.subprocess,
                 "run",
                 return_value=make_proc(0, stdout="gho_secret_token_123\n"),
             ) as run_mock, \
             mock.patch.object(self.mod.urllib.request, "urlopen", side_effect=fake_urlopen):
            self.mod._http_get_bytes("https://api.github.com/repos/Niall-Young/orca-autopilot/releases/latest")
            self.mod._http_get_bytes("https://github.com/Niall-Young/orca-autopilot/releases/download/v0.9.0/file.tar.gz")
            self.mod._http_get_bytes("https://objects.githubusercontent.com/some-asset")

        self.assertEqual(run_mock.call_count, 1)
        self.assertEqual(run_mock.call_args.args[0], ["/usr/local/bin/gh", "auth", "token"])
        self.assertEqual(run_mock.call_args.kwargs.get("timeout"), 10)

        api_headers = {k.lower(): v for k, v in captured_requests[0][1].items()}
        gh_web_headers = {k.lower(): v for k, v in captured_requests[1][1].items()}
        obj_headers = {k.lower(): v for k, v in captured_requests[2][1].items()}
        self.assertEqual(api_headers.get("authorization"), "Bearer gho_secret_token_123")
        self.assertNotIn("authorization", gh_web_headers)
        self.assertNotIn("authorization", obj_headers)

    def test_http_get_bytes_prefers_env_tokens_without_invoking_gh(self):
        captured_headers = []

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self):
                return b"{}"

        def fake_urlopen(req, timeout=30):
            captured_headers.append({k.lower(): v for k, v in req.header_items()})
            return FakeResponse()

        for env_key, env_val in (("GITHUB_TOKEN", "env_github_tok"), ("GH_TOKEN", "env_gh_tok")):
            env = {k: v for k, v in os.environ.items() if k not in ("GITHUB_TOKEN", "GH_TOKEN")}
            env[env_key] = env_val
            with mock.patch.dict(os.environ, env, clear=True), \
                 mock.patch.object(self.mod.subprocess, "run") as run_mock, \
                 mock.patch.object(self.mod.urllib.request, "urlopen", side_effect=fake_urlopen):
                self.mod._http_get_bytes("https://api.github.com/repos/Niall-Young/orca-autopilot/releases/latest")
                run_mock.assert_not_called()
            self.assertEqual(captured_headers[-1].get("authorization"), f"Bearer {env_val}")

    def test_http_get_bytes_degrades_gracefully_when_gh_missing_unauthenticated_or_timeout(self):
        captured_headers = []

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self):
                return b"{}"

        def fake_urlopen(req, timeout=30):
            captured_headers.append({k.lower(): v for k, v in req.header_items()})
            return FakeResponse()

        env = {k: v for k, v in os.environ.items() if k not in ("GITHUB_TOKEN", "GH_TOKEN")}

        # Case 1: gh not installed
        with mock.patch.dict(os.environ, env, clear=True), \
             mock.patch.object(self.mod.shutil, "which", return_value=None), \
             mock.patch.object(self.mod.urllib.request, "urlopen", side_effect=fake_urlopen):
            self.mod._http_get_bytes("https://api.github.com/repos/Niall-Young/orca-autopilot/releases/latest")
        self.assertNotIn("authorization", captured_headers[-1])

        # Case 2: gh auth token returns non-zero (not logged in)
        with mock.patch.dict(os.environ, env, clear=True), \
             mock.patch.object(self.mod.shutil, "which", return_value="/usr/local/bin/gh"), \
             mock.patch.object(self.mod.subprocess, "run", return_value=make_proc(1, stderr="not logged in")), \
             mock.patch.object(self.mod.urllib.request, "urlopen", side_effect=fake_urlopen):
            self.mod._http_get_bytes("https://api.github.com/repos/Niall-Young/orca-autopilot/releases/latest")
        self.assertNotIn("authorization", captured_headers[-1])

        # Case 3: gh auth token times out
        with mock.patch.dict(os.environ, env, clear=True), \
             mock.patch.object(self.mod.shutil, "which", return_value="/usr/local/bin/gh"), \
             mock.patch.object(
                 self.mod.subprocess,
                 "run",
                 side_effect=subprocess.TimeoutExpired(cmd=["gh", "auth", "token"], timeout=10),
             ), \
             mock.patch.object(self.mod.urllib.request, "urlopen", side_effect=fake_urlopen):
            self.mod._http_get_bytes("https://api.github.com/repos/Niall-Young/orca-autopilot/releases/latest")
        self.assertNotIn("authorization", captured_headers[-1])

    def test_http_get_bytes_403_rate_limit_error_is_actionable_and_hides_token(self):
        secret = "gho_super_secret_should_never_leak"
        err = urllib.error.HTTPError(
            url="https://api.github.com/repos/Niall-Young/orca-autopilot/releases/latest",
            code=403,
            msg="rate limit exceeded",
            hdrs={},
            fp=None,
        )
        env = {k: v for k, v in os.environ.items() if k not in ("GITHUB_TOKEN", "GH_TOKEN")}
        env["GITHUB_TOKEN"] = secret
        with mock.patch.dict(os.environ, env, clear=True), \
             mock.patch.object(self.mod.urllib.request, "urlopen", side_effect=err):
            with self.assertRaises(RuntimeError) as ctx:
                self.mod._http_get_bytes("https://api.github.com/repos/Niall-Young/orca-autopilot/releases/latest")
        message = str(ctx.exception)
        self.assertIn("gh auth login", message)
        self.assertIn("GITHUB_TOKEN", message)
        self.assertNotIn(secret, message)

    def test_fetch_latest_release_bundle_falls_back_to_https_redirect_on_403_with_sha256(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            tar_buf = io.BytesIO()
            with tarfile.open(fileobj=tar_buf, mode="w:gz") as tar:
                manifest_bytes = b'{"version": "0.9.1"}\n'
                info = tarfile.TarInfo("github-issue-workflow-full-v0.9.1/orca-plugin.json")
                info.size = len(manifest_bytes)
                tar.addfile(info, io.BytesIO(manifest_bytes))
            archive_bytes = tar_buf.getvalue()
            sha = hashlib.sha256(archive_bytes).hexdigest()
            archive_name = "github-issue-workflow-full-v0.9.1.tar.gz"
            checksum_name = f"{archive_name}.sha256"

            requested_urls = []

            def fake_fetcher(url: str) -> bytes:
                requested_urls.append(url)
                if url.startswith("https://api.github.com/"):
                    raise RuntimeError(f"下载失败（{url}）：HTTP Error 403: rate limit exceeded")
                if url == f"https://github.com/Niall-Young/orca-autopilot/releases/download/v0.9.1/{archive_name}":
                    return archive_bytes
                if url == f"https://github.com/Niall-Young/orca-autopilot/releases/download/v0.9.1/{checksum_name}":
                    return f"{sha}  {archive_name}\n".encode("utf-8")
                raise AssertionError(f"Unexpected URL: {url}")

            extracted, tag = self.mod.fetch_latest_release_bundle(
                tmp_path,
                fetcher=fake_fetcher,
                latest_tag_resolver=lambda repo: "v0.9.1",
            )
            self.assertEqual(tag, "v0.9.1")
            self.assertTrue((extracted / "orca-plugin.json").is_file())
            self.assertEqual(self.mod.read_installed_version(extracted), "0.9.1")
            self.assertTrue(all(u.startswith("https://") for u in requested_urls))

            # Fallback failure must still produce actionable 403 guidance
            with self.assertRaises(RuntimeError) as ctx:
                self.mod.fetch_latest_release_bundle(
                    tmp_path / "fail",
                    fetcher=fake_fetcher,
                    latest_tag_resolver=lambda repo: (_ for _ in ()).throw(RuntimeError("network down")),
                )
            self.assertIn("gh auth login", str(ctx.exception))
            self.assertIn("GITHUB_TOKEN", str(ctx.exception))

    def test_resolve_latest_release_tag_via_redirect_enforces_https_github(self):
        class FakeOpener:
            def __init__(self, location: str):
                self.location = location

            def open(self, req, timeout=30):
                raise urllib.error.HTTPError(
                    url=req.full_url,
                    code=302,
                    msg="Found",
                    hdrs={"Location": self.location},
                    fp=None,
                )

        with mock.patch.object(
            self.mod.urllib.request,
            "build_opener",
            return_value=FakeOpener("https://github.com/Niall-Young/orca-autopilot/releases/tag/v0.9.2"),
        ):
            tag = self.mod._resolve_latest_release_tag_via_redirect("Niall-Young/orca-autopilot")
            self.assertEqual(tag, "v0.9.2")

        with mock.patch.object(
            self.mod.urllib.request,
            "build_opener",
            return_value=FakeOpener("http://github.com/Niall-Young/orca-autopilot/releases/tag/v0.9.2"),
        ):
            with self.assertRaises(RuntimeError):
                self.mod._resolve_latest_release_tag_via_redirect("Niall-Young/orca-autopilot")

    def test_build_tui_command_forwards_custom_title(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "demo-repo"
            repo.mkdir()

            cmd = self.mod.build_tui_command(
                repo,
                runner=lambda *a, **kw: make_proc(0, str(repo) + "\n"),
                which=lambda name: "/usr/local/bin/bun" if name == "bun" else None,
                title="  我的看板  ",
            )
            self.assertEqual(cmd[-2:], ["--title", "我的看板"])

            args = self.mod.parse_args(["--title", "控制台 A"])
            self.assertEqual(args.title, "控制台 A")


if __name__ == "__main__":
    unittest.main()
