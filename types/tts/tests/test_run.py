import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from fakes import SECONDS_PER_CHAR, calls, make_pack

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
NL = chr(10)


def last_line(log):
    """The worker reports a failed job by the last non-empty line of its log."""
    return [line for line in log.splitlines() if line.strip()][-1]


class RunCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.out = self.root / "out"
        self.work = self.root / "work"
        self.out.mkdir()
        self.work.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def text_file(self, content, name="text_file.md"):
        folder = self.root / "in"
        folder.mkdir(exist_ok=True)
        path = folder / name
        path.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))
        return path

    def run_job(self, params, text_file=None, behavior=None, ffmpeg=None, raw_params=None, out=None):
        make_pack(self.root, behavior)
        text = raw_params if raw_params is not None else json.dumps(params)
        (self.work / "params.json").write_text(text, encoding="utf-8")
        argv = [sys.executable, str(self.root / "wrap_run.py"), "--params", str(self.work / "params.json"),
                "--text-file", str(text_file) if text_file else "", "--ffmpeg", ffmpeg or FFMPEG or "ffmpeg",
                "--out", str(out or self.out), "--work", str(self.work)]
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        r = subprocess.run(argv, env=env, capture_output=True, text=True, encoding="utf-8", timeout=180)
        return r.returncode, r.stdout, r.stderr

    def outputs(self):
        return sorted(p.name for p in self.out.iterdir())


class RejectTest(RunCase):
    """Rejections come before ffmpeg starts: they need no ffmpeg."""

    def test_both_texts(self):
        code, _, err = self.run_job({"text": "Ahoj."}, self.text_file("Ahoj."), ffmpeg="no-ffmpeg")
        self.assertEqual(code, 2)
        self.assertEqual(last_line(err), "tts: give the text parameter or a text_file, not both")

    def test_no_text(self):
        code, _, err = self.run_job({}, ffmpeg="no-ffmpeg")
        self.assertEqual(code, 2)
        self.assertTrue(last_line(err).endswith("neither was given"), err)

    def test_a_voice_of_another_model(self):
        code, _, err = self.run_job({"text": "Ahoj.", "model": "piper", "voice": "peter"}, ffmpeg="no-ffmpeg")
        self.assertEqual(code, 2)
        self.assertEqual(last_line(err), "tts: piper has no voice peter; its voices: lili")

    def test_a_file_that_is_not_utf8_and_one_with_only_code(self):
        code, _, err = self.run_job({}, self.text_file("Ďateľ".encode("cp1250"), "text_file.txt"), ffmpeg="no-ffmpeg")
        self.assertEqual((code, last_line(err)), (2, "tts: the text file is not UTF-8; save it as UTF-8"))
        code, _, err = self.run_job({}, self.text_file(NL.join(["```", "x = 1", "```"])), ffmpeg="no-ffmpeg")
        self.assertEqual((code, last_line(err)), (2, "tts: there is nothing to speak: the text is empty without its Markdown marks"))

    def test_over_the_limit(self):
        code, _, err = self.run_job({}, self.text_file("a" * 50_001, "text_file.txt"), ffmpeg="no-ffmpeg")
        self.assertEqual(code, 2)
        self.assertIn("split the text into several jobs", last_line(err))

    def test_a_missing_model_is_exit_3_and_a_broken_one_exit_1(self):
        code, _, err = self.run_job({"text": "Ahoj.", "model": "omnivoice"}, behavior={"mode": "unavailable"}, ffmpeg="no-ffmpeg")
        self.assertEqual((code, last_line(err)), (3, "tts: model.safetensors is missing in env/models/omnivoice: run fornax types setup tts"))
        code, _, err = self.run_job({"text": "Ahoj.", "model": "omnivoice"}, behavior={"mode": "load-error"}, ffmpeg="no-ffmpeg")
        self.assertEqual(code, 1)
        self.assertEqual(last_line(err), "tts: the omnivoice model did not load (RuntimeError: the weights are broken)")

    def test_a_model_that_runs_out_of_memory_while_loading_is_exit_1(self):
        code, _, err = self.run_job({"text": "Ahoj.", "model": "omnivoice"}, behavior={"mode": "load-oom"}, ffmpeg="no-ffmpeg")
        self.assertEqual(code, 1)
        self.assertIn("card ran out of memory", last_line(err))

    def test_a_missing_text_file_is_exit_1(self):
        code, _, err = self.run_job({}, self.root / "in" / "gone.txt", ffmpeg="no-ffmpeg")
        self.assertEqual(code, 1)
        self.assertTrue(last_line(err).startswith("tts: the job's files cannot be read ("), err)

    def test_params_that_are_not_an_object_are_exit_2(self):
        code, _, err = self.run_job({}, raw_params="[1, 2]", ffmpeg="no-ffmpeg")
        self.assertEqual(code, 2)
        self.assertTrue(last_line(err).startswith("tts: params.json does not hold valid parameters ("), err)
        code, _, err = self.run_job({}, raw_params="{text", ffmpeg="no-ffmpeg")
        self.assertEqual(code, 2)
        self.assertTrue(last_line(err).startswith("tts: params.json does not hold valid parameters ("), err)
        code, _, err = self.run_job({}, raw_params="[" * 100_000, ffmpeg="no-ffmpeg")  # nested too deep for json
        self.assertEqual(code, 2)
        self.assertTrue(last_line(err).startswith("tts: params.json does not hold valid parameters ("), err)

    def test_a_speed_that_is_not_a_number_is_exit_2(self):
        code, _, err = self.run_job({"text": "Ahoj.", "speed": "fast"}, ffmpeg="no-ffmpeg")
        self.assertEqual(code, 2)
        self.assertEqual(last_line(err), "tts: speed must be a number, not 'fast'")

    def test_a_bug_in_preparing_the_text_is_exit_1_not_invalid_params(self):
        code, _, err = self.run_job({"text": "Ahoj."}, behavior={"prepare_bug": True}, ffmpeg="no-ffmpeg")
        self.assertEqual(code, 1)
        self.assertEqual(last_line(err), "tts: the text could not be prepared (TypeError: unsupported operand type(s) for +: 'int' and 'str')")

    def test_a_broken_environment_is_exit_3(self):
        code, _, err = self.run_job({"text": "Ahoj."}, behavior={"mode": "import-error"}, ffmpeg="no-ffmpeg")
        self.assertEqual(code, 3)
        self.assertEqual(last_line(err), "tts: the pack's Python environment is broken (ImportError: No module named 'torch'): run fornax types setup tts")

    def test_ffmpeg_that_does_not_run_is_exit_3(self):
        code, _, err = self.run_job({"text": "Ahoj."}, ffmpeg=str(self.root / "no-ffmpeg"))
        self.assertEqual(code, 3)
        self.assertIn("check tools.ffmpeg in worker.yaml", last_line(err))
        self.assertEqual(self.outputs(), [])


@unittest.skipUnless(FFMPEG and FFPROBE, "ffmpeg and ffprobe are not on PATH")
class SpeakTest(RunCase):
    def duration(self, path):
        r = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)], capture_output=True, text=True, check=True)
        return float(r.stdout)

    def test_a_text_parameter_becomes_speech_mp3(self):
        code, out, err = self.run_job({"text": "Prepis je hotový. Výsledok nájdeš v schránke."})
        self.assertEqual(code, 0, err)
        self.assertEqual(self.outputs(), ["outputs.json", "speech.mp3"])
        meta = json.loads((self.out / "outputs.json").read_text(encoding="utf-8"))["speech.mp3"]["meta"]
        self.assertEqual({k: meta[k] for k in ("model", "voice", "format", "speed", "sample_rate", "characters", "paragraphs", "chunks")},
                         {"model": "piper", "voice": "lili", "format": "mp3", "speed": 1, "sample_rate": 22050, "characters": 45, "paragraphs": 1, "chunks": 1})
        self.assertEqual(meta["model_repo"], "fake/piper")
        self.assertAlmostEqual(meta["duration_s"], 45 * SECONDS_PER_CHAR, delta=0.01)
        progress = [json.loads(line) for line in out.splitlines() if line.startswith("{")]
        self.assertEqual(progress[-1]["progress"], 1.0)
        self.assertIn("paragraph 1/1", [p["message"] for p in progress])

    def test_a_markdown_file_is_spoken_chunk_by_chunk_with_pauses(self):
        md = NL.join(["# Ranný prehľad", "", "Prvá veta. Druhá veta.", "", "- jedna", "- dve"])
        code, out, err = self.run_job({"model": "omnivoice", "voice": "peter", "format": "wav", "speed": 1.25}, self.text_file(md))
        self.assertEqual(code, 0, err)
        spoken = calls(self.root)
        self.assertEqual([c["text"] for c in spoken], ["Ranný prehľad", "Prvá veta. Druhá veta.", "jedna", "dve"])
        self.assertEqual({(c["voice"], c["speed"]) for c in spoken}, {("peter", 1.25)})
        chars = sum(len(c["text"]) for c in spoken)
        expected = chars * SECONDS_PER_CHAR + 3 * 0.7
        self.assertAlmostEqual(self.duration(self.out / "speech.wav"), expected, delta=0.02)
        meta = json.loads((self.out / "outputs.json").read_text(encoding="utf-8"))["speech.wav"]["meta"]
        self.assertEqual((meta["paragraphs"], meta["chunks"], meta["sample_rate"]), (4, 4, 24000))
        messages = [json.loads(line)["message"] for line in out.splitlines() if line.startswith("{")]
        self.assertIn("chunk 4/4", messages)

    def test_piper_gets_whole_paragraphs(self):
        sentence = "Toto je jedna dlhšia veta s niekoľkými slovami navyše."
        code, _, err = self.run_job({"format": "opus"}, self.text_file(" ".join([sentence] * 10), "text_file.txt"))
        self.assertEqual(code, 0, err)
        self.assertEqual(len(calls(self.root)), 1)
        self.assertEqual(self.outputs(), ["outputs.json", "speech.opus"])

    def test_a_failed_outputs_json_write_leaves_no_output(self):
        code, _, err = self.run_job({"text": "Ahoj."}, behavior={"block_outputs": str(self.out / "outputs.json")})
        self.assertEqual(code, 1)
        self.assertTrue(last_line(err).startswith("tts: outputs.json could not be written ("), err)
        self.assertEqual([p.name for p in self.out.iterdir() if p.name.startswith("speech")], [])

    def test_an_ffmpeg_that_cannot_write_is_exit_1_and_leaves_no_output(self):
        code, _, err = self.run_job({"text": "Ahoj."}, out=self.root / "missing" / "out")
        self.assertEqual(code, 1)
        self.assertTrue(last_line(err).startswith("tts: ffmpeg "), err)
        self.assertEqual([p for p in self.root.rglob("speech*")], [])

    def test_a_failure_while_speaking_leaves_no_output(self):
        sentence = "Toto je jedna dlhšia veta s niekoľkými slovami navyše."
        text = NL.join([sentence, "", sentence, "", sentence])
        code, _, err = self.run_job({"model": "omnivoice"}, self.text_file(text, "text_file.txt"), behavior={"fail_at": 3})
        self.assertEqual(code, 1)
        self.assertTrue(last_line(err).startswith("tts: the card ran out of memory (OutOfMemoryError: CUDA out of memory."), err)
        self.assertEqual(self.outputs(), [])


if __name__ == "__main__":
    unittest.main()
