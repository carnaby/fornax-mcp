"""Shared by the upscale pack's scripts: paths inside the pack, the pinned upstream, exit codes, UTF-8 streams,
log and progress lines."""
import json
import os
import sys
from pathlib import Path

PACK = Path(__file__).resolve().parent.parent
SCRIPTS = PACK / "scripts"
ENV = PACK / "env"
# Everything the setup installs stays inside {pack}/env: deleting the pack deletes all of it.
SEEDVR2_DIR = ENV / "seedvr2"
MODELS_DIR = ENV / "models"
UV_VENV = ENV / "uv"
PYTHON_DIR = ENV / "python"
UV_CACHE = ENV / ".uv-cache"

OK, FAILED, INVALID, ENVIRONMENT, PERMANENT = 0, 1, 2, 3, 4

# The versions SeedVR2 was measured with (CPython 3.13.18, PyTorch 2.11.0 with CUDA 12.8).
PYTHON_VERSION = "3.13.18"
UV_VERSION = "0.13.8"
SEEDVR2_REPO = "https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler"
SEEDVR2_COMMIT = "4490bd1f482e026674543386bb2a4d176da245b9"
SEEDVR2_ZIP_URL = f"{SEEDVR2_REPO}/archive/{SEEDVR2_COMMIT}.zip"
SEEDVR2_ZIP_SHA256 = "04c61842bc00fd8673e6bc9a3b1b1935955461f363791070ed14d67d2a2e77fb"
MODELS_URL = "https://huggingface.co/numz/SeedVR2_comfyUI/resolve/main/"
DIT_MODEL = "seedvr2_ema_3b_fp16.safetensors"
VAE_MODEL = "ema_vae_fp16.safetensors"
MODELS = {
    DIT_MODEL: (6783018808, "2fd0e03a3dad24e07086750360727ca437de4ecd456f769856e960ae93e2b304"),
    VAE_MODEL: (501324814, "20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1"),
}
# SeedVR2's CLI defaults, which the measurements used; not passed, recorded in the output's meta.
SEED = 42
COLOR_CORRECTION = "lab"


class Exit(Exception):
    """Ends the script with `code` after saying `message`."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def venv_python(venv):
    return Path(venv) / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def setup_streams():
    # Windows pipes default to a legacy code page; the worker reads UTF-8.
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")


def say(message):
    print(f"upscale: {message}", file=sys.stderr, flush=True)


def progress(fraction, message):
    """One progress line for the worker."""
    sys.stdout.write(json.dumps({"progress": round(min(max(fraction, 0.0), 1.0), 4), "message": message}) + "\n")
    sys.stdout.flush()


def fail(code, message):
    say(message)
    sys.exit(code)


def is_ascii_path(path):
    return all(ord(c) < 128 for c in str(path))
