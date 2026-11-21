"""The voices of the tts pack agree everywhere: voices.json, the files in voices/ and the enums in type.yaml (spec 10
§ 7). type.yaml is read with regular expressions: the tests have the standard library only."""
import json
import re
import unittest
import wave
from pathlib import Path

PACK = Path(__file__).resolve().parent.parent
VOICES_DIR = PACK / "voices"


def enum_of(param):
    """The enum list of one parameter line in type.yaml, e.g. `voice:  { enum: [lili, klara, peter], ... }`."""
    text = (PACK / "type.yaml").read_text(encoding="utf-8")
    m = re.search(r"^\s+" + param + r":\s*\{\s*enum:\s*\[([^\]]*)\]", text, re.MULTILINE)
    assert m, f"no enum for {param} in type.yaml"
    return [v.strip() for v in m.group(1).split(",")]


class VoicesTest(unittest.TestCase):
    def setUp(self):
        self.voices = json.loads((VOICES_DIR / "voices.json").read_text(encoding="utf-8"))

    def test_the_voice_enum_is_lili_and_the_omnivoice_voices(self):
        self.assertEqual(enum_of("voice"), ["lili", *self.voices])

    def test_every_voice_has_exactly_its_file_and_nothing_else_lies_there(self):
        files = {entry["file"] for entry in self.voices.values()}
        self.assertEqual(len(files), len(self.voices))
        present = {p.name for p in VOICES_DIR.iterdir()}
        self.assertEqual(present, files | {"voices.json"})

    def test_every_reference_is_24_khz_mono_16_bit_and_3_to_10_seconds(self):
        for name, entry in self.voices.items():
            with wave.open(str(VOICES_DIR / entry["file"]), "rb") as w:
                self.assertEqual((w.getframerate(), w.getnchannels(), w.getsampwidth()), (24000, 1, 2), name)
                seconds = w.getnframes() / w.getframerate()
            self.assertTrue(3 <= seconds <= 10, f"{name}: {seconds} s")

    def test_every_voice_has_its_sentence_and_origin(self):
        for name, entry in self.voices.items():
            self.assertTrue(entry["text"].strip(), name)
            self.assertEqual(entry["origin"]["model"], "k2-fsa/OmniVoice", name)
            self.assertEqual(len(entry["origin"]["revision"]), 40, name)


if __name__ == "__main__":
    unittest.main()
