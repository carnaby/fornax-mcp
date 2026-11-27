import array
import math
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import encode  # noqa: E402

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")


def sine(seconds, rate):
    a = array.array("f", (0.3 * math.sin(2 * math.pi * 440 * i / rate) for i in range(round(seconds * rate))))
    if sys.byteorder == "big":
        a.byteswap()
    return a.tobytes()


def probe(path):
    r = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "stream=codec_name,sample_rate:format=duration", "-of", "default=nw=1", str(path)], capture_output=True, text=True, check=True)
    return dict(line.split("=", 1) for line in r.stdout.split())


@unittest.skipUnless(FFMPEG and FFPROBE, "ffmpeg and ffprobe are not on PATH")
class EncoderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_each_format_is_delivered_with_its_length(self):
        for fmt, codec, rate in (("mp3", "mp3", "22050"), ("opus", "opus", "48000"), ("wav", "pcm_s16le", "22050")):
            enc = encode.Encoder(FFMPEG, 22050, fmt, self.out)
            enc.write(sine(0.6, 22050))
            enc.write(bytes(4 * 22050 // 2))  # 0.5 s of silence
            self.assertAlmostEqual(enc.seconds, 1.1, places=3)
            path = enc.finish()
            self.assertEqual(path.name, f"speech.{fmt}")
            info = probe(path)
            self.assertEqual((info["codec_name"], info["sample_rate"]), (codec, rate), fmt)
            self.assertAlmostEqual(float(info["duration"]), 1.1, delta=0.1)
            self.assertEqual(sorted(p.name for p in self.out.iterdir() if ".part" in p.name), [])
            path.unlink()

    def test_a_failed_encode_delivers_nothing(self):
        enc = encode.Encoder(FFMPEG, 24000, "mp3", self.out / "missing-folder")
        # ffmpeg may give up while the speech is still being written, or only at the end: both are an EncodeError.
        with self.assertRaisesRegex(encode.EncodeError, r"^ffmpeg (could not encode|stopped taking) the speech \(exit \d+\)"):
            enc.write(sine(0.2, 24000))
            enc.finish()
        enc.abort()
        self.assertEqual(list(self.out.iterdir()), [])

    def test_abort_removes_the_part_file(self):
        enc = encode.Encoder(FFMPEG, 24000, "wav", self.out)
        enc.write(sine(0.2, 24000))
        enc.abort()
        enc.abort()  # a second abort is harmless
        self.assertEqual(list(self.out.iterdir()), [])

    def test_a_large_write_to_a_failing_ffmpeg_raises_and_leaves_nothing(self):
        enc = encode.Encoder(FFMPEG, 24000, "mp3", self.out / "missing-folder")
        # ffmpeg gives up at once; the writes eventually hit a closed pipe (about 8 MB in all).
        with self.assertRaisesRegex(encode.EncodeError, r"^ffmpeg (could not encode|stopped taking) the speech \(exit \d+\)"):
            chunk = sine(0.2, 24000)
            for _ in range(200):
                enc.write(chunk)
            enc.finish()
        self.assertTrue(enc.closed)
        self.assertEqual(list(self.out.iterdir()), [])

    def test_a_write_after_abort_is_an_encode_error(self):
        enc = encode.Encoder(FFMPEG, 24000, "wav", self.out)
        enc.abort()
        with self.assertRaisesRegex(encode.EncodeError, "already closed"):
            enc.write(b"x" * 8)
        self.assertEqual(list(self.out.iterdir()), [])


class ToolTest(unittest.TestCase):
    def test_a_missing_ffmpeg_is_a_tool_error(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(encode.ToolError, r"check tools\.ffmpeg in worker\.yaml"):
                encode.Encoder(os.path.join(d, "no-ffmpeg"), 24000, "mp3", d)

    def test_remove_soon(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.part.mp3"
            p.write_bytes(b"x")
            self.assertTrue(encode.remove_soon(p))
            self.assertTrue(encode.remove_soon(p))  # already gone is fine
            self.assertFalse(p.exists())

    # Deferred 0.13.0: the Windows branches of remove_soon and kill_tree were untested here (upscale has the same).
    @unittest.skipUnless(os.name == "nt", "Windows: a file still open cannot be removed")
    def test_a_file_held_for_a_moment_is_removed_once_it_is_let_go(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.part.mp3"
            f = open(p, "wb")  # Python opens without FILE_SHARE_DELETE: removing it fails while it is open
            try:
                threading.Timer(0.3, f.close).start()
                self.assertTrue(encode.remove_soon(p, 5))
            finally:
                f.close()
            self.assertFalse(p.exists())

    @unittest.skipUnless(os.name == "nt", "Windows: a file still open cannot be removed")
    def test_a_file_held_all_along_gives_up_without_raising(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.part.mp3"
            with open(p, "wb"):
                self.assertFalse(encode.remove_soon(p, 0.2))
            self.assertTrue(encode.remove_soon(p))

    @unittest.skipUnless(os.name == "nt", "Windows: kill_tree is taskkill /T")
    def test_kill_tree_ends_the_launcher_and_its_child(self):
        child = "import time; time.sleep(60)"
        launcher = f"import subprocess, sys, time; p = subprocess.Popen([sys.executable, '-c', {child!r}]); print(p.pid, flush=True); time.sleep(60)"
        p = subprocess.Popen([sys.executable, "-c", launcher], stdout=subprocess.PIPE, text=True)
        try:
            pid = int(p.stdout.readline())
            encode.kill_tree(p.pid)
            p.wait(timeout=10)
            listed = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
            self.assertNotIn(str(pid), listed)
        finally:
            p.kill()
            p.stdout.close()


if __name__ == "__main__":
    unittest.main()
