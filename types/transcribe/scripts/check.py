#!/usr/bin/env python3
"""The transcribe pack's check (runs in {pack}/env): ffmpeg runs, faster-whisper loads and sees a CUDA device.
Speaker recognition is reported, not required: a job that asks for it without it gets the transcript without speakers.
argv: --ffmpeg <ffmpeg>. Exit 0 ready (the last line is the fornax-environment line), 3 not ready (the last line says why).
"""
import argparse
import json
import subprocess
import sys

from common import DIARIZE_ENV, ENVIRONMENT, SCRIPTS, child_env, fail, setup_streams, venv_python


def main():
    setup_streams()
    p = argparse.ArgumentParser(prog="check.py")
    p.add_argument("--ffmpeg", required=True)
    args = p.parse_args()
    try:
        ok = subprocess.run([args.ffmpeg, "-version"], capture_output=True, timeout=30).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        ok = False
    if not ok:
        fail(ENVIRONMENT, "ffmpeg does not run: check tools.ffmpeg in worker.yaml")
    r = subprocess.run([sys.executable, str(SCRIPTS / "whisper.py"), "--check"], capture_output=True, timeout=90, env=child_env())
    if r.returncode != 0:
        sys.stderr.write(r.stderr.decode("utf-8", "replace")[-2000:])
        fail(ENVIRONMENT, "faster-whisper does not load: run the setup again (see setup.md)")
    info = json.loads(r.stdout)
    if not info.get("cuda_devices"):
        fail(ENVIRONMENT, f"CTranslate2 sees no CUDA device ({info.get('cuda_error', 'no NVIDIA GPU or driver')}): install or update the NVIDIA driver")
    print(f"faster-whisper {info['faster_whisper']}, CTranslate2 {info['ctranslate2']}, {info['cuda_devices']} CUDA device(s)")
    print(environment_line(info, speakers()))


def speakers():
    """Speaker recognition's state, printed; its check's answer, or None when it is not installed or does not load."""
    python = venv_python(DIARIZE_ENV)
    if not python.exists():
        print("speaker recognition: not installed (see setup.md)")
        return None
    try:
        d = subprocess.run([str(python), str(SCRIPTS / "diarize.py"), "--check"], capture_output=True, timeout=25)
        info = json.loads(d.stdout) if d.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        info = None
    if not info:
        print("speaker recognition: does not load (run the setup again, see setup.md)")
    elif not info.get("cuda"):
        print(f"speaker recognition: PyTorch {info['torch']} sees no CUDA device")
    else:
        print(f"speaker recognition: PyTorch {info['torch']} on {info['gpu']}; model {'downloaded' if info['model_cached'] else 'not downloaded (see setup.md)'}")
    return info


def environment_line(whisper, diarize):
    """The check's line for list_job_types (types/README.md): versions only; speakers on when a job can use them."""
    on = bool(diarize and diarize.get("cuda") and diarize.get("model_cached"))
    state = f"speaker recognition on (PyTorch {diarize['torch']})" if on else "speaker recognition off"
    return f"fornax-environment: faster-whisper {whisper['faster_whisper']}, CTranslate2 {whisper['ctranslate2']}; {state}"


if __name__ == "__main__":
    main()
