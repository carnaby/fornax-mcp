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


class CliTest(unittest.TestCase):
    def test_the_measured_arguments(self):
        self.assertEqual(lib.cli_args("/w/in/video.mp4", "/w/work/frames", "/p/env/models", 1080, 21, 3), [
            "/w/in/video.mp4", "--output", "/w/work/frames", "--output_format", "png", "--model_dir", "/p/env/models",
            "--dit_model", "seedvr2_ema_3b_fp16.safetensors", "--resolution", "1080",
            "--batch_size", "21", "--uniform_batch_size", "--temporal_overlap", "3",
            "--vae_encode_tiled", "--vae_encode_tile_size", "512", "--vae_encode_tile_overlap", "64",
            "--vae_decode_tiled", "--vae_decode_tile_size", "512", "--vae_decode_tile_overlap", "64",
            "--dit_offload_device", "cpu", "--vae_offload_device", "cpu", "--blocks_to_swap", "32", "--swap_io_components",
        ])

    def test_the_job_environment(self):
        base = {"PATH": "p", "pytorch_cuda_alloc_conf": "x", "CUDA_VISIBLE_DEVICES": "1", "UPSCALE_FREE_MIB": "999999", "Upscale_Other": "z", "PYTHONUTF8": "0", "PYTHONPATH": "pp"}
        env = lib.job_env(base, 13145.7)
        self.assertEqual(env, {
            "PATH": "p", "PYTHONPATH": "pp", "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1",
            "CUDA_DEVICE_ORDER": "PCI_BUS_ID", "UPSCALE_MARGIN_GB": "3", "UPSCALE_FREE_MIB": "13145", "UPSCALE_TETHER": "1",
        })


class LinesTest(unittest.TestCase):
    def test_progress_from_the_batch_lines(self):
        fraction, message = lib.progress_of("[12:00:01.5] Upscaling batch 5/14")
        self.assertAlmostEqual(fraction, 0.95 * (1 + 5 / 14) / 4)
        self.assertEqual(message, "upscaling batch 5/14")
        self.assertAlmostEqual(lib.progress_of("Post-processing batch 14/14")[0], 0.95)
        self.assertAlmostEqual(lib.progress_of("Encoding batch 1/2")[0], 0.95 * 0.5 / 4)
        self.assertIsNone(lib.progress_of("Loading the model"))
        self.assertIsNone(lib.progress_of("Encoding batch 0/0"))

    def test_began_out_of_memory_and_bars(self):
        self.assertTrue(lib.began_processing("Phase 1: Encoding ━━━"))
        self.assertTrue(lib.began_processing("Encoding batch 1/3"))
        self.assertFalse(lib.began_processing("Loading the model"))
        self.assertTrue(lib.is_out_of_memory("torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB"))
        self.assertTrue(lib.is_out_of_memory("Allocation on device 0 would exceed allowed memory"))
        self.assertFalse(lib.is_out_of_memory("memory is fine"))
        self.assertTrue(lib.is_progress_bar(" 45%|█████     | 9/20"))
        self.assertFalse(lib.is_progress_bar("Upscaling batch 1/2"))

    def test_the_splitter_cuts_at_cr_and_lf_and_drops_empty_lines(self):
        lines = []
        s = lib.LineSplitter(lines.append)
        s.push("a\rb")
        s.push("\nc\n\n  \n")
        s.push("d")
        s.flush()
        self.assertEqual(lines, ["a", "b", "c", "d"])

    def test_frame_files_in_number_order(self):
        names = ["video_000010.png", "video_000002.png", "video_000001.PNG", "other_000001.png", "video_x.png", "video_000003.png.part", "video_1234567.png"]
        self.assertEqual(lib.frame_files(names, "video"), ["video_000001.PNG", "video_000002.png", "video_000010.png", "video_1234567.png"])


class EncodeArgsTest(unittest.TestCase):
    def test_audio_plan(self):
        self.assertIsNone(lib.audio_plan(False, "aac"))
        self.assertIsNone(lib.audio_plan(True, None))
        for codec in ("aac", "mp3", "alac", "opus", "ac3", "eac3"):
            self.assertEqual(lib.audio_plan(True, codec), "copy", codec)
        self.assertEqual(lib.audio_plan(True, "pcm_s16le"), "aac")

    def test_without_audio(self):
        self.assertEqual(lib.encode_args(probe(), "/o/upscaled.part.mp4"), [
            "-v", "error", "-y", "-f", "image2pipe", "-framerate", "24/1", "-c:v", "png", "-i", "-",
            "-vf", "scale=w=trunc(iw/2)*2:h=trunc(ih/2)*2:out_color_matrix=bt601:out_range=tv,format=yuv420p",
            "-c:v", "libx264", "-crf", "12", "-preset", "slow", "-pix_fmt", "yuv420p",
            "-x264-params", "colormatrix=smpte170m:range=tv:colorprim=smpte170m:transfer=bt709",
            "-colorspace", "smpte170m", "-color_primaries", "smpte170m", "-color_trc", "bt709", "-color_range", "tv",
            "-an", "-movflags", "+faststart", "-f", "mp4", "/o/upscaled.part.mp4",
        ])

    def test_with_audio(self):
        copy = lib.encode_args(probe(), "o.mp4", "/w/in/video.mov", "copy")
        self.assertEqual(copy[copy.index("-") + 1:copy.index("-") + 7], ["-i", "/w/in/video.mov", "-map", "0:v", "-map", "1:a:0"])
        self.assertIn("copy", copy[copy.index("-c:a"):])
        self.assertNotIn("-an", copy)
        aac = lib.encode_args(probe(), "o.mp4", "/w/in/video.mov", "aac")
        self.assertEqual(aac[aac.index("-c:a"):aac.index("-c:a") + 4], ["-c:a", "aac", "-b:a", "256k"])

    def test_tags_only_when_the_source_has_them_and_only_bt601(self):
        args = lib.encode_args(probe(color_space="bt470bg", color_primaries=None, color_transfer=None), "o.mp4")
        self.assertEqual(args[args.index("-x264-params") + 1], "colormatrix=bt470bg:range=tv")
        self.assertNotIn("-color_primaries", args)
        self.assertNotIn("-color_trc", args)
        with self.assertRaises(ValueError):
            lib.encode_args(probe(color_space="bt709"), "o.mp4")


class OutputsTest(unittest.TestCase):
    def test_preview_size(self):
        self.assertEqual(lib.preview_size(1920, 1080), (1024, 576))
        self.assertEqual(lib.preview_size(1080, 1920), (576, 1024))
        self.assertEqual(lib.preview_size(640, 360), (640, 360))

    def test_outputs_json_takes_scalars_only(self):
        meta = {"width": 1920, "x": None, "ok": True, "rate": "24/1", "seconds": 12.5}
        self.assertEqual(lib.outputs_json(meta), {"upscaled.mp4": {"preview": "previews/upscaled.jpg", "meta": meta}})
        for bad in ({"list": [1]}, {"dict": {}}, {"long": "x" * 1001}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                lib.outputs_json(bad)


class FailureTest(unittest.TestCase):
    def result(self, reason, last=None, tried=(21,), batch=None):
        return lib.LadderResult(False, reason, batch or tried[-1], list(tried), last or lib.Attempt(code=1), 13000, 100.0)

    def test_codes(self):
        self.assertEqual(lib.REASON_CODES, {"vram": 1, "blind": 1, "refused": 1, "startup": 1, "exit": 1, "time": 4, "oom": 4, "bad-env": 3})

    def test_every_reason_says_what_happened(self):
        vram = lib.Attempt(code=-9, stopped=lib.Stopped("vram", used_mib=15400, limit_mib=15311))
        self.assertRegex(lib.failure_lines(self.result("vram", vram), 3)[0], r"VRAM watchdog: the card had 15400 MiB in use, over the limit of 15311")
        blind = lib.Attempt(code=-9, stopped=lib.Stopped("blind", polls=3))
        self.assertRegex(lib.failure_lines(self.result("blind", blind), 3)[0], r"nvidia-smi gave no reading 3 times in a row")
        self.assertRegex(lib.failure_lines(self.result("time", tried=(21, 13)), 3)[0], r"after 150 min, .*batches tried: 21 -> 13")
        self.assertRegex(lib.failure_lines(self.result("oom", tried=(21, 13, 9)), 3)[0], r"out of memory at batch 9 \(tried 21 -> 13 -> 9\)")
        refused = lib.Attempt(code=10, refused="[capped] refused: nothing left")
        self.assertRegex(lib.failure_lines(self.result("refused", refused), 3)[0], r"^not started: \[capped\] refused: nothing left")
        startup = lib.Attempt(code=1, early_out_of_memory=True, tail=["CUDA error: out of memory"])
        lines = lib.failure_lines(self.result("startup", startup), 3)
        self.assertRegex(lines[0], r"before SeedVR2 began processing")
        self.assertIn("  | CUDA error: out of memory", lines)
        other = lib.Attempt(code=7, tail=["Traceback", "KeyError: x"])
        lines = lib.failure_lines(self.result("exit", other), 3)
        self.assertRegex(lines[0], r"SeedVR2 ended with exit code 7 at batch 21")
        self.assertEqual(lines[1:], ["  | Traceback", "  | KeyError: x"])
        bad = lib.Attempt(code=11, tail=["[capped] UPSCALE_FREE_MIB='x' is not a number"])
        self.assertRegex(lib.failure_lines(self.result("bad-env", bad), 3)[0], r"a bug in this pack")

    def test_a_smaller_overlap_only_when_the_overlap_stopped_the_ladder(self):
        blocked = lib.failure_lines(self.result("oom", tried=(29, 21, 13)), 10)[0]
        self.assertTrue(blocked.endswith("; or a smaller overlap"), blocked)
        for tried in ((9,), (21, 13, 9)):
            with self.subTest(tried=tried):
                line = lib.failure_lines(self.result("oom", tried=tried), 3)[0]
                self.assertNotIn("smaller overlap", line)


if __name__ == "__main__":
    unittest.main()
