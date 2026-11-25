import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

PACK_SRC = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PACK_SRC / "scripts"))

import check  # noqa: E402
import common  # noqa: E402  (only for the names of the pinned files)

FFMPEG = shutil.which("ffmpeg")

FAKE_TORCH = '''import os
__version__ = "0.0-fake"


class version:
    cuda = "12.8"


class cuda:
    @staticmethod
    def is_available():
        return os.environ.get("STUB_NO_CUDA") != "1"

    @staticmethod
    def get_device_name(index=0):
        return "Fake GPU"
'''

# check.py compares the files' sizes with the pins: the wrapper pins the fake files' 4 bytes instead.
WRAPPER = '''import sys
sys.path.insert(0, {scripts!r})
import common
common.OMNIVOICE_FILES = {{rel: (4, sha) for rel, (size, sha) in common.OMNIVOICE_FILES.items()}}
common.PIPER_FILES = {{rel: (4, sha) for rel, (size, sha) in common.PIPER_FILES.items()}}
import check
sys.exit(check.main(sys.argv[1:]))
'''


@unittest.skipUnless(FFMPEG, "ffmpeg is not on PATH")
class CheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        pack = self.root / "pack"
        shutil.copytree(PACK_SRC / "scripts", pack / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copytree(PACK_SRC / "voices", pack / "voices")
        for folder, files in (("omnivoice", common.OMNIVOICE_FILES), ("piper", common.PIPER_FILES)):
            for rel in files:
                path = pack / "env" / "models" / folder / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"fake")
        self.pack = pack
        libs = self.root / "libs"
        for name in ("torch", "omnivoice", "piper"):
            (libs / name).mkdir(parents=True)
        (libs / "torch" / "__init__.py").write_text(FAKE_TORCH, encoding="utf-8")
        (libs / "omnivoice" / "__init__.py").write_text("", encoding="utf-8")
        (libs / "piper" / "__init__.py").write_text("", encoding="utf-8")
        (self.root / "wrap_check.py").write_text(WRAPPER.format(scripts=str(pack / "scripts")), encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def check(self, ffmpeg=None, **env):
        r = subprocess.run([sys.executable, str(self.root / "wrap_check.py"), "--ffmpeg", ffmpeg or FFMPEG],
                           env=dict(os.environ, PYTHONPATH=str(self.root / "libs"), PYTHONDONTWRITEBYTECODE="1", **env),
                           capture_output=True, text=True, encoding="utf-8", timeout=120)
        return r.returncode, r.stdout, r.stderr

    def test_ready(self):
        code, out, err = self.check()
        self.assertEqual(code, 0, err)
        lines = out.strip().splitlines()
        self.assertRegex(lines[0], r"^Python \S+, PyTorch 0\.0-fake \(CUDA 12\.8\), omnivoice \S+, piper-tts \S+, ffmpeg \S+; Fake GPU$")
        self.assertRegex(lines[-1], r"^fornax-environment: PyTorch 0\.0-fake \(CUDA 12\.8\), omnivoice \S+, piper-tts \S+, ffmpeg \S+; Fake GPU$")

    def test_a_missing_model_file(self):
        (self.pack / "env" / "models" / "omnivoice" / "model.safetensors").unlink()
        code, _, err = self.check()
        self.assertEqual(code, 3)
        self.assertRegex(err.strip(), r"^tts: model\.safetensors is missing in .*: run fornax types setup tts$")

    def test_a_missing_voice(self):
        (self.pack / "voices" / "peter.wav").unlink()
        code, _, err = self.check()
        self.assertEqual(code, 3)
        self.assertIn("the voice peter has no peter.wav", err)

    def test_no_cuda(self):
        code, _, err = self.check(STUB_NO_CUDA="1")
        self.assertEqual(code, 3)
        self.assertEqual(err.strip(), "tts: PyTorch sees no CUDA device: install or update the NVIDIA driver")

    def test_ffmpeg_that_does_not_run(self):
        code, _, err = self.check(ffmpeg=str(self.root / "no-ffmpeg"))
        self.assertEqual(code, 3)
        self.assertEqual(err.strip(), "tts: ffmpeg does not run: check tools.ffmpeg in worker.yaml")


class FfmpegVersionTest(unittest.TestCase):
    def version_of(self, stdout, returncode=0):
        done = subprocess.CompletedProcess(["ffmpeg", "-version"], returncode, stdout=stdout, stderr="")
        with mock.patch.object(check.subprocess, "run", return_value=done):
            return check.ffmpeg_version("ffmpeg")

    def test_the_version_word_of_the_first_line_that_says_something(self):
        self.assertEqual(self.version_of("ffmpeg version 9.0.2-full Copyright (c) 2000-2026\nbuilt with gcc\n"), "9.0.2-full")
        self.assertEqual(self.version_of("\n  \nffmpeg version 9.0.2-full Copyright\n"), "9.0.2-full")
        self.assertEqual(self.version_of("\nsome wrapper 1.0\n"), "some wrapper 1.0")
        self.assertEqual(self.version_of(""), "?")
        self.assertIsNone(self.version_of("ffmpeg version 9", returncode=1))


if __name__ == "__main__":
    unittest.main()
