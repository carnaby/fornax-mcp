import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PACK_SRC = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PACK_SRC / "scripts"))

import common  # noqa: E402  (only for the names of the pinned files)

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

FAKE_TRANSFORMERS = '''import os
if os.environ.get("STUB_NO_PADDLE") != "1":
    class PaddleOCRVLForConditionalGeneration:
        pass
'''

# check.py compares the files' sizes with the pins: the wrapper pins the fake files' 4 bytes instead.
WRAPPER = '''import sys
sys.path.insert(0, {scripts!r})
import common
common.MODEL_FILES = {{rel: (url, 4, sha) for rel, (url, size, sha) in common.MODEL_FILES.items()}}
import check
sys.exit(check.main(sys.argv[1:]))
'''


class CheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        pack = self.root / "pack"
        shutil.copytree(PACK_SRC / "scripts", pack / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
        for rel in common.MODEL_FILES:
            path = pack / "env" / "models" / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"fake")
        self.pack = pack
        self.libs = self.root / "libs"
        for name in ("torch", "transformers", "docling", "rapidocr", "pypdfium2"):
            (self.libs / name).mkdir(parents=True)
            (self.libs / name / "__init__.py").write_text("", encoding="utf-8")
        (self.libs / "torch" / "__init__.py").write_text(FAKE_TORCH, encoding="utf-8")
        (self.libs / "transformers" / "__init__.py").write_text(FAKE_TRANSFORMERS, encoding="utf-8")
        (self.root / "wrap_check.py").write_text(WRAPPER.format(scripts=str(pack / "scripts")), encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def check(self, **env):
        r = subprocess.run([sys.executable, str(self.root / "wrap_check.py")],
                           env=dict(os.environ, PYTHONPATH=str(self.libs), PYTHONDONTWRITEBYTECODE="1", **env),
                           capture_output=True, text=True, encoding="utf-8", timeout=120)
        return r.returncode, r.stdout, r.stderr

    def test_ready(self):
        code, out, err = self.check()
        self.assertEqual(code, 0, err)
        lines = out.strip().splitlines()
        self.assertRegex(lines[0], r"^Python \S+, PyTorch 0\.0-fake \(CUDA 12\.8\), docling \S+, transformers \S+, rapidocr \S+; Fake GPU$")
        self.assertRegex(lines[-1], r"^fornax-environment: PyTorch 0\.0-fake \(CUDA 12\.8\), docling \S+, transformers \S+, rapidocr \S+; Fake GPU$")

    def test_a_missing_model_file(self):
        (self.pack / "env" / "models" / "paddleocr-vl" / "model.safetensors").unlink()
        code, _, err = self.check()
        self.assertEqual(code, 3)
        self.assertRegex(err.strip(), r"^document-parse: paddleocr-vl/model\.safetensors is missing in .*: run fornax types setup document-parse$")

    def test_a_missing_library(self):
        shutil.rmtree(self.libs / "rapidocr")
        code, _, err = self.check()
        self.assertEqual(code, 3)
        self.assertEqual(err.strip(), "document-parse: rapidocr is not installed in this pack: run fornax types setup document-parse")

    def test_no_cuda(self):
        code, _, err = self.check(STUB_NO_CUDA="1")
        self.assertEqual(code, 3)
        self.assertEqual(err.strip(), "document-parse: PyTorch sees no CUDA device: install or update the NVIDIA driver")

    def test_transformers_without_paddleocr_vl(self):
        code, _, err = self.check(STUB_NO_PADDLE="1")
        self.assertEqual(code, 3)
        self.assertRegex(err.strip(), r"^document-parse: transformers \S+ has no PaddleOCR-VL \(AttributeError\): run fornax types setup document-parse$")


if __name__ == "__main__":
    unittest.main()
