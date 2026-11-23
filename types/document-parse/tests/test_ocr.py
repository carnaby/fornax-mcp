import contextlib
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import common  # noqa: E402
import ocr  # noqa: E402


def fake_torch(log, cuda=True):
    return types.SimpleNamespace(
        bfloat16="bfloat16",
        inference_mode=contextlib.nullcontext,
        cuda=types.SimpleNamespace(is_available=lambda: cuda, max_memory_allocated=lambda: 2400 * 2**20),
    )


def fake_transformers(log):
    class Inputs(dict):
        def to(self, device):
            log.append(("inputs to", device))
            return self

    class Ids:
        def __getitem__(self, key):
            log.append(("slice", key[1].start))
            return "NEW IDS"

    class Processor:
        def apply_chat_template(self, messages, **kwargs):
            content = messages[0]["content"]
            log.append(("template", content[0]["image"], content[1]["text"], kwargs))
            return Inputs(input_ids=types.SimpleNamespace(shape=(1, 7)))

        def batch_decode(self, ids, skip_special_tokens):
            log.append(("decode", ids, skip_special_tokens))
            return ["  Text strany.\n"]

    class Model:
        def to(self, device):
            log.append(("model to", device))
            return self

        def eval(self):
            return self

        def generate(self, **kwargs):
            log.append(("generate", {k: v for k, v in kwargs.items() if k != "input_ids"}))
            return Ids()

    class PaddleOCRVLForConditionalGeneration:
        @staticmethod
        def from_pretrained(path, dtype):
            log.append(("from_pretrained", path, dtype))
            return Model()

    class AutoProcessor:
        @staticmethod
        def from_pretrained(path):
            log.append(("processor", path))
            return Processor()

    return types.SimpleNamespace(PaddleOCRVLForConditionalGeneration=PaddleOCRVLForConditionalGeneration, AutoProcessor=AutoProcessor)


class GenerateTest(unittest.TestCase):
    def test_the_cache_is_always_on(self):
        self.assertEqual(ocr.generate_kwargs(4096), {"max_new_tokens": 4096, "do_sample": False, "use_cache": True})
        self.assertEqual(ocr.generate_kwargs(33, 1.05), {"max_new_tokens": 33, "do_sample": False, "use_cache": True, "repetition_penalty": 1.05})


class EngineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.log = []
        # Small stand-ins for the pinned PaddleOCR-VL files, and the pins pointed at them.
        small = {}
        for rel, (url, _size, sha) in common.MODEL_FILES.items():
            if rel.startswith("paddleocr-vl/"):
                path = self.dir / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"fake")
                small[rel] = (url, 4, sha)
        for name, value in (("MODELS_DIR", self.dir), ("MODEL_FILES", small)):
            patcher = mock.patch.object(common, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def modules(self, cuda=True):
        return mock.patch.dict(sys.modules, {"torch": fake_torch(self.log, cuda), "transformers": fake_transformers(self.log)})

    def test_the_model_loads_once_from_its_folder_in_bfloat16_on_the_card(self):
        with self.modules():
            engine = ocr.PaddleOcr()
        folder = str(self.dir / "paddleocr-vl")
        self.assertEqual(self.log, [("from_pretrained", folder, "bfloat16"), ("model to", "cuda"), ("processor", folder)])

    def test_a_page_is_read_greedily_with_the_cache(self):
        with self.modules():
            engine = ocr.PaddleOcr()
            self.log.clear()
            text = engine.read("PAGE IMAGE", 4096)
        self.assertEqual(text, "Text strany.")
        self.assertEqual(self.log[0], ("template", "PAGE IMAGE", "OCR:", {"tokenize": True, "add_generation_prompt": True, "return_dict": True, "return_tensors": "pt"}))
        self.assertEqual(self.log[1], ("inputs to", "cuda"))
        self.assertEqual(self.log[2], ("generate", {"max_new_tokens": 4096, "do_sample": False, "use_cache": True}))
        self.assertEqual(self.log[3], ("slice", 7))  # only the new tokens are decoded
        self.assertEqual(self.log[4], ("decode", "NEW IDS", True))

    def test_a_region_gets_its_limit_and_the_penalty(self):
        with self.modules():
            engine = ocr.PaddleOcr()
            self.log.clear()
            engine.read("CROP", 33, 1.05)
        self.assertEqual(self.log[2], ("generate", {"max_new_tokens": 33, "do_sample": False, "use_cache": True, "repetition_penalty": 1.05}))

    def test_peak_vram(self):
        with self.modules():
            self.assertEqual(ocr.PaddleOcr().peak_vram_mib(), 2400)

    def test_missing_files_and_no_cuda_are_unavailable(self):
        with self.modules(cuda=False), self.assertRaisesRegex(common.Unavailable, r"^PyTorch sees no CUDA device: install or update the NVIDIA driver$"):
            ocr.PaddleOcr()
        (self.dir / "paddleocr-vl" / "model.safetensors").unlink()
        with self.modules(), self.assertRaisesRegex(common.Unavailable, r"paddleocr-vl/model\.safetensors is missing .*: run fornax types setup document-parse$"):
            ocr.PaddleOcr()
        self.assertNotIn("from_pretrained", [entry[0] for entry in self.log])


if __name__ == "__main__":
    unittest.main()
