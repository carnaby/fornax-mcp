import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from fakes import make_pack, set_card

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")


@unittest.skipUnless(FFMPEG and FFPROBE, "ffmpeg and ffprobe are not on PATH")
class CheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.pack = make_pack(self.root, {})

    def tearDown(self):
        self.tmp.cleanup()

    def check(self, **env):
        r = subprocess.run([sys.executable, str(self.root / "wrap_check.py"), "--ffmpeg", FFMPEG, "--ffprobe", FFPROBE], env=dict(os.environ, PYTHONPATH=str(self.root), PYTHONDONTWRITEBYTECODE="1", **env), capture_output=True, text=True, encoding="utf-8", timeout=120)
        return r.returncode, r.stdout + r.stderr

    def test_ready(self):
        code, text = self.check()
        self.assertEqual(code, 0, text)
        self.assertIn("Fake GPU 0: 16311 MiB, 1100 in use", text)

    def test_two_gpus_are_refused(self):
        set_card(self.root, 1100, gpus=2)
        code, text = self.check()
        self.assertEqual(code, 3, text)
        self.assertIn("more than one GPU is not supported yet", text)

    def test_no_cuda(self):
        code, text = self.check(STUB_NO_CUDA="1")
        self.assertEqual(code, 3, text)
        self.assertIn("PyTorch sees no CUDA device", text)

    def test_missing_seedvr2_and_a_wrong_model(self):
        (self.pack / "env" / "models" / "ema_vae_fp16.safetensors").write_bytes(b"12345")
        code, text = self.check()
        self.assertEqual(code, 3, text)
        self.assertIn("model ema_vae_fp16.safetensors has 5 bytes, not 4", text)
        (self.pack / "env" / "models" / "ema_vae_fp16.safetensors").write_bytes(b"1234")
        (self.pack / "env" / "seedvr2" / "inference_cli.py").unlink()
        code, text = self.check()
        self.assertEqual(code, 3, text)
        self.assertIn("SeedVR2 is not installed in this pack", text)


if __name__ == "__main__":
    unittest.main()
