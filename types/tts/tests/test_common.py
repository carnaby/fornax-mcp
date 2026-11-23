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
    def test_every_pin_is_a_size_and_a_sha256(self):
        for files in (common.OMNIVOICE_FILES, common.PIPER_FILES):
            for rel, (size, sha) in files.items():
                self.assertGreater(size, 0, rel)
                self.assertRegex(sha, r"^[0-9a-f]{64}$", rel)
                self.assertNotIn(chr(92), rel)

    def test_the_urls_name_the_pinned_revisions(self):
        self.assertIn(common.OMNIVOICE_REVISION, common.OMNIVOICE_URL)
        self.assertTrue(common.OMNIVOICE_URL.endswith("/"))
        self.assertIn(common.PIPER_REVISION, common.PIPER_URL)
        self.assertTrue(common.PIPER_URL.endswith("/sk/sk_SK/lili/medium/"))
        self.assertEqual(sorted(common.PIPER_FILES), ["sk_SK-lili-medium.onnx", "sk_SK-lili-medium.onnx.json"])
        self.assertEqual(len(common.OMNIVOICE_FILES), 8)

    def test_everything_lives_inside_the_pack(self):
        for path in (common.ENV, common.MODELS_DIR, common.OMNIVOICE_DIR, common.PIPER_DIR, common.UV_VENV, common.PYTHON_DIR, common.UV_CACHE):
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
        files = {"sub/a.bin": (4, "0" * 64), "b.bin": (4, "0" * 64), "c.bin": (1, "0" * 64)}
        problems = common.file_problems(self.dir, files)
        self.assertEqual(len(problems), 2)
        self.assertIn("b.bin", problems[0])
        self.assertIn("2 bytes, not 4", problems[0])
        self.assertIn("c.bin is missing", problems[1])

    def test_voice_problems(self):
        self.assertEqual(common.voice_problems(common.VOICES_DIR), [])
        self.assertRegex(common.voice_problems(self.dir)[0], r"voices\.json .* cannot be read")
        (self.dir / "voices.json").write_text(json.dumps({"x": {"file": "x.wav", "text": "t"}}), encoding="utf-8")
        self.assertEqual(common.voice_problems(self.dir), [f"the voice x has no x.wav in {self.dir}"])

    def test_voice_problems_of_one_voice(self):
        (self.dir / "voices.json").write_text(json.dumps({"x": {"file": "x.wav", "text": "t"}, "y": {"file": "y.wav", "text": "t"}}), encoding="utf-8")
        (self.dir / "x.wav").write_bytes(b"RIFF")
        self.assertEqual(common.voice_problems(self.dir, ["x"]), [])
        self.assertEqual(common.voice_problems(self.dir, ["y"]), [f"the voice y has no y.wav in {self.dir}"])
        self.assertEqual(common.voice_problems(self.dir), [f"the voice y has no y.wav in {self.dir}"])

    def test_voice_problems_of_a_voices_json_of_the_wrong_shape(self):
        for content, problems in (([1], [f"voices.json in {self.dir} does not hold an object of voices"]),
                                  ({"x": ["x.wav"]}, ["the voice x in voices.json needs a file and a text"]),
                                  ({"x": {"file": 1, "text": "t"}}, ["the voice x in voices.json needs a file and a text"]),
                                  ({"x": {"file": "", "text": "t"}}, ["the voice x in voices.json needs a file and a text"])):
            (self.dir / "voices.json").write_text(json.dumps(content), encoding="utf-8")
            with self.subTest(content=content):
                self.assertEqual(common.voice_problems(self.dir), problems)

    def test_setup_streams_leaves_a_stream_it_cannot_reconfigure(self):
        with mock.patch.object(sys, "stdout", io.StringIO()), mock.patch.object(sys, "stderr", io.StringIO()):
            common.setup_streams()

    def test_progress_is_one_json_line_clamped_to_0_and_1(self):
        out = io.StringIO()
        with redirect_stdout(out):
            common.progress(1.7, "chunk 3/2")
        self.assertEqual(json.loads(out.getvalue()), {"progress": 1.0, "message": "chunk 3/2"})


if __name__ == "__main__":
    unittest.main()
