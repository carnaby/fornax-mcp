#!/usr/bin/env python3
"""The tts pack's check (runs in {pack}/env, at most 120 s, without loading a model; spec 10 § 3.3): ffmpeg runs,
the model files and voices are in place, omnivoice and piper are installed, PyTorch sees CUDA. argv: --ffmpeg <ffmpeg>.
Exit 0 ready (a summary line and the fornax-environment line), 3 not ready (one sentence)."""
import argparse
import importlib.metadata
import importlib.util
import os
import platform
import subprocess
import sys

import common
from common import ENVIRONMENT, say, setup_streams


def ffmpeg_version(tool):
    """The version word of `tool -version` ("9.0.2-..." for "ffmpeg version 9.0.2-..."), or None when it does not run."""
    try:
        r = subprocess.run([tool, "-version"], stdin=subprocess.DEVNULL, capture_output=True, timeout=30,
                           text=True, encoding="utf-8", errors="replace")
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    first = next((line.strip() for line in r.stdout.splitlines() if line.strip()), "")
    words = first.split()
    if first.startswith("ffmpeg version") and len(words) > 2:
        return words[2]
    return first or "?"


def version(dist):
    try:
        return importlib.metadata.version(dist)
    except importlib.metadata.PackageNotFoundError:
        return "?"


def fail(message):
    say(message)
    sys.exit(ENVIRONMENT)


def main(argv=None):
    setup_streams()
    os.environ.update(common.library_env())
    p = argparse.ArgumentParser(prog="check.py")
    p.add_argument("--ffmpeg", required=True)
    a = p.parse_args(argv)
    ffmpeg = ffmpeg_version(a.ffmpeg)
    if ffmpeg is None:
        fail("ffmpeg does not run: check tools.ffmpeg in worker.yaml")
    problems = common.file_problems(common.OMNIVOICE_DIR, common.OMNIVOICE_FILES) + common.file_problems(common.PIPER_DIR, common.PIPER_FILES)
    if problems:
        fail("; ".join(problems) + ": run fornax types setup tts")
    problems = common.voice_problems()
    if problems:
        fail("; ".join(problems))
    for module in ("omnivoice", "piper"):
        if importlib.util.find_spec(module) is None:
            fail(f"{module} is not installed in this pack: run fornax types setup tts")
    try:
        import torch
    except Exception as e:  # a broken env raises anything at import
        fail(f"PyTorch does not load ({e}): run fornax types setup tts")
    if not torch.cuda.is_available():
        fail("PyTorch sees no CUDA device: install or update the NVIDIA driver")
    environment = (f"PyTorch {torch.__version__} (CUDA {torch.version.cuda}), omnivoice {version('omnivoice')}, "
                   f"piper-tts {version('piper-tts')}, ffmpeg {ffmpeg}; {torch.cuda.get_device_name(0)}")
    print(f"Python {platform.python_version()}, {environment}")
    print(f"fornax-environment: {environment}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
