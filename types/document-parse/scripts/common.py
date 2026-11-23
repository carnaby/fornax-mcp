"""Shared by the document-parse pack's scripts: paths inside the pack, the pinned model files, exit codes, UTF-8
streams, log and progress lines, the environment the libraries get, and the check of the model files."""
import json
import os
import sys
from pathlib import Path

PACK = Path(__file__).resolve().parent.parent
SCRIPTS = PACK / "scripts"
ENV = PACK / "env"
# Everything the setup installs stays inside {pack}/env: deleting the pack deletes all of it.
MODELS_DIR = ENV / "models"
DOCLING_DIR = MODELS_DIR / "docling"  # Docling's artifacts_path
PADDLE_DIR = MODELS_DIR / "paddleocr-vl"
UV_VENV = ENV / "uv"
PYTHON_DIR = ENV / "python"
UV_CACHE = ENV / ".uv-cache"

OK, FAILED, INVALID, ENVIRONMENT = 0, 1, 2, 3

# The versions the 2026-11-23 probe measured (CPython 3.12.16, PyTorch 2.8.0 with CUDA 12.8).
PYTHON_VERSION = "3.12.16"
UV_VERSION = "0.13.8"

PADDLE_REPO = "PaddlePaddle/PaddleOCR-VL-1.6"
PADDLE_REVISION = "132c45f52c0a26ed5a6b2f6bd8e3985794cc27dd"
_HF = "https://huggingface.co/"
_PADDLE = f"{_HF}{PADDLE_REPO}/resolve/{PADDLE_REVISION}/"
_HERON = f"{_HF}docling-project/docling-layout-heron/resolve/8f39ad3c0b4c58e9c2d2c84a38465abf757272d8/"
_TABLES = f"{_HF}docling-project/docling-models/resolve/2199320848bb9a8a519d22e4b528185a4f9a6f64/"
_RAPID = "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/"
_HERON_DIR = "docling/docling-project--docling-layout-heron/"
_TABLES_DIR = "docling/docling-project--docling-models/"
_ACCURATE = "model_artifacts/tableformer/accurate/"

# Every file a job reads: path under env/models -> (url, size, sha256). The docling/ part is laid out the way Docling
# reads it through artifacts_path (as docling-tools models download writes it); checked offline on 2026-11-23.
MODEL_FILES = {
    "paddleocr-vl/model.safetensors": (_PADDLE + "model.safetensors", 1917255968, "85a479d506a11e724e7285d395c551be69f41dbc16b6342d3cacfb189aed71db"),
    "paddleocr-vl/tokenizer.json": (_PADDLE + "tokenizer.json", 11189060, "c8a215a59183d0d0781adc33bacd3ce6162716f7fd568fb30234a74d69803a7d"),
    "paddleocr-vl/tokenizer.model": (_PADDLE + "tokenizer.model", 1614363, "34ef7db83df785924fb83d7b887b6e822a031c56e15cff40aaf9b982988180df"),
    "paddleocr-vl/tokenizer_config.json": (_PADDLE + "tokenizer_config.json", 186947, "1f979337347cc0cb72a6282d8a23ed183539aa81a87a906f022aee2bab83c7c5"),
    "paddleocr-vl/added_tokens.json": (_PADDLE + "added_tokens.json", 25381, "f59f889088e0fe21c523e7cf121bb6dca3b0bb148cb7159fbb4572c74dfc5644"),
    "paddleocr-vl/special_tokens_map.json": (_PADDLE + "special_tokens_map.json", 1151, "d3a125c03103deb2acaf7730791bdbbf196f620e5a2213b664511ff9b4b25bab"),
    "paddleocr-vl/config.json": (_PADDLE + "config.json", 2059, "ce7f4565f8b1db78532ad5d1b9ebe55c2139d49bd4cb04778b580a08a598f171"),
    "paddleocr-vl/generation_config.json": (_PADDLE + "generation_config.json", 133, "a6701d78ab3b4d972307cdec3b69d4c13f46e0d5140514f50ab7d84259324b94"),
    "paddleocr-vl/preprocessor_config.json": (_PADDLE + "preprocessor_config.json", 641, "111872ab1e8bb7fd040ac5087bfced7ab8f011f02139b088cba294964c3b1d0e"),
    "paddleocr-vl/processor_config.json": (_PADDLE + "processor_config.json", 137, "1568858960a9760c54431dae693a6152e601ff55cdf6d2eab97a4a99958faea0"),
    "paddleocr-vl/chat_template.jinja": (_PADDLE + "chat_template.jinja", 1474, "2f27812dab7f333e471884e0c803d807f11953d5453140dfb1aaba234f872bc8"),
    _HERON_DIR + "config.json": (_HERON + "config.json", 3268, "fdea30805ce2f5666b147fca941dcdd27ad468e27d6ed21902207d3da056a97d"),
    _HERON_DIR + "model.safetensors": (_HERON + "model.safetensors", 171658996, "00333a43451945aaf89db8ca9c0a17e75d1537c17db60fdb91aa95f4c7929e0c"),
    _HERON_DIR + "preprocessor_config.json": (_HERON + "preprocessor_config.json", 444, "cd38cd59999e7a95d68e487fbe5132df3d4e5c32a0836add57e6126ba0c4eaf1"),
    _TABLES_DIR + "config.json": (_TABLES + "config.json", 41, "9c34024dc28ff47b75818f415e769809798c29bf9bde6f2ccc63a4acb62396d9"),
    _TABLES_DIR + _ACCURATE + "tableformer_accurate.safetensors": (_TABLES + _ACCURATE + "tableformer_accurate.safetensors", 212758388, "2a7d6c924b3cd12fb99a09280ca9c33a89c5d60b93253617d2e088c1a40374d9"),
    _TABLES_DIR + _ACCURATE + "tm_config.json": (_TABLES + _ACCURATE + "tm_config.json", 7060, "984e122ceb8ccf84d84c9d2882f6f2302a44b4f1e577babd6289892c36f3cffd"),
    "docling/RapidOcr/PP-OCRv6_det_small.onnx": (_RAPID + "PP-OCRv6/det/PP-OCRv6_det_small.onnx", 9929594, "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f"),
    "docling/RapidOcr/PP-OCRv6_rec_small.onnx": (_RAPID + "PP-OCRv6/rec/PP-OCRv6_rec_small.onnx", 21234383, "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884"),
    "docling/RapidOcr/ch_ppocr_mobile_v2.0_cls_mobile.onnx": (_RAPID + "PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx", 585532, "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c"),
}


class Unavailable(Exception):
    """A model file, a library or CUDA is missing (run.py exits 3)."""


def venv_python(venv):
    return Path(venv) / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def setup_streams():
    # Windows pipes default to a legacy code page; the worker reads UTF-8.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):  # a stream put in its place (a test's StringIO) is already text
            stream.reconfigure(encoding="utf-8", errors="replace")


def say(message):
    print(f"document-parse: {message}", file=sys.stderr, flush=True)


def progress(fraction, message):
    """One progress line for the worker."""
    sys.stdout.write(json.dumps({"progress": round(min(max(fraction, 0.0), 1.0), 4), "message": message}) + "\n")
    sys.stdout.flush()


def library_env():
    """The libraries' caches inside env/ and never the network (spec 11 § 4.7); set before they are imported."""
    return {
        "HF_HOME": str(ENV / "hf"),
        "HF_HUB_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "TORCH_HOME": str(ENV / "torch"),
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
    }


def file_problems(root, files):
    """A sentence for each pinned file that is missing under `root` or has another size (sha256 is the setup's job)."""
    out = []
    for rel, (_url, size, _sha256) in files.items():
        path = Path(root) / rel
        if not path.is_file():
            out.append(f"{rel} is missing in {root}")
        elif path.stat().st_size != size:
            out.append(f"{rel} in {root} has {path.stat().st_size} bytes, not {size}")
    return out


def model_problems(prefix):
    """file_problems for the pinned files whose path starts with `prefix` ("" = all of them)."""
    current = sys.modules[__name__]  # read through the module: tests patch MODELS_DIR and MODEL_FILES
    files = {rel: pin for rel, pin in current.MODEL_FILES.items() if rel.startswith(prefix)}
    return file_problems(current.MODELS_DIR, files)
