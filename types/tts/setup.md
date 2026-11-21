# tts

Speaks a Slovak text with one of two models:

- `piper` (default): [Piper](https://github.com/OHF-Voice/piper1-gpl) with the voice `sk_SK-lili-medium` (`lili`), on
  the CPU, in a fraction of a second; it sounds a little mechanical.
- `omnivoice`: [OmniVoice](https://github.com/k2-fsa/OmniVoice) on an NVIDIA GPU (about 4 GB of memory, about 8 times
  faster than real time once loaded), natural; voices `klara` (default) and `peter`.

Jobs never go online.

## What you need

- An NVIDIA GPU with a current driver (RTX 50xx cards need CUDA 12.8 or newer). Without CUDA the type is not offered,
  not even `piper`.
- About 11 GB of disk for the pack.
- Python 3.10 or newer (only to run the setup: the pack brings its own CPython 3.12.16) and ffmpeg, both in
  `worker.yaml`:

      tools:
        python: python3          # or C:\Path\To\python.exe
        ffmpeg: ffmpeg           # or C:\Path\To\ffmpeg.exe

## Install

    fornax types install tts

The setup puts everything inside this pack's `env/` folder: uv, CPython 3.12.16, a Python environment with PyTorch
(CUDA 12.8), OmniVoice and Piper at locked versions (`scripts/requirements.txt`), OmniVoice's model (3.3 GB) and the
Piper voice (63 MB), each file checked by sha256 at a pinned revision. Nothing outside it changes; deleting this folder
removes everything. Files that finished downloading are kept when the setup runs again.

## Check

    fornax doctor tts

prints the versions of Python, PyTorch (CUDA), omnivoice, piper-tts and ffmpeg and the card, or the one thing that is
missing.

## Parameters

- `text`: the text, one line, up to 2 000 characters; or send `text_file` (`.txt` or `.md`, UTF-8, up to 1 MB and
  50 000 characters) instead. One of the two, not both.
- `model`: `piper` (default) or `omnivoice`.
- `voice`: `lili` for `piper`; `klara` (default) or `peter` for `omnivoice`.
- `format`: `mp3` (default, 128 kb/s), `opus` (48 kb/s, Ogg) or `wav` (16-bit).
- `speed`: 0.5 to 2, 1 is normal.

A `.md` file is read without its marks: code blocks are left out, link texts are read, and every heading, bullet and
table row gets a pause of its own; numbered items keep their numbers (they are read aloud) and get a pause when they
follow a blank line or another item; an indented line after a list item continues that item. YAML front matter, HTML
comments and task boxes (`[ ]`, `[x]`) are left out. A blank line starts a paragraph. Numbers and units are read by the model itself
(OmniVoice once dropped the "minus" of `-3 °C`): write them out when they matter.

## Voices

`klara` and `peter` are 5.5 s clips in `voices/` that OmniVoice made without a reference (`voices.json` says how);
every job clones its voice from the clip, so it sounds the same each time. A new voice is a new version of this pack.

## Output

`speech.mp3`, `speech.opus` or `speech.wav`, and in `outputs.json` its `meta`: `model`, `voice`, `format`, `speed`,
`duration_s`, `sample_rate` (the model's: 22 050 for Piper, 24 000 for OmniVoice; Opus is always 48 kHz),
`characters`, `paragraphs`, `chunks`, `seconds`, the model's `model_repo` and `revision`, for Piper `piper_voice`, and for
OmniVoice `seed` and `peak_vram_mib`.

## Licences

- OmniVoice's weights: **CC-BY-NC 4.0** (non-commercial use only); its code: Apache 2.0. The voices `klara` and
  `peter` are OmniVoice's output.
- The Piper voice `lili`: MIT (its recordings: CC0). `piper-tts` 1.8 is GPL-3.0; it is installed on the worker PC
  only, nothing of it is in this repository.

## Exit codes

| Code | When | What happens |
|---|---|---|
| 0 | done | |
| 1 | the card ran out of memory (another program may hold it), the model failed, ffmpeg failed, the job's files cannot be read, outputs.json cannot be written | retried |
| 2 | no text or both, a voice of the other model, a file that is not UTF-8, nothing left to speak, over 50 000 characters, params.json does not hold valid parameters | the job fails at once |
| 3 | a model file, a voice or ffmpeg is missing; no CUDA for `omnivoice`; the pack's Python environment is broken (a library missing) | the worker stops offering the type until the worker restarts and `fornax doctor tts` passes |
