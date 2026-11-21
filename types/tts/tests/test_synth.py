import array
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import common  # noqa: E402
import synth  # noqa: E402


class FakeArray:
    """What numpy gives the engines: astype("<f4").tobytes()."""

    def __init__(self, values):
        self.values = list(values)

    def astype(self, dtype):
        assert dtype == "<f4", dtype
        return self

    def tobytes(self):
        a = array.array("f", self.values)
        if sys.byteorder == "big":
            a.byteswap()
        return a.tobytes()


def fake_piper(log):
    class SynthesisConfig:
        def __init__(self, length_scale=None):
            self.length_scale = length_scale

    class Voice:
        config = types.SimpleNamespace(sample_rate=22050, length_scale=1.2)

        def synthesize(self, text, syn_config=None):
            log.append(("synthesize", text, syn_config.length_scale))
            for _ in range(2):  # one chunk per sentence
                yield types.SimpleNamespace(audio_float_array=FakeArray([0.1] * 5), sample_rate=22050)

    class PiperVoice:
        @staticmethod
        def load(path):
            log.append(("load", path))
            return Voice()

    return types.SimpleNamespace(PiperVoice=PiperVoice, SynthesisConfig=SynthesisConfig)


def fake_torch(log, cuda=True):
    return types.SimpleNamespace(
        float16="float16",
        manual_seed=lambda seed: log.append(("seed", seed)),
        cuda=types.SimpleNamespace(is_available=lambda: cuda, max_memory_allocated=lambda: 3 * 2**30),
    )


def fake_omnivoice(log):
    class Model:
        sampling_rate = 24000

        def create_voice_clone_prompt(self, ref_audio, ref_text):
            log.append(("prompt", ref_audio, ref_text))
            return "PROMPT"

        def generate(self, text, language, voice_clone_prompt, speed):
            log.append(("generate", text, language, voice_clone_prompt, speed))
            return [FakeArray([0.2] * 7)]

    class OmniVoice:
        @staticmethod
        def from_pretrained(path, device_map, dtype):
            log.append(("from_pretrained", path, device_map, dtype))
            return Model()

    return types.SimpleNamespace(OmniVoice=OmniVoice)


class EngineCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.log = []
        # Small stand-ins for the pinned files, and the pins pointed at them.
        for folder, files in (("omnivoice", common.OMNIVOICE_FILES), ("piper", common.PIPER_FILES)):
            for rel in files:
                path = self.dir / folder / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"fake")
        small = lambda files: {rel: (4, sha) for rel, (_size, sha) in files.items()}  # noqa: E731
        for name, value in (("OMNIVOICE_DIR", self.dir / "omnivoice"), ("PIPER_DIR", self.dir / "piper"),
                            ("OMNIVOICE_FILES", small(common.OMNIVOICE_FILES)), ("PIPER_FILES", small(common.PIPER_FILES))):
            patcher = mock.patch.object(common, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def modules(self, cuda=True):
        return mock.patch.dict(sys.modules, {"piper": fake_piper(self.log), "torch": fake_torch(self.log, cuda), "omnivoice": fake_omnivoice(self.log)})


class PiperTest(EngineCase):
    def test_piper_speaks_whole_paragraphs_from_its_pinned_voice(self):
        with self.modules():
            engine = synth.load("piper", "lili")
            pcm = engine.speak("Prvá. Druhá.", 1.0)
        self.assertEqual(self.log[0], ("load", str(self.dir / "piper" / "sk_SK-lili-medium.onnx")))
        self.assertEqual((engine.sample_rate, engine.per_paragraph), (22050, True))
        self.assertEqual(len(pcm), 2 * 5 * 4)
        self.assertEqual(engine.meta(), {"model_repo": "rhasspy/piper-voices", "revision": common.PIPER_REVISION, "piper_voice": "sk_SK-lili-medium"})

    def test_piper_speed_scales_the_voices_length_scale(self):
        with self.modules():
            engine = synth.load("piper", "lili")
            engine.speak("A.", 2.0)
            engine.speak("A.", 0.5)
        scales = [entry[2] for entry in self.log if entry[0] == "synthesize"]
        self.assertAlmostEqual(scales[0], 0.6)
        self.assertAlmostEqual(scales[1], 2.4)

    def test_missing_files_are_unavailable(self):
        (self.dir / "piper" / "sk_SK-lili-medium.onnx").unlink()
        with self.modules(), self.assertRaisesRegex(synth.Unavailable, r"sk_SK-lili-medium\.onnx is missing .*: run fornax types setup tts$"):
            synth.load("piper", "lili")


class OmniVoiceTest(EngineCase):
    def test_the_voice_is_prepared_once_and_every_chunk_is_seeded(self):
        with self.modules():
            engine = synth.load("omnivoice", "klara")
            first = engine.speak("Prvý kúsok.", 1.25)
            engine.speak("Druhý kúsok.", 1.25)
        voices = json.loads((common.VOICES_DIR / "voices.json").read_text(encoding="utf-8"))
        self.assertEqual(self.log[0], ("from_pretrained", str(self.dir / "omnivoice"), "cuda:0", "float16"))
        self.assertEqual(self.log[1], ("prompt", str(common.VOICES_DIR / "klara.wav"), voices["klara"]["text"]))
        self.assertEqual(self.log[2:], [
            ("seed", 42), ("generate", "Prvý kúsok.", "sk", "PROMPT", 1.25),
            ("seed", 42), ("generate", "Druhý kúsok.", "sk", "PROMPT", 1.25),
        ])
        self.assertEqual((engine.sample_rate, engine.per_paragraph, len(first)), (24000, False, 7 * 4))
        self.assertEqual(engine.meta(), {"model_repo": "k2-fsa/OmniVoice", "revision": common.OMNIVOICE_REVISION, "seed": 42, "peak_vram_mib": 3072})

    def test_no_cuda_is_unavailable(self):
        with self.modules(cuda=False), self.assertRaisesRegex(synth.Unavailable, r"PyTorch sees no CUDA device"):
            synth.load("omnivoice", "klara")

    def test_a_missing_voice_is_unavailable(self):
        voices = self.dir / "voices"
        voices.mkdir()
        (voices / "voices.json").write_text(json.dumps({"klara": {"file": "klara.wav", "text": "A."}}), encoding="utf-8")
        with mock.patch.object(common, "VOICES_DIR", voices), self.modules():
            with self.assertRaisesRegex(synth.Unavailable, r"the voice klara has no klara\.wav"):
                synth.load("omnivoice", "klara")
            (voices / "klara.wav").write_bytes(b"RIFF")
            with self.assertRaisesRegex(synth.Unavailable, r"there is no voice peter in "):
                synth.load("omnivoice", "peter")


if __name__ == "__main__":
    unittest.main()
