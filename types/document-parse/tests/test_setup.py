import contextlib
import hashlib
import http.client
import importlib.util
import io
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import setup  # noqa: E402


def sha(data):
    return hashlib.sha256(data).hexdigest()


class FilesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.content = {"docling/config.json": b"{}", "paddleocr-vl/model.safetensors": b"weights"}
        self.files = {rel: (f"https://example.com/m/{rel}", len(data), sha(data)) for rel, data in self.content.items()}
        self.fetched = []

    def tearDown(self):
        self.tmp.cleanup()

    def fetch(self, url, dest):
        self.fetched.append(url)
        Path(dest).write_bytes(self.content[url.split("/m/", 1)[1]])

    def test_downloaded_into_subfolders_checked_and_kept(self):
        setup.ensure_files(self.dir, self.files, self.fetch)
        self.assertEqual(sorted(self.fetched), ["https://example.com/m/docling/config.json", "https://example.com/m/paddleocr-vl/model.safetensors"])
        self.assertEqual((self.dir / "paddleocr-vl" / "model.safetensors").read_bytes(), b"weights")
        setup.ensure_files(self.dir, self.files, self.fetch)
        self.assertEqual(len(self.fetched), 2)

    def test_a_changed_file_is_downloaded_again(self):
        setup.ensure_files(self.dir, self.files, self.fetch)
        (self.dir / "docling" / "config.json").write_bytes(b"[]")
        setup.ensure_files(self.dir, self.files, self.fetch)
        self.assertEqual(self.fetched.count("https://example.com/m/docling/config.json"), 2)
        self.assertEqual((self.dir / "docling" / "config.json").read_bytes(), b"{}")

    def test_a_damaged_download_is_removed(self):
        def bad_fetch(url, dest):
            Path(dest).write_bytes(b"truncated")

        with self.assertRaisesRegex(setup.SetupError, r"^the download of docling/config\.json does not match its pinned size and sha256: run the setup again$"):
            setup.ensure_files(self.dir, self.files, bad_fetch)
        self.assertEqual(list(self.dir.rglob("*.part")), [])

    def test_a_download_that_fails_names_its_url(self):
        def gone(url, dest):
            Path(dest).write_bytes(b"partial")
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, io.BytesIO())

        with self.assertRaisesRegex(setup.SetupError, r"^https://example\.com/m/docling/config\.json cannot be downloaded \(HTTP Error 404: Not Found\): run the setup again$"):
            setup.ensure_files(self.dir, self.files, gone)
        self.assertEqual(list(self.dir.rglob("*.part")), [])

    def test_a_download_that_breaks_off_names_its_url(self):
        for error, what in ((TimeoutError("timed out"), r"TimeoutError: timed out"),
                            (http.client.IncompleteRead(b"abc", 10), r"IncompleteRead: .*")):
            def broken(url, dest, error=error):
                Path(dest).write_bytes(b"partial")
                raise error

            with self.subTest(error=type(error).__name__), self.assertRaisesRegex(
                    setup.SetupError, r"^the download of https://example\.com/m/docling/config\.json broke off \(" + what + r"\): run the setup again$"):
                setup.ensure_files(self.dir, self.files, broken)
            self.assertEqual(list(self.dir.rglob("*.part")), [])

    def test_a_local_error_while_downloading_is_not_a_download_that_broke_off(self):
        def full(url, dest):
            Path(dest).write_bytes(b"partial")
            raise OSError(28, "No space left on device")

        with self.assertRaisesRegex(OSError, r"No space left on device") as raised:
            setup.ensure_files(self.dir, self.files, full)
        self.assertNotIsInstance(raised.exception, setup.SetupError)
        self.assertEqual(list(self.dir.rglob("*.part")), [])


class BootstrapTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def venv(self, *flags):
        target = self.dir / "uv"
        subprocess.run([sys.executable, "-m", "venv", *flags, str(target)], check=True, capture_output=True)
        return target

    def test_no_venv_is_not_ready(self):
        self.assertFalse(setup.bootstrap_ok(self.dir / "uv"))

    def test_a_venv_without_pip_is_not_ready(self):
        self.assertFalse(setup.bootstrap_ok(self.venv("--without-pip")))

    @unittest.skipUnless(importlib.util.find_spec("pip"), "the Python running the tests has no pip")
    def test_a_venv_that_runs_pip_is_ready(self):
        self.assertTrue(setup.bootstrap_ok(self.venv("--without-pip", "--system-site-packages")))


class PythonInstallTest(unittest.TestCase):
    def test_nothing_outside_the_pack_and_no_registry_flag_off_windows(self):
        calls = []

        class Stop(Exception):
            pass

        def step(cmd, what, env=None):
            calls.append([str(c) for c in cmd])
            raise Stop()

        saved = setup.step
        setup.step = step
        try:
            with self.assertRaises(Stop):
                setup.ensure_python(Path("uv"))
        finally:
            setup.step = saved
        self.assertIn("3.12.16", calls[0])
        self.assertIn("--no-bin", calls[0])
        self.assertEqual("--no-registry" in calls[0], os.name == "nt")


class MainTest(unittest.TestCase):
    def test_a_broken_off_download_ends_in_one_sentence(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        saved = {name: getattr(setup, name) for name in ("ENV", "UV_CACHE", "setup_streams", "ensure_uv")}

        def broken():
            raise http.client.IncompleteRead(b"abc", 10)

        setup.ENV = Path(tmp.name) / "env"
        setup.UV_CACHE = setup.ENV / ".uv-cache"
        setup.setup_streams = lambda: None
        setup.ensure_uv = broken
        err, out = io.StringIO(), io.StringIO()
        try:
            with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out), self.assertRaises(SystemExit) as ended:
                setup.main()
        finally:
            for name, value in saved.items():
                setattr(setup, name, value)
        self.assertEqual(ended.exception.code, 1)
        lines = err.getvalue().splitlines()
        self.assertEqual(len(lines), 1, lines)
        self.assertRegex(lines[0], r"^setup: a download broke off \(IncompleteRead: .*\): run the setup again$")


if __name__ == "__main__":
    unittest.main()
