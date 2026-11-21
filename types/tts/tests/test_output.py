import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import tts_lib as lib  # noqa: E402


class PlanTest(unittest.TestCase):
    def setUp(self):
        self.prepared = lib.Prepared([["a1", "a2"], ["b1"]], 6)

    def test_chunk_by_chunk_with_both_pauses(self):
        self.assertEqual(lib.speech_plan(self.prepared, per_paragraph=False), [("a1", 0.0), ("a2", 0.3), ("b1", 0.7)])

    def test_whole_paragraphs_only_pause_between_paragraphs(self):
        self.assertEqual(lib.speech_plan(self.prepared, per_paragraph=True), [("a1 a2", 0.0), ("b1", 0.7)])

    def test_silence_is_float32_zeros(self):
        self.assertEqual(lib.silence(0.5, 24000), bytes(4 * 12000))
        self.assertEqual(lib.silence(0, 22050), b"")


class FfmpegArgsTest(unittest.TestCase):
    def test_each_format(self):
        head = ["-v", "error", "-y", "-f", "f32le", "-ar", "22050", "-ac", "1", "-i", "-"]
        self.assertEqual(lib.encode_args("mp3", 22050, Path("o/speech.part.mp3")), [*head, "-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3", str(Path("o/speech.part.mp3"))])
        self.assertEqual(lib.encode_args("opus", 22050, "x")[len(head):], ["-c:a", "libopus", "-b:a", "48k", "-f", "ogg", "x"])
        self.assertEqual(lib.encode_args("wav", 22050, "x")[len(head):], ["-c:a", "pcm_s16le", "-f", "wav", "x"])
        self.assertEqual([lib.output_name(f) for f in ("mp3", "opus", "wav")], ["speech.mp3", "speech.opus", "speech.wav"])


class MetaTest(unittest.TestCase):
    def test_only_scalars_and_the_engines_part(self):
        request = lib.Request("omnivoice", "klara", "mp3", 1.25, "A.", None)
        meta = lib.output_meta(request, lib.Prepared([["A."]], 2), 24000, 1.234, 7.89, {"seed": 42, "peak_vram_mib": 3647})
        self.assertEqual(meta, {
            "model": "omnivoice", "voice": "klara", "format": "mp3", "speed": 1.25, "duration_s": 1.23,
            "sample_rate": 24000, "characters": 2, "paragraphs": 1, "chunks": 1, "seconds": 7.9,
            "seed": 42, "peak_vram_mib": 3647,
        })
        for value in meta.values():
            self.assertIsInstance(value, (str, int, float, bool))


class FailureTextTest(unittest.TestCase):
    def test_out_of_memory_has_its_own_sentence(self):
        class OutOfMemoryError(RuntimeError):
            pass

        text = lib.failure_text(OutOfMemoryError("CUDA out of memory. Tried to allocate 2.00 GiB"))
        self.assertTrue(text.startswith("the card ran out of memory (OutOfMemoryError: CUDA out of memory."), text)
        self.assertIn("another program may hold it", text)

    def test_anything_else_is_one_line(self):
        text = lib.failure_text(RuntimeError("bad" + chr(10) + "news"))
        self.assertEqual(text, "speaking failed (RuntimeError: bad news)")
        self.assertLessEqual(len(lib.failure_text(ValueError("x" * 1000))), 330)


if __name__ == "__main__":
    unittest.main()
