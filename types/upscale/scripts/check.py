#!/usr/bin/env python3
"""The upscale pack's check (runs in {pack}/env, at most 120 s, without loading a model): the pack's folder can hold
frames, ffmpeg and ffprobe run, SeedVR2 and both models are in place, nvidia-smi sees exactly one card, PyTorch sees
CUDA. argv: --ffmpeg <ffmpeg> --ffprobe <ffprobe>. Exit 0 ready (a summary line and the fornax-environment line), 3 not ready (one sentence)."""
import argparse
import os
import platform
import subprocess

import common
import supervise as sv
from common import ENVIRONMENT, MODELS_DIR, PACK, SEEDVR2_DIR, fail, is_ascii_path, setup_streams
from upscale_lib import model_problems


def runs(tool):
    try:
        return subprocess.run([tool, "-version"], stdin=subprocess.DEVNULL, capture_output=True, timeout=30).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def main(argv=None):
    setup_streams()
    p = argparse.ArgumentParser(prog="check.py")
    p.add_argument("--ffmpeg", required=True)
    p.add_argument("--ffprobe", required=True)
    a = p.parse_args(argv)
    if os.name == "nt" and not is_ascii_path(PACK):
        fail(ENVIRONMENT, f"the pack's folder {PACK} has a character outside ASCII: OpenCV cannot write frames under it on Windows; move the worker's data folder (FORNAX_DATA_DIR) to a path without accents")
    for name, tool in (("ffmpeg", a.ffmpeg), ("ffprobe", a.ffprobe)):
        if not runs(tool):
            fail(ENVIRONMENT, f"{name} does not run: check tools.{name} in worker.yaml")
    if not (SEEDVR2_DIR / "inference_cli.py").is_file():
        fail(ENVIRONMENT, "SeedVR2 is not installed in this pack: run fornax types install upscale")
    problems = model_problems(MODELS_DIR, common.MODELS)
    if problems:
        fail(ENVIRONMENT, "; ".join(problems))
    try:
        gpu = sv.read_gpu()
    except sv.Broken as e:
        fail(ENVIRONMENT, str(e))
    try:
        import torch
    except Exception as e:  # a broken env raises anything at import
        fail(ENVIRONMENT, f"PyTorch does not load ({e}): run fornax types install upscale again")
    if not torch.cuda.is_available():
        fail(ENVIRONMENT, "PyTorch sees no CUDA device: install or update the NVIDIA driver")
    print(f"Python {platform.python_version()}, PyTorch {torch.__version__} (CUDA {torch.version.cuda}); {gpu.name}: {gpu.total_mib} MiB, {gpu.used_mib} in use")
    print(f"fornax-environment: PyTorch {torch.__version__} (CUDA {torch.version.cuda}); {gpu.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
