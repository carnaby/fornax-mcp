"""Shared by the tts pack's scripts: paths inside the pack, the pinned models, exit codes, UTF-8 streams, log and
progress lines, the environment the model libraries get, and the checks of the model files and voices."""
import json
import os
import sys
from pathlib import Path

PACK = Path(__file__).resolve().parent.parent
SCRIPTS = PACK / "scripts"
VOICES_DIR = PACK / "voices"
ENV = PACK / "env"
# Everything the setup installs stays inside {pack}/env: deleting the pack deletes all of it.
MODELS_DIR = ENV / "models"
OMNIVOICE_DIR = MODELS_DIR / "omnivoice"
PIPER_DIR = MODELS_DIR / "piper"
UV_VENV = ENV / "uv"
PYTHON_DIR = ENV / "python"
UV_CACHE = ENV / ".uv-cache"

OK, FAILED, INVALID, ENVIRONMENT = 0, 1, 2, 3

# The versions the 2026-11-21 probe measured (CPython 3.12.16, PyTorch 2.8.0 with CUDA 12.8).
PYTHON_VERSION = "3.12.16"
UV_VERSION = "0.13.8"
SEED = 42

OMNIVOICE_REPO = "k2-fsa/OmniVoice"
OMNIVOICE_REVISION = "3fc979d1cd72492cd679c5ac2611e0d7ac047ba1"
OMNIVOICE_URL = f"https://huggingface.co/{OMNIVOICE_REPO}/resolve/{OMNIVOICE_REVISION}/"
# The files OmniVoice.from_pretrained reads from a local folder (spec 10 § 3.2 step 4): size, sha256.
OMNIVOICE_FILES = {
    "config.json": (2238, "5e359117e13b420c5e0c925d4aba650d624767131f1d1746928f8b850d5dc372"),
    "chat_template.jinja": (4168, "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8"),
    "model.safetensors": (2450344112, "730839316de585f4c8298ec0e1712efc10fb19c6fa4e36eb741cb8d51ebcf6aa"),
    "tokenizer.json": (11423986, "408f669b7e2b045fdf54201d815bd364e6667dbd845115da81239c40bc6dcfd1"),
    "tokenizer_config.json": (533, "49f78845596a82bf15c83673794bdf9f76f812b11f60ab6a2239d9be65b00676"),
    "audio_tokenizer/config.json": (2531, "eefb20806f7104e77c9a5277c9df0f9bb8826b08eb1d4e8ab2b9829b6ef9fac1"),
    "audio_tokenizer/model.safetensors": (805665628, "fe7c5e8785e0a05833e1bfc3e002ec7f55af21e306b2e7154a448c1f54ccfb0d"),
    "audio_tokenizer/preprocessor_config.json": (206, "ae61eea88558608ee2fa86d2aec9fce8d99a5ff75d09cb7651ccce21ae1d9084"),
}
PIPER_REPO = "rhasspy/piper-voices"
PIPER_REVISION = "e9c8a39444359388adaa94255becb37a5a2b8e51"
PIPER_VOICE = "sk_SK-lili-medium"
PIPER_URL = f"https://huggingface.co/{PIPER_REPO}/resolve/{PIPER_REVISION}/sk/sk_SK/lili/medium/"
PIPER_FILES = {
    f"{PIPER_VOICE}.onnx": (63221984, "5e157712483b66d99289e663ca5728bceb4b4e48d84d837c58796b2f9690de16"),
    f"{PIPER_VOICE}.onnx.json": (6151, "3dd2ed090b681d8ddd9117c8413d9c8a5b56e6845b7bdcae8e2269447917e464"),
}


def venv_python(venv):
    return Path(venv) / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def setup_streams():
    # Windows pipes default to a legacy code page; the worker reads UTF-8.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):  # a stream put in its place (a test's StringIO) is already text
            stream.reconfigure(encoding="utf-8", errors="replace")


def say(message):
    print(f"tts: {message}", file=sys.stderr, flush=True)


def progress(fraction, message):
    """One progress line for the worker."""
    sys.stdout.write(json.dumps({"progress": round(min(max(fraction, 0.0), 1.0), 4), "message": message}) + "\n")
    sys.stdout.flush()


def library_env():
    """The model libraries' caches inside env/ and never the network (spec 10 § 4.8); set before they are imported."""
    return {
        "HF_HOME": str(ENV / "hf"),
        "HF_HUB_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "TORCH_HOME": str(ENV / "torch"),
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
    }


def file_problems(folder, files):
    """A sentence for each pinned file that is missing under `folder` or has another size (sha256 is the setup's job)."""
    out = []
    for rel, (size, _sha256) in files.items():
        path = Path(folder) / rel
        if not path.is_file():
            out.append(f"{rel} is missing in {folder}")
        elif path.stat().st_size != size:
            out.append(f"{rel} in {folder} has {path.stat().st_size} bytes, not {size}")
    return out


def load_voices(folder=None):
    """voices.json: {name: {"file": ..., "text": ..., "origin": {...}}} (spec 10 § 3.1)."""
    folder = Path(folder or VOICES_DIR)
    return json.loads((folder / "voices.json").read_text(encoding="utf-8"))


def voice_problems(folder=None, names=None):
    """A sentence when voices.json cannot be read or is not an object of voices, or for each voice (of `names` when
    given; a name voices.json does not hold is the caller's to report) that lacks a file and a text or whose clip is
    missing."""
    folder = Path(folder or VOICES_DIR)
    try:
        voices = load_voices(folder)
    except (OSError, ValueError) as e:
        return [f"voices.json in {folder} cannot be read ({e})"]
    if not isinstance(voices, dict):
        return [f"voices.json in {folder} does not hold an object of voices"]
    out = []
    for name, entry in voices.items():
        if names is not None and name not in names:
            continue
        if not (isinstance(entry, dict) and isinstance(entry.get("file"), str) and entry["file"] and isinstance(entry.get("text"), str)):
            out.append(f"the voice {name} in voices.json needs a file and a text")
        elif not (folder / entry["file"]).is_file():
            out.append(f"the voice {name} has no {entry['file']} in {folder}")
    return out
