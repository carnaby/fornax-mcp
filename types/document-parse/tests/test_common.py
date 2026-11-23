import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import common  # noqa: E402


class PinsTest(unittest.TestCase):
    def test_every_pin_is_a_url_a_size_and_a_sha256(self):
        for rel, (url, size, sha) in common.MODEL_FILES.items():
            self.assertTrue(url.startswith("https://"), rel)
            self.assertTrue(url.endswith(rel.rsplit("/", 1)[-1]), rel)
            self.assertGreater(size, 0, rel)
            self.assertRegex(sha, r"^[0-9a-f]{64}$", rel)
            self.assertNotIn(chr(92), rel)

    def test_the_files_docling_and_paddleocr_need(self):
        paddle = sorted(rel for rel in common.MODEL_FILES if rel.startswith("paddleocr-vl/"))
        self.assertEqual(len(paddle), 11)
        self.assertIn("paddleocr-vl/model.safetensors", paddle)
        for rel in paddle:
            self.assertIn(common.PADDLE_REVISION, common.MODEL_FILES[rel][0])
        docling = sorted(rel for rel in common.MODEL_FILES if rel.startswith("docling/"))
        self.assertEqual(docling, [
            "docling/RapidOcr/PP-OCRv6_det_small.onnx",
            "docling/RapidOcr/PP-OCRv6_rec_small.onnx",
            "docling/RapidOcr/ch_ppocr_mobile_v2.0_cls_mobile.onnx",
            "docling/docling-project--docling-layout-heron/config.json",
            "docling/docling-project--docling-layout-heron/model.safetensors",
            "docling/docling-project--docling-layout-heron/preprocessor_config.json",
            "docling/docling-project--docling-models/config.json",
            "docling/docling-project--docling-models/model_artifacts/tableformer/accurate/tableformer_accurate.safetensors",
            "docling/docling-project--docling-models/model_artifacts/tableformer/accurate/tm_config.json",
        ])
        self.assertEqual(common.DOCLING_DIR, common.MODELS_DIR / "docling")
        self.assertEqual(common.PADDLE_DIR, common.MODELS_DIR / "paddleocr-vl")

    def test_everything_lives_inside_the_pack(self):
        for path in (common.ENV, common.MODELS_DIR, common.DOCLING_DIR, common.PADDLE_DIR, common.UV_VENV, common.PYTHON_DIR, common.UV_CACHE):
            self.assertTrue(path.is_relative_to(common.PACK), path)
        for value in common.library_env().values():
            if value not in ("1", "utf-8"):
                self.assertTrue(Path(value).is_relative_to(common.ENV), value)
        self.assertEqual(common.library_env()["HF_HUB_OFFLINE"], "1")


class HelpersTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_file_problems_names_missing_and_wrong_sized_files(self):
        (self.dir / "sub").mkdir()
        (self.dir / "sub" / "a.bin").write_bytes(b"abcd")
        (self.dir / "b.bin").write_bytes(b"ab")
        files = {"sub/a.bin": ("https://x/a.bin", 4, "0" * 64), "b.bin": ("https://x/b.bin", 4, "0" * 64), "c.bin": ("https://x/c.bin", 1, "0" * 64)}
        problems = common.file_problems(self.dir, files)
        self.assertEqual(len(problems), 2)
        self.assertIn("b.bin", problems[0])
        self.assertIn("2 bytes, not 4", problems[0])
        self.assertIn("c.bin is missing", problems[1])

    def test_model_problems_reads_the_pins_through_the_module(self):
        files = {"paddleocr-vl/x.bin": ("https://x/x.bin", 3, "0" * 64), "docling/y.bin": ("https://x/y.bin", 3, "0" * 64)}
        (self.dir / "paddleocr-vl").mkdir()
        (self.dir / "paddleocr-vl" / "x.bin").write_bytes(b"abc")
        with mock.patch.object(common, "MODELS_DIR", self.dir), mock.patch.object(common, "MODEL_FILES", files):
            self.assertEqual(common.model_problems("paddleocr-vl/"), [])
            self.assertEqual(len(common.model_problems("docling/")), 1)
            self.assertEqual(len(common.model_problems("")), 1)

    def test_progress_is_one_json_line_clamped_to_0_and_1(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            common.progress(1.7, "page 1/1")
            common.progress(-1, "start")
        lines = [json.loads(line) for line in buf.getvalue().splitlines()]
        self.assertEqual(lines, [{"progress": 1.0, "message": "page 1/1"}, {"progress": 0.0, "message": "start"}])

    def test_setup_streams_leaves_a_stream_it_cannot_reconfigure(self):
        with mock.patch.object(sys, "stdout", io.StringIO()), mock.patch.object(sys, "stderr", io.StringIO()):
            common.setup_streams()


if __name__ == "__main__":
    unittest.main()
