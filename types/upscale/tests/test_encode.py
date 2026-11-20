import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import encode  # noqa: E402
import upscale_lib as lib  # noqa: E402
from fakes import png_bytes  # noqa: E402

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
COLOUR = (192, 128, 64)


def ffmpeg(*args):
    subprocess.run([FFMPEG, "-v", "error", "-y", *args], check=True, timeout=120)


def stream(path, select, entries):
    r = subprocess.run([FFPROBE, "-v", "error", "-select_streams", select, "-show_entries", f"stream={entries}", "-of", "default=noprint_wrappers=1", str(path)], capture_output=True, text=True, timeout=60)
    return dict(line.split("=", 1) for line in r.stdout.splitlines() if "=" in line)


@unittest.skipUnless(FFMPEG and FFPROBE, "ffmpeg and ffprobe are not on PATH")
class EncodeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.src = lib.Probe(64, 36, "24/1", 24.0, False, 6, "smpte170m", "smpte170m", "bt709")

    def tearDown(self):
        self.tmp.cleanup()

    def frames(self, n=6, width=128, height=72):
        folder = self.dir / "frames"
        folder.mkdir(exist_ok=True)
        data = png_bytes(width, height, COLOUR)
        paths = []
        for i in range(n):
            paths.append(folder / f"video_{i:06d}.png")
            paths[-1].write_bytes(data)
        return paths

    def test_frames_rate_size_and_colour_tags(self):
        out = self.dir / "out" / "upscaled.mp4"
        out.parent.mkdir()
        written = encode.encode_frames(FFMPEG, FFPROBE, self.frames(), self.src, out)
        self.assertEqual((written.width, written.height, written.frames, written.rate), (128, 72, 6, "24/1"))
        self.assertEqual((written.color_space, written.color_primaries, written.color_transfer), ("smpte170m", "smpte170m", "bt709"))
        self.assertEqual(stream(out, "v:0", "color_range")["color_range"], "tv")
        self.assertEqual(stream(out, "a", "codec_name"), {})
        self.assertFalse((out.parent / "upscaled.part.mp4").exists())

    def test_a_flat_colour_comes_back_within_2_of_255(self):
        out = self.dir / "upscaled.mp4"
        encode.encode_frames(FFMPEG, FFPROBE, self.frames(), self.src, out)
        raw = subprocess.run([FFMPEG, "-v", "error", "-i", str(out), "-vf", "scale=in_color_matrix=bt601:in_range=tv:flags=accurate_rnd+full_chroma_int,format=rgb24", "-frames:v", "1", "-f", "rawvideo", "-"], capture_output=True, check=True, timeout=60).stdout
        self.assertEqual(len(raw), 128 * 72 * 3)
        for channel, want in enumerate(COLOUR):
            mean = sum(raw[channel::3]) / (128 * 72)
            self.assertLessEqual(abs(mean - want), 2, f"channel {channel}: {mean}")

    def test_odd_frame_size_encodes(self):
        out = self.dir / "upscaled.mp4"
        written = encode.encode_frames(FFMPEG, FFPROBE, self.frames(width=129, height=73), self.src, out)
        self.assertEqual((written.width, written.height, written.frames), (128, 72, 6))

    def test_sound_is_copied_or_encoded_to_aac(self):
        aac_src = self.dir / "src.mp4"
        ffmpeg("-f", "lavfi", "-i", "testsrc2=s=64x36:r=24:d=0.25", "-f", "lavfi", "-i", "sine=f=440:d=0.25", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(aac_src))
        pcm_src = self.dir / "src.mov"
        ffmpeg("-f", "lavfi", "-i", "testsrc2=s=64x36:r=24:d=0.25", "-f", "lavfi", "-i", "sine=f=440:d=0.25", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-shortest", str(pcm_src))
        self.assertEqual(encode.audio_codec(FFPROBE, aac_src), "aac")
        self.assertEqual(encode.audio_codec(FFPROBE, pcm_src), "pcm_s16le")
        frames = self.frames()
        for source, plan in ((aac_src, "copy"), (pcm_src, "aac")):
            with self.subTest(plan=plan):
                out = self.dir / f"{plan}.mp4"
                encode.encode_frames(FFMPEG, FFPROBE, frames, self.src, out, source, plan)
                self.assertEqual(stream(out, "a:0", "codec_name")["codec_name"], "aac")

    def test_a_wrong_frame_count_is_not_delivered(self):
        out = self.dir / "upscaled.mp4"
        frames = self.frames()
        frames[3].write_bytes(b"not a png")
        with self.assertRaises(encode.EncodeError):
            encode.encode_frames(FFMPEG, FFPROBE, frames, self.src, out)
        self.assertFalse(out.exists())
        self.assertFalse((self.dir / "upscaled.part.mp4").exists())

    def test_the_temporary_file_is_removed_when_the_read_back_cannot_run(self):
        out = self.dir / "upscaled.mp4"
        with self.assertRaises(encode.ToolError):
            encode.encode_frames(FFMPEG, str(self.dir / "no-ffprobe-here"), self.frames(), self.src, out)
        self.assertFalse(out.exists())
        self.assertFalse((self.dir / "upscaled.part.mp4").exists())

    def test_the_temporary_file_is_removed_when_the_feed_is_interrupted(self):
        self.interrupt_the_feed(FFMPEG)

    @unittest.skipUnless(os.name == "nt", "Windows: a file still open cannot be removed")
    def test_an_interruption_kills_the_whole_tree_of_a_launcher(self):
        # Shims (scoop, chocolatey) start the real ffmpeg as their child and end it on their own death, but only after
        # their kill has returned: ffmpeg still held the temporary file for a moment and removing it failed (WinError 32,
        # under load). A .cmd in front of ffmpeg is such a launcher; the interruption must take its whole tree.
        launcher = self.dir / "ffmpeg-launcher.cmd"
        launcher.write_text(f'@"{FFMPEG}" %*\r\n', encoding="utf-8")
        killed = []
        real = encode.kill_tree

        def spy(pid):
            killed.append(pid)
            real(pid)

        encode.kill_tree = spy
        try:
            self.interrupt_the_feed(str(launcher))
        finally:
            encode.kill_tree = real
        self.assertEqual(len(killed), 1)

    def interrupt_the_feed(self, ffmpeg_cmd):
        """encode_frames through `ffmpeg_cmd`, interrupted once ffmpeg has created the temporary file: the interruption
        comes through and nothing is left behind."""

        class Stop(Exception):
            pass

        part = self.dir / "upscaled.part.mp4"
        seen = []

        def stop(done, total):
            # Interrupt once ffmpeg has created the temporary file: it does so only when x264 puts out its first
            # packets (after some 150 frames), and the feed runs ahead of ffmpeg, so let it catch up a little.
            deadline = time.monotonic() + 0.5
            while not part.exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            if part.exists():
                seen.append(done)
                raise Stop()

        # Noise frames, larger than the pipe's write buffer, so the feed reaches ffmpeg frame by frame.
        noise = self.dir / "noise.png"
        ffmpeg("-f", "lavfi", "-i", "nullsrc=s=320x180,geq=lum=random(1)*255:cb=128:cr=128", "-frames:v", "1", str(noise))
        frames = self.frames(n=480)
        for frame in frames:
            shutil.copyfile(noise, frame)
        out = self.dir / "upscaled.mp4"
        with self.assertRaises(Stop):
            encode.encode_frames(ffmpeg_cmd, FFPROBE, frames, self.src, out, on_progress=stop)
        self.assertEqual(len(seen), 1)
        self.assertFalse(out.exists())
        self.assertFalse((self.dir / "upscaled.part.mp4").exists())

    def test_probe_of_a_real_clip_and_of_junk(self):
        clip = self.dir / "clip.mp4"
        ffmpeg("-f", "lavfi", "-i", "testsrc2=s=64x36:r=24", "-frames:v", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-colorspace", "smpte170m", "-color_primaries", "smpte170m", "-color_trc", "bt709", str(clip))
        p = encode.probe(FFPROBE, clip)
        self.assertEqual((p.width, p.height, p.frames, p.color_space), (64, 36, 6, "smpte170m"))
        junk = self.dir / "junk.mp4"
        junk.write_bytes(b"junk")
        with self.assertRaises(lib.Rejected):
            encode.probe(FFPROBE, junk)
        with self.assertRaises(encode.ToolError):
            encode.probe(str(self.dir / "no-ffprobe-here"), clip)

    def test_the_preview(self):
        frame = self.frames(n=1, width=1920, height=1080)[0]
        dest = self.dir / "out" / "previews" / "upscaled.jpg"
        encode.make_preview(FFMPEG, frame, 1920, 1080, dest)
        self.assertEqual(stream(dest, "v:0", "width,height"), {"width": "1024", "height": "576"})


if __name__ == "__main__":
    unittest.main()
