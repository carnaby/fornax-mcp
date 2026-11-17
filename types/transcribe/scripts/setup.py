#!/usr/bin/env python3
"""The transcribe pack's setup, run with the system Python (tools.python in worker.yaml). Everything goes into
{pack}/env:
  env/          faster-whisper, CTranslate2 and the CUDA 12 libraries (pip wheels); runs run.py, whisper.py, check.py
  env/diarize/  pyannote.audio and PyTorch with CUDA; runs diarize.py
  env/hf/       the Hugging Face cache: Whisper large-v3 and, when HF_TOKEN is set, the pyannote model
Safe to run again (fornax types setup transcribe, e.g. after fornax secrets set HF_TOKEN): existing environments are
kept, packages brought to the pinned ranges.
"""
import os
import subprocess
import sys

from common import DIARIZE_ENV, ENV, HF_HOME, SCRIPTS, setup_streams, venv_python

# Versions verified together; the nvidia-* wheels bring cuBLAS and cuDNN for CTranslate2.
WHISPER_PACKAGES = ["faster-whisper>=1.2.1,<2", "ctranslate2>=4.8.4,<5", "nvidia-cublas-cu12>=12.9,<13", "nvidia-cudnn-cu12>=9,<10"]
# pyannote 4 with PyTorch 2.11; torchaudio and torchcodec must match it.
DIARIZE_PACKAGES = ["pyannote.audio>=4.0.7,<5", "torch==2.11.0", "torchaudio==2.11.0", "torchcodec==0.17.0"]
# pip installs PyTorch's CPU build from PyPI on Windows: the CUDA build comes from PyTorch's own index (CUDA 12.8,
# which RTX 50xx cards need).
TORCH_CUDA_PACKAGES = ["torch==2.11.0", "torchaudio==2.11.0"]
TORCH_CUDA_INDEX = "https://download.pytorch.org/whl/cu128"
DEFAULT_MODEL = "large-v3"
DIARIZE_MODEL = "pyannote/speaker-diarization-community-1"


def step(cmd, what, env=None):
    print(f"setup: {what}", flush=True)
    r = subprocess.run(cmd, env=env)
    if r.returncode != 0:
        print(f"setup: {what} failed (exit {r.returncode})", file=sys.stderr, flush=True)
        sys.exit(1)


def venv(path):
    if venv_python(path).exists():
        print(f"setup: keeping the Python environment {path}", flush=True)
        return
    step([sys.executable, "-m", "venv", str(path)], f"creating the Python environment {path}")


def pip(path, packages, *extra):
    step([str(venv_python(path)), "-m", "pip", "install", "--disable-pip-version-check", "--no-cache-dir", "--upgrade", *extra, *packages], f"installing {', '.join(packages)}")


def hugging_face_steps():
    return "\n".join([
        "Speaker recognition (diarize: true) needs the pyannote model, which Hugging Face hands out after you accept its conditions:",
        "  1. Sign in at https://huggingface.co (a free account is enough).",
        f"  2. Open https://huggingface.co/{DIARIZE_MODEL} and accept the conditions.",
        "  3. Create a token at https://huggingface.co/settings/tokens (type \"Read\").",
        "  4. Give it to Fornax (it asks without showing what you type): fornax secrets set HF_TOKEN",
        "  5. Stop the worker (tray: Quit), then run this setup again: fornax types setup transcribe",
        "Fornax gives the token only to this setup; jobs never go online for this model.",
        "Until then, jobs with diarize: true get the transcript without speakers.",
    ])


def main():
    setup_streams()
    if sys.version_info < (3, 10):
        print("setup: Python 3.10 or newer is needed; point tools.python in worker.yaml at one", file=sys.stderr)
        sys.exit(1)
    env = dict(os.environ, HF_HOME=str(HF_HOME), HF_HUB_DISABLE_TELEMETRY="1")
    print(f"setup: everything goes into {ENV}", flush=True)

    venv(ENV)
    pip(ENV, WHISPER_PACKAGES)
    step([str(venv_python(ENV)), str(SCRIPTS / "whisper.py"), "--download", DEFAULT_MODEL], f"downloading the Whisper model {DEFAULT_MODEL}", env=env)

    venv(DIARIZE_ENV)
    pip(DIARIZE_ENV, DIARIZE_PACKAGES)
    cuda = subprocess.run([str(venv_python(DIARIZE_ENV)), "-c", "import sys, torch; sys.exit(0 if torch.version.cuda else 1)"])
    if cuda.returncode != 0:
        # Last, over what pip brought: pyannote's dependencies pull the CPU build.
        pip(DIARIZE_ENV, TORCH_CUDA_PACKAGES, "--force-reinstall", "--no-deps", "--index-url", TORCH_CUDA_INDEX)

    if not os.environ.get("HF_TOKEN"):
        print(hugging_face_steps(), flush=True)
        return
    r = subprocess.run([str(venv_python(DIARIZE_ENV)), str(SCRIPTS / "diarize.py"), "--load"], env=env)
    if r.returncode == 0:
        print(f"setup: the speaker recognition model is in {HF_HOME}", flush=True)
    else:
        print(f"setup: the speaker recognition model could not be downloaded (exit {r.returncode})", flush=True)
        print(hugging_face_steps(), flush=True)


if __name__ == "__main__":
    main()
