# transcribe

Speech to text with [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (Whisper large-v3 by default) on an
NVIDIA GPU, and optionally who speaks when with [pyannote](https://github.com/pyannote/pyannote-audio). There is no
CPU fallback.

## What you need

- An NVIDIA GPU with a current driver (RTX 50xx cards need a driver with CUDA 12.8 or newer) and about 10 GB of disk.
- Python 3.10 or newer and ffmpeg, both in `worker.yaml`:

      tools:
        python: python3          # or C:\Path\To\python.exe
        ffmpeg: ffmpeg           # or C:\Path\To\ffmpeg.exe

## Install

    fornax types install transcribe

The setup creates two Python environments inside this pack (`env/` for Whisper, `env/diarize/` for pyannote and
PyTorch) and downloads Whisper large-v3 into `env/hf/`. Nothing outside this directory changes; deleting the directory
removes everything.

Speaker recognition needs the pyannote model, which Hugging Face hands out after you accept its conditions. The setup
prints the steps when Fornax has no token: accept the conditions of `pyannote/speaker-diarization-community-1`,
create a "Read" token, give it to Fornax, and run the setup again (stop the worker first, e.g. the tray's Quit):

    fornax secrets set HF_TOKEN
    fornax types setup transcribe

Fornax keeps the token in `<config>/secrets/HF_TOKEN` (`%APPDATA%\fornax\secrets\` on Windows,
`~/.config/fornax/secrets/` on Linux) and gives it only to this pack's setup. Jobs never go online for that model.

## Check

    fornax doctor transcribe

prints the versions, the CUDA devices, and whether speaker recognition is ready.

## Parameters and output

`language` (detected when left out), `model`, `diarize`, `speakers` (when known), `initial_prompt` (names and words
Whisper should expect). The output `transcript.json`:

    {"model": "large-v3", "language": "en", "duration_ms": 4200,
     "segments": [{"start_ms": 0, "end_ms": 1500, "text": "Hello.", "speaker": "S1"}],
     "diarization": {"model": "pyannote/speaker-diarization-community-1", "speakers": 2}}

A recording without a sound track gives an empty transcript. When speaker recognition fails, the transcript comes
without speakers and `diarization` holds `{"error": "..."}`.

## Exit codes

0 done, 1 failed (retried later, e.g. out of GPU memory), 2 the file cannot be read, 3 the environment is broken
(ffmpeg or the Python environment missing, no CUDA): the worker stops offering the type until `fornax doctor` passes.
