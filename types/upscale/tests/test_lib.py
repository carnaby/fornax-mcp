import dataclasses
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import upscale_lib as lib  # noqa: E402


def probe(**changes):
    base = lib.Probe(1280, 720, "24/1", 24.0, False, 240, "smpte170m", "smpte170m", "bt709")
    return dataclasses.replace(base, **changes)


GOOD_STREAM = {
    "width": 1280, "height": 720, "r_frame_rate": "24/1", "avg_frame_rate": "24/1", "nb_read_frames": "240",
    "color_space": "smpte170m", "color_primaries": "smpte170m", "color_transfer": "bt709",
}


def probe_json(**changes):
    return json.dumps({"streams": [dict(GOOD_STREAM, **changes)]})


class SettingsTest(unittest.TestCase):
    def test_defaults_follow_the_resolution(self):
        self.assertEqual(lib.settings({}), lib.Settings(1080, 21, 3, False))
        self.assertEqual(lib.settings({"resolution": 1440}), lib.Settings(1440, 13, 3, False))
        self.assertEqual(lib.settings({"resolution": 1440, "batch": 17, "overlap": 0, "audio": True}), lib.Settings(1440, 17, 0, True))

    def test_an_overlap_not_smaller_than_the_batch_is_refused(self):
        with self.assertRaisesRegex(lib.Rejected, r"overlap 9 must be smaller than the batch \(9\)"):
            lib.settings({"batch": 9, "overlap": 9})
        with self.assertRaises(lib.Rejected):
            lib.settings({"batch": 9, "overlap": 12})


class BatchesTest(unittest.TestCase):
    def test_the_count_matches_the_measured_clips(self):
        self.assertEqual(lib.batch_count(240, 21, 3), 14)  # 10 s at 24 fps
        self.assertEqual(lib.batch_count(192, 21, 3), 11)  # 8 s

    def test_edges(self):
        self.assertEqual(lib.batch_count(1, 21, 3), 1)
        self.assertEqual(lib.batch_count(21, 21, 0), 1)
        self.assertEqual(lib.batch_count(22, 21, 0), 2)
        self.assertEqual(lib.batch_count(192, 13, 3), 19)

    def test_the_estimate(self):
        self.assertAlmostEqual(lib.estimate_seconds(240, 21, 3, 1080), 14 * 88)
        self.assertAlmostEqual(lib.estimate_seconds(192, 13, 3, 1440), 19 * 13 * 88 / 21 * 1.7)
        self.assertEqual(lib.minutes(1), 1)
        self.assertEqual(lib.minutes(9416), 157)

    def test_the_ladder_steps_down_and_stops_above_the_overlap(self):
        self.assertEqual(lib.next_batch(29, 3), 21)
        self.assertEqual(lib.next_batch(25, 3), 21)
        self.assertEqual(lib.next_batch(21, 3), 13)
        self.assertEqual(lib.next_batch(13, 3), 9)
        self.assertIsNone(lib.next_batch(9, 3))
        self.assertIsNone(lib.next_batch(13, 9))
        self.assertEqual(lib.next_batch(13, 8), 9)


class ProbeTest(unittest.TestCase):
    def test_reads_size_rate_frames_and_tags(self):
        p = lib.parse_probe(probe_json())
        self.assertEqual((p.width, p.height, p.rate, p.frames, p.variable_rate), (1280, 720, "24/1", 240, False))
        self.assertAlmostEqual(p.fps, 24.0)
        self.assertEqual((p.color_space, p.color_primaries, p.color_transfer), ("smpte170m", "smpte170m", "bt709"))

    def test_a_fractional_and_a_variable_rate(self):
        p = lib.parse_probe(probe_json(r_frame_rate="24000/1001", avg_frame_rate="23000/1001"))
        self.assertAlmostEqual(p.fps, 23.976, places=3)
        self.assertEqual(p.rate, "24000/1001")
        self.assertTrue(p.variable_rate)

    def test_unknown_tags_are_none(self):
        p = lib.parse_probe(probe_json(color_space="unknown", color_primaries=""))
        self.assertEqual((p.color_space, p.color_primaries), (None, None))
        stream = dict(GOOD_STREAM)
        del stream["color_transfer"]
        self.assertIsNone(lib.parse_probe(json.dumps({"streams": [stream]})).color_transfer)

    def test_unreadable_answers_are_rejected(self):
        for text in ("", "not json", "[]", '{"streams": []}', probe_json(nb_read_frames="N/A"), probe_json(r_frame_rate="0/0"), probe_json(width=0)):
            with self.subTest(text=text), self.assertRaises(lib.Rejected):
                lib.parse_probe(text)

    def test_the_audio_codec(self):
        self.assertEqual(lib.parse_audio_codec('{"streams": [{"codec_name": "aac"}]}'), "aac")
        self.assertIsNone(lib.parse_audio_codec('{"streams": []}'))
        self.assertIsNone(lib.parse_audio_codec("junk"))


class SourceTest(unittest.TestCase):
    S1080 = lib.Settings(1080, 21, 3, False)

    def test_bt601_clips_pass(self):
        lib.check_source(probe(), self.S1080)
        lib.check_source(probe(color_space="bt470bg", color_primaries=None, color_transfer=None), self.S1080)

    def test_other_colour_is_refused_with_the_tags(self):
        with self.assertRaisesRegex(lib.Rejected, r"colour matrix bt709, primaries smpte170m, transfer bt709"):
            lib.check_source(probe(color_space="bt709"), self.S1080)
        with self.assertRaisesRegex(lib.Rejected, r"colour matrix untagged"):
            lib.check_source(probe(color_space=None), self.S1080)

    def test_nothing_to_upscale(self):
        with self.assertRaisesRegex(lib.Rejected, r"short side is already 1080 px"):
            lib.check_source(probe(width=1920, height=1080), self.S1080)
        lib.check_source(probe(width=1920, height=1080), lib.Settings(1440, 13, 3, False))

    def test_a_clip_over_the_time_limit_is_refused(self):
        lib.check_source(probe(frames=24 * 60), self.S1080)
        with self.assertRaisesRegex(lib.Rejected, r"about 157 min .* over the 150 min"):
            lib.check_source(probe(frames=24 * 80), self.S1080)


class GpuTextTest(unittest.TestCase):
    def test_parse_gpus(self):
        self.assertEqual(lib.parse_gpus("NVIDIA GeForce RTX 5060 Ti, 16311, 1100, 15211\n"), [lib.Gpu("NVIDIA GeForce RTX 5060 Ti", 16311, 1100, 15211)])
        self.assertEqual(len(lib.parse_gpus("A, 8192, 0, 8192\nB, 8192, 0, 8192\n")), 2)
        self.assertEqual(lib.parse_gpus("Card, Inc, 8192, 0, 8192").pop().name, "Card, Inc")

    def test_parse_gpus_refuses_what_it_cannot_read(self):
        for text in ("", "Card, [N/A], 1, 2", "Card, 1, 2", "Card, 0, 0, 0"):
            with self.subTest(text=text), self.assertRaises(ValueError):
                lib.parse_gpus(text)

    def test_parse_used_mib(self):
        self.assertEqual(lib.parse_used_mib("1100\n"), 1100)
        for text in ("", "[N/A]", "12.5", "x"):
            self.assertIsNone(lib.parse_used_mib(text), text)

    def test_the_watchdog_limit_and_the_refusal(self):
        self.assertEqual(lib.watchdog_limit(16311), 15311)
        self.assertIsNone(lib.card_refusal(lib.Gpu("c", 16311, 1100, 15211), 15311))
        self.assertRegex(lib.card_refusal(lib.Gpu("c", 16311, 15400, 911), 15311), r"^15400 MiB of the card is already in use, over the watchdog's 15311 MiB")
        self.assertRegex(lib.card_refusal(lib.Gpu("c", 16311, 13500, 2811), 15311), r"^only 2811 MiB of the card is free")


class ModelsTest(unittest.TestCase):
    def test_missing_and_wrong_size(self):
        with tempfile.TemporaryDirectory() as tmp:
            models = {"a.safetensors": (3, "x"), "b.safetensors": (2, "y"), "c.safetensors": (1, "z")}
            Path(tmp, "a.safetensors").write_bytes(b"abc")
            Path(tmp, "b.safetensors").write_bytes(b"abc")
            problems = lib.model_problems(tmp, models)
            self.assertEqual(len(problems), 2)
            self.assertRegex(problems[0], r"model b\.safetensors has 3 bytes, not 2")
            self.assertRegex(problems[1], r"model c\.safetensors is missing")


if __name__ == "__main__":
    unittest.main()
