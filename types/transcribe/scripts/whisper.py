#!/usr/bin/env python3
"""Transcribe one 16 kHz mono WAV with faster-whisper on an NVIDIA GPU (adapted from Tabula's worker, same author, MIT).

Options arrive as JSON (UTF-8) on stdin: {"wav": "<path>", "model": "large-v3", "language": "sk" or null,
"initial_prompt": "<text>" or null}. The result goes to stdout as JSON:
  {"language": "sk", "duration_ms": 4200, "segments": [{"start_ms": 0, "end_ms": 1500, "text": "...",
   "words": [{"start_ms": 0, "end_ms": 400, "text": "..."}]}]}
stderr gets "PROGRESS <end_ms>" after a segment, at most once a second.
`whisper.py --check` prints the versions and the CUDA devices as JSON; `whisper.py --download <model>` fetches a model
into {pack}/env/hf (setup does this for large-v3).
Exit codes: 0 done; 1 this recording failed (also out of GPU memory); 3 the environment is broken (no CUDA device,
packages or libraries that do not load). There is no fallback to the CPU: large-v3 is far too slow there.
"""
import glob
import json
import os
import re
import site
import sys
import time

from common import ENVIRONMENT, FAILED, fail, setup_streams, use_pack_cache

PROGRESS_EVERY_S = 1.0
# Running out of GPU memory (a game is running) is a failure of the moment, not of the setup: the job is retried later.
OUT_OF_MEMORY = re.compile(r"out of memory|CUDA_ERROR_OUT_OF_MEMORY|ALLOC_FAILED", re.IGNORECASE)
# Failures of the GPU setup rather than of this recording.
LIBRARY_ERROR = re.compile(r"cublas|cudnn|cuda driver|no cuda|cuda.*(not available|unavailable)|\.dll|\.so", re.IGNORECASE)


def add_cuda_dlls():
    """CTranslate2 on Windows finds cuBLAS and cuDNN of the nvidia-* wheels only when their bin folders are added."""
    if os.name != "nt":
        return
    for root in site.getsitepackages():
        for folder in glob.glob(os.path.join(root, "nvidia", "*", "bin")):
            os.add_dll_directory(folder)
            os.environ["PATH"] = folder + os.pathsep + os.environ.get("PATH", "")


def exit_code_for(message):
    """1 for an ordinary failure (including out of memory), 3 when the GPU setup itself is broken."""
    if OUT_OF_MEMORY.search(message):
        return FAILED
    return ENVIRONMENT if LIBRARY_ERROR.search(message) else FAILED


def import_whisper():
    try:
        import ctranslate2
        import faster_whisper
    except Exception as e:  # ImportError, or a library that fails to load
        fail(ENVIRONMENT, f"faster-whisper does not load ({type(e).__name__}: {e}); run the setup again (see setup.md)")
    return ctranslate2, faster_whisper


def check():
    ctranslate2, faster_whisper = import_whisper()
    info = {"python": sys.version.split()[0], "faster_whisper": faster_whisper.__version__, "ctranslate2": ctranslate2.__version__}
    try:
        info["cuda_devices"] = ctranslate2.get_cuda_device_count()
        info["compute_types"] = sorted(ctranslate2.get_supported_compute_types("cuda")) if info["cuda_devices"] else []
    except Exception as e:
        info.update(cuda_devices=0, compute_types=[], cuda_error=str(e))
    return info


def load_wav(path):
    """The 16 kHz mono WAV ffmpeg made, read with wave and numpy (PyAV inside faster-whisper is not needed)."""
    import wave

    import numpy as np

    with wave.open(path, "rb") as w:
        if (w.getnchannels(), w.getsampwidth(), w.getframerate()) != (1, 2, 16000):
            fail(FAILED, f"expected a 16 kHz mono 16-bit WAV, got {w.getframerate()} Hz, {w.getnchannels()} channel(s)")
        frames = w.readframes(w.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def collect(pieces, clock=time.monotonic):
    segments, last = [], None
    for s in pieces:
        words = [{"start_ms": round(w.start * 1000), "end_ms": round(w.end * 1000), "text": w.word.strip()} for w in (s.words or []) if w.word.strip()]
        segments.append({"start_ms": round(s.start * 1000), "end_ms": round(s.end * 1000), "text": s.text.strip(), "words": words})
        now = clock()
        if last is None or now - last >= PROGRESS_EVERY_S:
            last = now
            print(f"PROGRESS {round(s.end * 1000)}", file=sys.stderr, flush=True)
    return segments


def transcribe(opts):
    ctranslate2, faster_whisper = import_whisper()
    if ctranslate2.get_cuda_device_count() == 0:
        fail(ENVIRONMENT, "CUDA is not available (no NVIDIA GPU or driver found); this pack never falls back to the CPU")
    audio = load_wav(opts["wav"])
    started = time.time()
    try:
        model = faster_whisper.WhisperModel(opts.get("model") or "large-v3", device="cuda", compute_type="float16")
        pieces, info = model.transcribe(
            audio,
            language=opts.get("language") or None,
            beam_size=5,
            vad_filter=True,
            word_timestamps=True,
            initial_prompt=opts.get("initial_prompt") or None,
        )
        # Segments are produced lazily: the work happens while iterating.
        segments = collect(pieces)
    except Exception as e:  # also ImportError of a lazily loaded DLL; fail() exits with SystemExit and is not caught here
        fail(exit_code_for(str(e)), f"{type(e).__name__}: {e}")
    print(f"transcribed {len(audio) / 16000:.1f} s of audio in {time.time() - started:.1f} s", file=sys.stderr, flush=True)
    return {"language": info.language, "duration_ms": round(len(audio) / 16), "segments": segments}


def main():
    setup_streams()
    use_pack_cache()
    add_cuda_dlls()
    out = sys.stdout
    # Whatever a library prints must not end up in the JSON on stdout.
    sys.stdout = sys.stderr
    if sys.argv[1:] == ["--check"]:
        result = check()
    elif len(sys.argv) == 3 and sys.argv[1] == "--download":
        _, faster_whisper = import_whisper()
        faster_whisper.download_model(sys.argv[2])
        result = {"downloaded": sys.argv[2]}
    else:
        try:
            opts = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        except ValueError as e:
            fail(FAILED, f"the options on stdin are not JSON: {e}")
        result = transcribe(opts)
    out.write(json.dumps(result))
    out.flush()


if __name__ == "__main__":
    main()
