import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import check  # noqa: E402

WHISPER = {"faster_whisper": "1.2.0", "ctranslate2": "4.6.0", "cuda_devices": 1}


class EnvironmentLineTest(unittest.TestCase):
    def test_with_speaker_recognition(self):
        diarize = {"cuda": True, "torch": "2.8.0", "gpu": "Fake GPU", "model_cached": True}
        self.assertEqual(check.environment_line(WHISPER, diarize),
                         "fornax-environment: faster-whisper 1.2.0, CTranslate2 4.6.0; speaker recognition on (PyTorch 2.8.0)")

    def test_without_speaker_recognition(self):
        for diarize in (None, {"cuda": False, "torch": "2.8.0"}, {"cuda": True, "torch": "2.8.0", "gpu": "G", "model_cached": False}):
            with self.subTest(diarize=diarize):
                self.assertEqual(check.environment_line(WHISPER, diarize),
                                 "fornax-environment: faster-whisper 1.2.0, CTranslate2 4.6.0; speaker recognition off")


if __name__ == "__main__":
    unittest.main()
