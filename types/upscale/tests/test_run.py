import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from fakes import make_pack, set_card

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
OK_BEHAVIOR = {"mode": "ok", "frames": 6, "width": 128, "height": 72}


def last_line(log):
    """The worker reports a failed job by the last non-empty line of its log."""
    return [line for line in log.splitlines() if line.strip()][-1]


@unittest.skipUnless(FFMPEG and FFPROBE, "ffmpeg and ffprobe are not on PATH")
class RunTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def clip(self, name="video.mp4", matrix="smpte170m", sound=None):
        folder = self.root / "in"
        folder.mkdir(exist_ok=True)
        path = folder / name
        args = [FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=64x36:r=24:d=0.25"]
        if sound:
            args += ["-f", "lavfi", "-i", "sine=f=440:d=0.25", "-c:a", sound, "-shortest"]
        args += ["-frames:v", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-colorspace", matrix, "-color_primaries", "smpte170m", "-color_trc", "bt709", str(path)]
        subprocess.run(args, check=True, timeout=120)
        return path

    def argv(self, video, params):
        work, out = self.root / "work", self.root / "out"
        work.mkdir(exist_ok=True)
        out.mkdir(exist_ok=True)
        (work / "params.json").write_text(json.dumps(params), encoding="utf-8")
        return [sys.executable, str(self.root / "wrap_run.py"), "--params", str(work / "params.json"), "--video", str(video), "--ffmpeg", FFMPEG, "--ffprobe", FFPROBE, "--out", str(out), "--work", str(work)]

    def env(self):
        return dict(os.environ, PYTHONPATH=str(self.root), PYTHONDONTWRITEBYTECODE="1")

    def run_job(self, behavior=None, params=None, video=None):
        self.pack = make_pack(self.root, behavior or OK_BEHAVIOR)
        r = subprocess.run(self.argv(video or self.clip(), params or {}), env=self.env(), capture_output=True, text=True, encoding="utf-8", timeout=180)
        return r.returncode, r.stdout, r.stderr

    def calls(self):
        path = self.pack / "env" / "seedvr2" / "calls.txt"
        return path.read_text(encoding="utf-8").splitlines() if path.exists() else []

    def test_a_clip_is_upscaled(self):
        code, out, err = self.run_job()
        self.assertEqual(code, 0, err)
        result = self.root / "out"
        self.assertTrue((result / "upscaled.mp4").is_file())
        self.assertTrue((result / "previews" / "upscaled.jpg").is_file())
        meta = json.loads((result / "outputs.json").read_text(encoding="utf-8"))["upscaled.mp4"]["meta"]
        self.assertEqual({k: meta[k] for k in ("width", "height", "frames", "rate", "source_width", "source_height", "batch", "overlap", "batches", "attempts", "audio", "audio_codec")}, {
            "width": 128, "height": 72, "frames": 6, "rate": "24/1", "source_width": 64, "source_height": 36,
            "batch": 21, "overlap": 3, "batches": 1, "attempts": 1, "audio": False, "audio_codec": None,
        })
        self.assertEqual((meta["tool"], meta["seed"], meta["color_correction"], meta["color_matrix"]), ("SeedVR2", 42, "lab", "smpte170m"))
        self.assertEqual(meta["commit"], "4490bd1f482e026674543386bb2a4d176da245b9")
        self.assertIn('"progress": 1.0', out)
        self.assertIn("upscaling batch 2/2", out)
        self.assertFalse((self.root / "work" / "frames").exists())
        self.assertRegex(self.calls()[0], r"--batch_size 21 --uniform_batch_size --temporal_overlap 3")

    def test_the_ladder_steps_down(self):
        code, _, err = self.run_job({**OK_BEHAVIOR, "mode": "oom-above", "max_batch": 13})
        self.assertEqual(code, 0, err)
        self.assertIn("out of memory at batch 21", err)
        meta = json.loads((self.root / "out" / "outputs.json").read_text(encoding="utf-8"))["upscaled.mp4"]["meta"]
        self.assertEqual((meta["batch"], meta["attempts"]), (13, 2))

    def test_out_of_memory_at_the_end_of_the_ladder_is_permanent(self):
        code, _, err = self.run_job({**OK_BEHAVIOR, "mode": "oom-above", "max_batch": 5})
        self.assertEqual(code, 4, err)
        self.assertEqual(len(self.calls()), 3)  # 21, 13, 9
        self.assertFalse((self.root / "out" / "upscaled.mp4").exists())
        self.assertIn("no result (batches tried: 21 -> 13 -> 9", err)
        self.assertIn("upscale: out of memory at batch 9 (tried 21 -> 13 -> 9), the end of the batch ladder", last_line(err))

    def test_an_early_out_of_memory_is_tried_again_later(self):
        code, _, err = self.run_job({**OK_BEHAVIOR, "mode": "early-oom"})
        self.assertEqual(code, 1, err)
        self.assertIn("before SeedVR2 began processing", err)
        self.assertEqual(len(self.calls()), 1)  # one attempt: no smaller batch is tried
        self.assertIn("upscale: out of memory before SeedVR2 began processing: CUDA itself could not start", last_line(err))

    def test_a_wrong_frame_count_fails(self):
        code, _, err = self.run_job({**OK_BEHAVIOR, "mode": "few-frames"})
        self.assertEqual(code, 1, err)
        self.assertIn("SeedVR2 wrote 5 frames, the source has 6", err)

    def test_the_vram_watchdog(self):
        code, _, err = self.run_job({**OK_BEHAVIOR, "mode": "hog"})
        self.assertEqual(code, 1, err)
        self.assertIn("killed by the VRAM watchdog: the card had 16000 MiB in use, over the limit of 15311", err)
        self.assertIn("upscale: killed by the VRAM watchdog", last_line(err))

    def test_card_full_before_start_is_refused(self):
        self.pack = make_pack(self.root, OK_BEHAVIOR)
        set_card(self.root, 15400)
        r = subprocess.run(self.argv(self.clip(), {}), env=self.env(), capture_output=True, text=True, encoding="utf-8", timeout=180)
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("not started: 15400 MiB of the card is already in use", r.stderr)
        self.assertEqual(self.calls(), [])

    def test_two_gpus_exit_3(self):
        self.pack = make_pack(self.root, OK_BEHAVIOR)
        set_card(self.root, 1100, gpus=2)
        r = subprocess.run(self.argv(self.clip(), {}), env=self.env(), capture_output=True, text=True, encoding="utf-8", timeout=180)
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn("more than one GPU is not supported yet", r.stderr)

    def test_invalid_input_exits_2_before_anything_starts(self):
        code, _, err = self.run_job(video=self.clip(matrix="bt709"))
        self.assertEqual(code, 2, err)
        self.assertIn("colour matrix bt709", err)
        self.tearDown()
        self.setUp()
        code, _, err = self.run_job(params={"batch": 9, "overlap": 9})
        self.assertEqual(code, 2, err)
        self.tearDown()
        self.setUp()
        junk = self.root / "junk.mp4"
        junk.write_bytes(b"junk")
        code, _, err = self.run_job(video=junk)
        self.assertEqual(code, 2, err)

    def test_a_missing_model_exits_3(self):
        self.pack = make_pack(self.root, OK_BEHAVIOR)
        (self.pack / "env" / "models" / "ema_vae_fp16.safetensors").unlink()
        r = subprocess.run(self.argv(self.clip(), {}), env=self.env(), capture_output=True, text=True, encoding="utf-8", timeout=180)
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn("ema_vae_fp16.safetensors is missing", r.stderr)

    def test_sound_on_request(self):
        code, _, err = self.run_job(params={"audio": True}, video=self.clip(name="video.mov", sound="pcm_s16le"))
        self.assertEqual(code, 0, err)
        meta = json.loads((self.root / "out" / "outputs.json").read_text(encoding="utf-8"))["upscaled.mp4"]["meta"]
        self.assertEqual((meta["audio"], meta["audio_codec"]), (True, "aac"))
        self.assertIn("encoded to AAC 256k", err)

    def test_audio_requested_without_sound(self):
        code, _, err = self.run_job(params={"audio": True})
        self.assertEqual(code, 0, err)
        meta = json.loads((self.root / "out" / "outputs.json").read_text(encoding="utf-8"))["upscaled.mp4"]["meta"]
        self.assertEqual((meta["audio"], meta["audio_codec"]), (False, None))
        self.assertIn("the source has no sound track", err)

    @unittest.skipIf(os.name == "nt", "SIGTERM is how the worker stops a job on Linux")
    def test_sigterm_kills_the_attempt(self):
        self.pack = make_pack(self.root, {**OK_BEHAVIOR, "mode": "sleep"})
        p = subprocess.Popen(self.argv(self.clip(), {}), env=self.env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        beat = self.pack / "env" / "seedvr2" / "beat.txt"
        try:
            deadline = time.monotonic() + 60
            while not (beat.exists() and beat.stat().st_size > 2):
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.1)
            p.send_signal(signal.SIGTERM)
            self.assertNotEqual(p.wait(timeout=30), 0)
            time.sleep(0.5)
            size = beat.stat().st_size
            time.sleep(1.0)
            self.assertEqual(beat.stat().st_size, size, "SeedVR2 still runs")
        finally:
            if p.poll() is None:
                p.kill()


if __name__ == "__main__":
    unittest.main()
