"""Shared by the transcribe pack's scripts: paths inside the pack, UTF-8 streams, progress lines, exit codes."""
import glob
import json
import os
import sys
from pathlib import Path

PACK = Path(__file__).resolve().parent.parent
SCRIPTS = PACK / "scripts"
ENV = PACK / "env"
DIARIZE_ENV = ENV / "diarize"
# Every model download and cache stays inside the pack: nothing outside {pack}/env changes.
HF_HOME = ENV / "hf"

OK, FAILED, INVALID, ENVIRONMENT = 0, 1, 2, 3
# diarize.py: the pyannote model is not downloaded (or its conditions not accepted).
MODEL_MISSING = 4


def venv_python(venv):
    return Path(venv) / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def setup_streams():
    # Windows pipes default to a legacy code page; the worker reads UTF-8.
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")


def use_pack_cache():
    """Called before huggingface_hub is imported: models live in {pack}/env/hf, and nothing is reported home."""
    os.environ["HF_HOME"] = str(HF_HOME)
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"


def child_env():
    """The environment for whisper.py: on Linux the CUDA libraries of the nvidia-* wheels must be on the loader's path."""
    env = dict(os.environ)
    if os.name != "nt":
        libs = sorted(glob.glob(str(ENV / "lib" / "python3*" / "site-packages" / "nvidia" / "*" / "lib")))
        if libs:
            env["LD_LIBRARY_PATH"] = os.pathsep.join(libs + ([env["LD_LIBRARY_PATH"]] if env.get("LD_LIBRARY_PATH") else []))
    return env


def progress(fraction, message):
    """One progress line for the worker (spec 6.4)."""
    sys.stdout.write(json.dumps({"progress": round(min(max(fraction, 0.0), 1.0), 4), "message": message}) + "\n")
    sys.stdout.flush()


def fail(code, message):
    print(f"transcribe: {message}", file=sys.stderr, flush=True)
    sys.exit(code)


def clock(ms):
    s = max(0, int(ms // 1000))
    return f"{s // 3600}:{s // 60 % 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"
