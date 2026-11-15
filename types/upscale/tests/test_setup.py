import hashlib
import os
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import setup  # noqa: E402


def sha(data):
    return hashlib.sha256(data).hexdigest()


class SourceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.zip = self.dir / "upstream.zip"
        with zipfile.ZipFile(self.zip, "w") as z:
            z.writestr("Repo-abc/", "")
            z.writestr("Repo-abc/inference_cli.py", "print('cli')")
            z.writestr("Repo-abc/src/utils/x.py", "x = 1")
        self.zip_sha = sha(self.zip.read_bytes())
        self.fetched = []

    def tearDown(self):
        self.tmp.cleanup()

    def fetch(self, url, dest):
        self.fetched.append(url)
        shutil.copyfile(self.zip, dest)

    def test_extracts_without_the_archives_root_and_keeps_it_on_a_second_run(self):
        dest = self.dir / "env" / "seedvr2"
        dest.parent.mkdir()
        setup.ensure_source(dest, self.fetch, url="https://example.com/a.zip", sha256=self.zip_sha)
        self.assertEqual((dest / "inference_cli.py").read_text(), "print('cli')")
        self.assertTrue((dest / "src" / "utils" / "x.py").is_file())
        self.assertFalse((dest.parent / "seedvr2.zip.part").exists())
        setup.ensure_source(dest, self.fetch, url="https://example.com/a.zip", sha256=self.zip_sha)
        self.assertEqual(self.fetched, ["https://example.com/a.zip"])

    def test_a_changed_archive_installs_nothing(self):
        dest = self.dir / "env" / "seedvr2"
        dest.parent.mkdir()
        with self.assertRaisesRegex(setup.SetupError, r"not the pinned"):
            setup.ensure_source(dest, self.fetch, url="https://example.com/a.zip", sha256="0" * 64)
        self.assertFalse(dest.exists())
        self.assertFalse((dest.parent / "seedvr2.zip.part").exists())

    def test_a_member_outside_the_folder_is_refused(self):
        bad = self.dir / "bad.zip"
        with zipfile.ZipFile(bad, "w") as z:
            z.writestr("Repo-abc/../../evil.py", "x")
        with self.assertRaises(setup.SetupError):
            setup.extract_stripped(bad, self.dir / "out")
        self.assertFalse((self.dir / "evil.py").exists())


class ModelsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.content = {"dit.safetensors": b"dit weights", "vae.safetensors": b"vae"}
        self.models = {name: (len(data), sha(data)) for name, data in self.content.items()}
        self.fetched = []

    def tearDown(self):
        self.tmp.cleanup()

    def fetch(self, url, dest):
        self.fetched.append(url)
        Path(dest).write_bytes(self.content[url.rsplit("/", 1)[1]])

    def test_from_a_folder_they_are_linked(self):
        source = self.dir / "existing"
        source.mkdir()
        for name, data in self.content.items():
            (source / name).write_bytes(data)
        target = self.dir / "models"
        setup.ensure_models(target, str(source), self.fetch, models=self.models, base_url="https://example.com/")
        self.assertEqual(self.fetched, [])
        for name in self.content:
            self.assertTrue(os.path.samefile(source / name, target / name), name)

    def test_a_wrong_file_in_the_folder_is_refused(self):
        source = self.dir / "existing"
        source.mkdir()
        (source / "dit.safetensors").write_bytes(b"dit weightz")
        (source / "vae.safetensors").write_bytes(b"vae")
        with self.assertRaisesRegex(setup.SetupError, r"dit\.safetensors is not the pinned"):
            setup.ensure_models(self.dir / "models", str(source), self.fetch, models=self.models, base_url="https://example.com/")
        (source / "dit.safetensors").unlink()
        with self.assertRaisesRegex(setup.SetupError, r"is missing"):
            setup.ensure_models(self.dir / "models", str(source), self.fetch, models=self.models, base_url="https://example.com/")

    def test_downloaded_checked_and_kept(self):
        target = self.dir / "models"
        setup.ensure_models(target, None, self.fetch, models=self.models, base_url="https://example.com/m/")
        self.assertEqual(sorted(self.fetched), ["https://example.com/m/dit.safetensors", "https://example.com/m/vae.safetensors"])
        setup.ensure_models(target, None, self.fetch, models=self.models, base_url="https://example.com/m/")
        self.assertEqual(len(self.fetched), 2)

    def test_a_damaged_download_is_removed(self):
        def bad_fetch(url, dest):
            Path(dest).write_bytes(b"truncated")

        with self.assertRaisesRegex(setup.SetupError, r"does not match"):
            setup.ensure_models(self.dir / "models", None, bad_fetch, models=self.models, base_url="https://example.com/")
        self.assertEqual(list((self.dir / "models").glob("*.part")), [])

    def test_copy_when_a_link_is_not_possible(self):
        source = self.dir / "a.bin"
        source.write_bytes(b"data")
        dest = self.dir / "b.bin"
        real_link = os.link
        try:
            def no_link(*args):
                raise OSError("cross-device link")

            os.link = no_link
            setup.link_or_copy(source, dest)
        finally:
            os.link = real_link
        self.assertEqual(dest.read_bytes(), b"data")
        self.assertFalse(os.path.samefile(source, dest))


if __name__ == "__main__":
    unittest.main()
