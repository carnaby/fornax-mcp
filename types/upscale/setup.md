# upscale

Enlarges a short video clip to 1080p or 1440p with [SeedVR2](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler)
(a diffusion video upscaler, Apache-2.0) on an NVIDIA GPU: the same frames, frame rate and colours, sound only on
request. About 2 minutes per second of video at 1080p on a 16 GB card. There is no CPU fallback.

## What you need

- An NVIDIA GPU with 16 GB of memory and a current driver (RTX 50xx cards need CUDA 12.8 or newer), exactly one card.
- About 13 GB of disk for the pack (5 GB more while the setup runs).
- Python 3.10 or newer (only to run the setup: the pack brings its own CPython 3.13.18), ffmpeg and ffprobe, all in
  `worker.yaml`:

      tools:
        python: python3          # or C:\Path\To\python.exe
        ffmpeg: ffmpeg           # or C:\Path\To\ffmpeg.exe
        ffprobe: ffprobe         # or C:\Path\To\ffprobe.exe

- On Windows, the worker's data folder must have only ASCII characters in its path (SeedVR2 writes frames through
  OpenCV, which fails silently on other paths); `fornax doctor upscale` says so when it does not.

## Install

    fornax types install upscale

The setup puts everything inside this pack's `env/` folder: uv, CPython 3.13.18, a Python environment with PyTorch
(CUDA 12.8) and SeedVR2's packages at locked versions (`scripts/requirements.txt`), SeedVR2's source at a pinned
commit, and the two models (7.3 GB), each checked by sha256. Nothing outside it changes (uv adds no Python to the
`PATH` and no registry entry); deleting this folder removes everything.

When the models are already on the disk, point `SEEDVR2_MODELS_FROM` at their folder for that one command; they are
checked, then hard-linked (same disk: no extra space) or copied. A missing or different file there stops the setup;
it is never downloaded instead:

    # Windows PowerShell
    $env:SEEDVR2_MODELS_FROM = "D:\models\SEEDVR2"; fornax types install upscale
    # Linux
    SEEDVR2_MODELS_FROM=/data/models/SEEDVR2 fornax types install upscale

Jobs never go online.

### Recommended on Windows: no sysmem fallback

When a program asks for more GPU memory than the card has, the NVIDIA driver on Windows moves memory into system RAM
instead of failing: the job crawls, and the PC may freeze. In the NVIDIA Control Panel, Manage 3D settings, set
**CUDA - Sysmem Fallback Policy** to **Prefer No Sysmem Fallback** (globally, or for this pack's
`env\Scripts\python.exe`). The pack's own guards (below) work without it, but cannot check it.

## Check

    fornax doctor upscale

prints the versions, the card and its memory, or the one thing that is missing.

## Parameters

| Parameter | Default | Meaning |
|---|---|---|
| `resolution` | 1080 | the short side of the result: 1080 or 1440 |
| `batch` | 21 at 1080, 13 at 1440 | frames the model sees at once (9, 13, 17, 21, 25, 29); smaller needs less memory and holds together worse over time |
| `overlap` | 3 | frames two neighbouring batches share; smaller than the batch |
| `audio` | false | keep the source's sound track (copied when MP4 carries it, otherwise AAC 256 kb/s) |

Only clips whose colour matrix is BT.601 (`smpte170m` or `bt470bg`) are taken: SeedVR2 reads frames with the BT.601
matrix whatever the clip says, so any other clip would come out with shifted colours. A clip that would take longer
than 150 minutes (an estimate: about 88 s per batch of 21 at 1080p), or whose short side is not smaller than
`resolution`, is refused before anything starts.

## Output

- `upscaled.mp4`: H.264 (CRF 12, yuv420p), the source's frame rate and colour tags, sound as asked.
- `previews/upscaled.jpg`: the middle frame.
- `outputs.json` metadata: `width`, `height`, `frames`, `rate`, `source_width`, `source_height`, `batch` (the one
  that ran), `overlap`, `batches`, `attempts`, `seconds`, `peak_vram_mib`, `audio`, `audio_codec`, and where it came
  from: `tool`, `repo`, `commit`, `dit_model`, `vae_model`, `seed`, `color_correction`, `color_matrix`.

## Guards

They cannot be switched off:

1. **PyTorch's cap.** PyTorch may reserve the card's free memory (the smaller of nvidia-smi's and PyTorch's figure)
   minus 3 GB; past it the job gets an out-of-memory error instead of spilling into system RAM. An out-of-memory then
   tries the next smaller batch (29, 21, 13, 9).
2. **The VRAM watchdog.** Every 2 s nvidia-smi reads the whole card; above the card's total minus 1000 MiB, or after
   three readings without an answer, the job is killed at once.
3. **The time limit.** 150 minutes for every attempt together.

A job never outlives its watcher: when `run.py` is gone, SeedVR2 ends too.

## Exit codes

| Code | When | What happens |
|---|---|---|
| 0 | done | |
| 1 | the watchdog killed it, the card was full at the start, out of memory before SeedVR2 began, SeedVR2 failed, the frame count or the encode was wrong | tried again later; the worker waits for a free card (`gpu.max_used_mib`) |
| 2 | the clip cannot be read, colour other than BT.601, `overlap` not smaller than the batch, nothing to upscale, longer than the time limit | the job fails at once |
| 3 | SeedVR2, a model, CUDA or nvidia-smi is missing, more than one card, a job folder outside ASCII on Windows | the worker stops offering the type until `fornax doctor upscale` passes |
| 4 | the time limit, out of memory at the smallest batch | the job fails at once |
