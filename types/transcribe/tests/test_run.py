import argparse
import io
import json
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import run  # noqa: E402
from speakers import DIARIZE_MODEL  # noqa: E402

FAKE_FFMPEG = r'''
import sys, wave
args = sys.argv[1:]
src, dst = args[args.index("-i") + 1], args[-1]
data = open(src, "rb").read()
if data == b"NOAUDIO":
    sys.stderr.write("Output file #0 does not contain any stream\n")
    sys.exit(1)
if data == b"BROKEN":
    sys.stderr.write("Invalid data found when processing input\n")
    sys.exit(1)
with wave.open(dst, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\0\0" * 16000)
'''

FAKE_WHISPER = r'''
import json, os, sys
opts = json.loads(sys.stdin.buffer.read().decode("utf-8"))
with open(os.path.join(os.path.dirname(opts["wav"]), "whisper-options.json"), "w", encoding="utf-8") as f:
    json.dump(opts, f)
if opts["model"] == "broken-env":
    sys.stderr.write("cublas64_12.dll is not found\n"); sys.exit(3)
if opts["model"] == "crash":
    sys.stderr.write("RuntimeError: boom\n"); sys.exit(1)
sys.stderr.write("loading the model\n")
sys.stderr.write("PROGRESS 900\n")
sys.stderr.flush()
print(json.dumps({"language": "en", "duration_ms": 1000, "segments": [
    {"start_ms": 0, "end_ms": 900, "text": " hello   world ",
     "words": [{"start_ms": 0, "end_ms": 400, "text": " hello"}, {"start_ms": 500, "end_ms": 900, "text": " world"}]}]}))
'''

FAKE_DIARIZE = r'''
import json, os, sys
opts = json.loads(sys.stdin.buffer.read().decode("utf-8"))
with open(os.path.join(os.path.dirname(opts["wav"]), "diarize-options.json"), "w", encoding="utf-8") as f:
    json.dump(opts, f)
sys.stderr.write("PROGRESS 500\n")
print(json.dumps({"model": "pyannote/speaker-diarization-community-1", "speakers": 2, "turns": [
    {"start_ms": 0, "end_ms": 450, "speaker": "S1"}, {"start_ms": 450, "end_ms": 1000, "speaker": "S2"}]}))
'''

FAKE_DIARIZE_FAILING = r'''
import sys
sys.stdin.buffer.read()
sys.stderr.write("torch.OutOfMemoryError: CUDA out of memory\n")
sys.exit(1)
'''


class Run(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="fornax-transcribe-"))
        for name, code in [("ffmpeg.py", FAKE_FFMPEG), ("whisper.py", FAKE_WHISPER), ("diarize.py", FAKE_DIARIZE), ("diarize_failing.py", FAKE_DIARIZE_FAILING)]:
            (self.tmp / name).write_text(code, encoding="utf-8")
        for d in ("in", "out", "work"):
            (self.tmp / d).mkdir()
        self.audio = self.tmp / "in" / "recording.m4a"
        self.audio.write_bytes(b"AUDIO")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def fake(self, name):
        return [sys.executable, str(self.tmp / name)]

    def go(self, params, diarize="diarize.py", ffmpeg=None):
        (self.tmp / "work" / "params.json").write_text(json.dumps(params), encoding="utf-8")
        args = argparse.Namespace(params=str(self.tmp / "work" / "params.json"), audio=str(self.audio), ffmpeg="unused", out=str(self.tmp / "out"), work=str(self.tmp / "work"))
        out, err = io.StringIO(), io.StringIO()
        try:
            with redirect_stdout(out), redirect_stderr(err):
                return run.run(args, ffmpeg_cmd=ffmpeg or self.fake("ffmpeg.py"), whisper_cmd=self.fake("whisper.py"), diarize_cmd=self.fake(diarize))
        finally:
            # Also when run() exits with SystemExit: the tests read what it printed.
            self.stdout, self.stderr = out.getvalue(), err.getvalue()

    def transcript(self):
        return json.loads((self.tmp / "out" / "transcript.json").read_text(encoding="utf-8"))

    def progress(self):
        return [json.loads(line) for line in self.stdout.splitlines() if line.strip()]

    def test_transcribes_and_reports_progress(self):
        self.assertEqual(self.go({"model": "large-v3", "diarize": False, "language": "en", "initial_prompt": "Fornax"}), 0)
        self.assertEqual(self.transcript(), {"model": "large-v3", "language": "en", "duration_ms": 1000, "segments": [{"start_ms": 0, "end_ms": 900, "text": "hello world"}]})
        opts = json.loads((self.tmp / "work" / "whisper-options.json").read_text(encoding="utf-8"))
        self.assertEqual((opts["model"], opts["language"], opts["initial_prompt"]), ("large-v3", "en", "Fornax"))
        steps = self.progress()
        self.assertTrue(all(0 <= p["progress"] <= 1 and isinstance(p["message"], str) for p in steps))
        self.assertEqual(steps[-1]["progress"], 1)
        # The children's other lines reach the log; their PROGRESS lines do not.
        self.assertIn("loading the model", self.stderr)
        self.assertNotIn("PROGRESS", self.stderr)

    def test_diarize_splits_segments_by_speaker(self):
        self.assertEqual(self.go({"model": "large-v3", "diarize": True, "speakers": 2}), 0)
        t = self.transcript()
        self.assertEqual(
            t["segments"],
            [{"start_ms": 0, "end_ms": 400, "text": "hello", "speaker": "S1"}, {"start_ms": 500, "end_ms": 900, "text": "world", "speaker": "S2"}],
        )
        self.assertEqual(t["diarization"], {"model": DIARIZE_MODEL, "speakers": 2})
        opts = json.loads((self.tmp / "work" / "diarize-options.json").read_text(encoding="utf-8"))
        self.assertEqual(opts["speakers"], 2)

    def test_a_failing_diarizer_costs_only_the_speakers(self):
        self.assertEqual(self.go({"model": "large-v3", "diarize": True}, diarize="diarize_failing.py"), 0)
        t = self.transcript()
        self.assertEqual(t["segments"], [{"start_ms": 0, "end_ms": 900, "text": "hello world"}])
        self.assertEqual(t["diarization"], {"error": "speaker recognition failed (exit 1)"})
        self.assertIn("CUDA out of memory", self.stderr)

    def test_a_missing_diarizer_costs_only_the_speakers(self):
        self.assertEqual(self.go({"model": "large-v3", "diarize": True}, diarize="no-such-diarizer.py"), 0)
        self.assertIn("error", self.transcript()["diarization"])

    def test_no_audio_stream_gives_an_empty_transcript(self):
        self.audio.write_bytes(b"NOAUDIO")
        self.assertEqual(self.go({"model": "large-v3", "diarize": True}), 0)
        self.assertEqual(
            self.transcript(),
            {"model": "large-v3", "language": None, "duration_ms": None, "segments": [], "diarization": {"model": DIARIZE_MODEL, "speakers": 0}},
        )

    def test_unreadable_input_is_exit_2(self):
        self.audio.write_bytes(b"BROKEN")
        with self.assertRaises(SystemExit) as cm:
            self.go({"model": "large-v3"})
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("Invalid data", self.stderr)

    def test_missing_ffmpeg_is_exit_3(self):
        with self.assertRaises(SystemExit) as cm:
            self.go({"model": "large-v3"}, ffmpeg=[str(self.tmp / "no-such-ffmpeg.exe")])
        self.assertEqual(cm.exception.code, 3)

    def test_a_broken_whisper_environment_is_exit_3_and_a_crash_exit_1(self):
        with self.assertRaises(SystemExit) as broken:
            self.go({"model": "broken-env"})
        self.assertEqual(broken.exception.code, 3)
        with self.assertRaises(SystemExit) as crash:
            self.go({"model": "crash"})
        self.assertEqual(crash.exception.code, 1)
        self.assertIn("boom", self.stderr)


if __name__ == "__main__":
    unittest.main()
