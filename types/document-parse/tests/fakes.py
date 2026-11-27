"""Stand-ins for the document-parse pack's run.py tests: fake convert and ocr modules (no Docling, no model) and a pack
folder with the real scripts; wrap_run.py runs run.py with the fakes in place of convert and ocr."""
import json
import shutil
from pathlib import Path

PACK_SRC = Path(__file__).resolve().parent.parent

# behavior.json next to them:
#   mode ok | unavailable | import-error | load-error (the OCR model does not load)
#   pdf_chars (text layer per page, default [1500, 1500]); pdf_error "password"; image_frames (default 1);
#   image_error (Pillow's message); markdown, tables, text_pages (the text path); convert_error (Docling raises);
#   full (the page text of the OCR path: a string, or a list per page); regions ([[label, text], ...] per page);
#   fail_at_page (the full read of that page runs out of memory); block_outputs (a folder made where an output goes);
#   convert_seconds (the text path's conversion takes this long), tick_s (run.TICK_S for the test).
FAKE_CONVERT = '''import json, os, sys, time
import common
import parse_lib as lib
HERE = os.path.dirname(os.path.abspath(__file__))
B = json.load(open(os.path.join(HERE, "behavior.json"), encoding="utf-8"))
NL = chr(10)


def log(entry):
    with open(os.path.join(HERE, "calls.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + NL)


class FakeImage:
    def __init__(self, page, width, height):
        self.page, self.width, self.height = page, width, height


class FakeCrop:
    def __init__(self, text, width=400, height=60):
        self.text, self.width, self.height = text, width, height


def check_mode():
    mode = B.get("mode", "ok")
    if mode == "unavailable":
        raise common.Unavailable("docling/RapidOcr/PP-OCRv6_rec_small.onnx is missing in env/models: run fornax types setup document-parse")
    if mode == "import-error":
        raise ImportError("No module named 'docling'")


def pdf_profile(path):
    log({"call": "pdf_profile"})
    if B.get("pdf_error") == "password":
        raise lib.Rejected("the PDF is protected by a password: send it without one")
    return B.get("pdf_chars", [1500, 1500])


def image_frames(path, limit):
    log({"call": "image_frames"})
    if B.get("image_error"):
        raise lib.Rejected("the document is not a readable image (" + B["image_error"] + ")")
    return B.get("image_frames", 1)


def pdf_pages(path):
    for i in range(len(B.get("pdf_chars", [1500, 1500]))):
        yield FakeImage(i + 1, 1700, 2200)


def image_pages(path):
    for i in range(B.get("image_frames", 1)):
        yield FakeImage(i + 1, 864, 299)


class TextConverter:
    def __init__(self):
        check_mode()
        log({"call": "TextConverter"})
        if "tick_s" in B:
            sys.modules["run"].TICK_S = B["tick_s"]

    def convert(self, path):
        time.sleep(B.get("convert_seconds", 0))
        if B.get("convert_error"):
            raise RuntimeError(B["convert_error"])
        markdown = B.get("markdown", "# Zmluva" + NL + NL + "| a | b |" + NL + "|---|---|" + NL + "| 1 | 2 |" + NL)
        return markdown, {"name": "document", "texts": []}, B.get("text_pages", 2), B.get("tables", 1)


class Layout:
    def __init__(self):
        check_mode()
        log({"call": "Layout"})

    def regions(self, image):
        return [(label, FakeCrop(text)) for label, text in B.get("regions", [])]


def build_document(pages):
    if B.get("block_outputs"):
        os.makedirs(B["block_outputs"], exist_ok=True)
    return {"name": "document", "pages": len(pages), "texts": [p for page in pages for p in page["paragraphs"]]}


def peak_vram_mib():
    return 0
'''

FAKE_OCR = '''import json, os
import common
HERE = os.path.dirname(os.path.abspath(__file__))
B = json.load(open(os.path.join(HERE, "behavior.json"), encoding="utf-8"))
NL = chr(10)


class OutOfMemoryError(RuntimeError):
    pass


class PaddleOcr:
    def __init__(self):
        mode = B.get("mode", "ok")
        if mode == "unavailable":
            raise common.Unavailable("paddleocr-vl/model.safetensors is missing in env/models: run fornax types setup document-parse")
        if mode == "import-error":
            raise ImportError("No module named 'torch'")
        if mode == "load-error":
            raise RuntimeError("the weights are broken")

    def read(self, image, max_new_tokens, penalty=1.0):
        crop = hasattr(image, "text")
        with open(os.path.join(HERE, "calls.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps({"call": "read", "crop": crop, "max_new_tokens": max_new_tokens, "penalty": penalty}) + NL)
        if crop:
            return image.text
        if B.get("fail_at_page") == image.page:
            raise OutOfMemoryError("CUDA out of memory. Tried to allocate 2.00 GiB")
        full = B.get("full", "Prvý riadok strany." + NL + NL + "Druhý odsek.")
        return full[image.page - 1] if isinstance(full, list) else full

    def peak_vram_mib(self):
        return 2400
'''

WRAPPER = '''import sys
sys.path.insert(0, {scripts!r})
sys.path.insert(0, {fakes!r})
import fake_convert
import fake_ocr
sys.modules["convert"] = fake_convert
sys.modules["ocr"] = fake_ocr
import run
sys.exit(run.main(sys.argv[1:]))
'''


def make_pack(root, behavior=None):
    """The real scripts under root/pack, the fakes in root/fakes, root/wrap_run.py; made afresh on each call."""
    root = Path(root)
    pack = root / "pack"
    fakes = root / "fakes"
    shutil.rmtree(pack, ignore_errors=True)
    shutil.rmtree(fakes, ignore_errors=True)
    shutil.copytree(PACK_SRC / "scripts", pack / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
    fakes.mkdir()
    (fakes / "fake_convert.py").write_text(FAKE_CONVERT, encoding="utf-8")
    (fakes / "fake_ocr.py").write_text(FAKE_OCR, encoding="utf-8")
    (fakes / "behavior.json").write_text(json.dumps(behavior or {}, ensure_ascii=False), encoding="utf-8")
    (root / "wrap_run.py").write_text(WRAPPER.format(scripts=str(pack / "scripts"), fakes=str(fakes)), encoding="utf-8")
    return pack


def calls(root):
    path = Path(root) / "fakes" / "calls.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []
