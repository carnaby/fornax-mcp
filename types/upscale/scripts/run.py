#!/usr/bin/env python3
"""The upscale pack's job (runs in {pack}/env): probe the clip, refuse what would fail, run SeedVR2 through capped.py
under the VRAM watchdog, the time limit and the batch ladder, encode the frames, write outputs.json.
argv: --params <params.json> --video <file> --ffmpeg <ffmpeg> --ffprobe <ffprobe> --out <dir> --work <dir>.
Exit 0 done, 1 failed (an outside cause: retried later), 2 invalid input, 3 broken environment, 4 failed for good
(the type's own time limit, out of memory after the whole ladder)."""
import argparse
import json
import os
import shutil
import signal
import sys
import time
from pathlib import Path

import encode
import supervise as sv
from common import (
    COLOR_CORRECTION,
    DIT_MODEL,
    ENVIRONMENT,
    FAILED,
    INVALID,
    MODELS,
    MODELS_DIR,
    OK,
    SCRIPTS,
    SEED,
    SEEDVR2_COMMIT,
    SEEDVR2_DIR,
    SEEDVR2_REPO,
    VAE_MODEL,
    Exit,
    is_ascii_path,
    progress,
    say,
    setup_streams,
)
from upscale_lib import (
    AAC_BITRATE,
    CLI_SHARE,
    OUTPUT,
    PREVIEW,
    REASON_CODES,
    TIME_LIMIT_S,
    Rejected,
    audio_plan,
    batch_count,
    card_refusal,
    check_source,
    cli_args,
    estimate_seconds,
    failure_lines,
    frame_files,
    job_env,
    minutes,
    outputs_json,
    progress_of,
    settings,
    watchdog_limit,
)

CAPPED = SCRIPTS / "capped.py"


def run(a, t0):
    work, out = Path(a.work), Path(a.out)
    if os.name == "nt" and not is_ascii_path(work):
        raise Exit(ENVIRONMENT, f"the job folder {work} has a character outside ASCII: OpenCV cannot write frames there on Windows; move the worker's data folder to a path without accents")
    if not (SEEDVR2_DIR / "inference_cli.py").is_file():
        raise Exit(ENVIRONMENT, "SeedVR2 is not installed in this pack: run fornax types install upscale")
    missing = [name for name in MODELS if not (MODELS_DIR / name).is_file()]
    if missing:
        raise Exit(ENVIRONMENT, f"model {', '.join(missing)} is missing: run fornax types install upscale")

    try:
        s = settings(json.loads(Path(a.params).read_text(encoding="utf-8")))
        src = encode.probe(a.ffprobe, a.video)
        codec = encode.audio_codec(a.ffprobe, a.video) if s.audio else None
        say(f"source: {src.width}x{src.height}, {src.frames} frames at {src.rate} fps, colour {src.color_space or 'untagged'}/{src.color_primaries or 'untagged'}/{src.color_transfer or 'untagged'}")
        if src.variable_rate:
            say("the source has a variable frame rate: the result has a constant one and may drift from it")
        check_source(src, s)
    except Rejected as e:
        raise Exit(INVALID, str(e)) from None
    except encode.ToolError as e:
        raise Exit(ENVIRONMENT, str(e)) from None
    say(f"batch {s.batch}, overlap {s.overlap}: {batch_count(src.frames, s.batch, s.overlap)} batches, about {minutes(estimate_seconds(src.frames, s.batch, s.overlap, s.resolution))} min (an estimate)")
    if s.audio and not codec:
        say("audio is true, but the source has no sound track: the result has none")

    try:
        limit = watchdog_limit(sv.read_gpu().total_mib)
    except sv.Broken as e:
        raise Exit(ENVIRONMENT, str(e)) from None
    frames_root = work / "frames"

    def start_attempt(batch, on_line):
        shutil.rmtree(frames_root, ignore_errors=True)
        card = sv.read_gpu()
        busy = card_refusal(card, limit)
        if busy:
            raise sv.CardBusy(busy)
        say(f"batch {batch}: the card has {card.used_mib} MiB in use, {card.free_mib} free of {card.total_mib}")
        argv = [sys.executable, str(CAPPED), *cli_args(a.video, frames_root, MODELS_DIR, s.resolution, batch, s.overlap)]
        return sv.ProcessJob(argv, cwd=str(SEEDVR2_DIR), env=job_env(os.environ, card.free_mib), on_line=on_line)

    def on_line(line):
        print(line, file=sys.stderr, flush=True)
        step = progress_of(line)
        if step:
            progress(*step)

    try:
        r = sv.run_ladder(s.batch, s.overlap, start_attempt, sv.read_used_mib, limit, TIME_LIMIT_S - (time.monotonic() - t0), time.monotonic, say=say, on_line=on_line)
    except sv.Broken as e:
        raise Exit(ENVIRONMENT, str(e)) from None
    if not r.ok:
        shutil.rmtree(frames_root, ignore_errors=True)
        # The worker reports the log's last line as the job's error: the summary and the tail first, the reason last.
        reason, *rest = failure_lines(r, s.overlap)
        say(f"no result (batches tried: {' -> '.join(map(str, r.tried))}, {r.seconds:.0f} s, peak VRAM {r.peak_mib} MiB)")
        for line in rest:
            say(line)
        raise Exit(REASON_CODES[r.reason], reason)

    stem = Path(a.video).stem
    folder = frames_root / stem
    pngs = [folder / name for name in frame_files(os.listdir(folder) if folder.is_dir() else [], stem)]
    if len(pngs) != src.frames:
        raise Exit(FAILED, f"SeedVR2 wrote {len(pngs)} frames, the source has {src.frames}: nothing encoded")
    plan = audio_plan(s.audio, codec)
    if plan == "aac":
        say(f"the source's sound ({codec}) does not go into MP4 as it is: encoded to AAC {AAC_BITRATE}")
    progress(CLI_SHARE, "encoding")
    out.mkdir(parents=True, exist_ok=True)
    try:
        result = encode.encode_frames(
            a.ffmpeg, a.ffprobe, pngs, src, out / OUTPUT, a.video if plan else None, plan,
            on_progress=lambda i, n: progress(CLI_SHARE + (1 - CLI_SHARE) * 0.9 * i / n, f"encoding {i}/{n} frames"),
        )
        encode.make_preview(a.ffmpeg, pngs[len(pngs) // 2], result.width, result.height, out / PREVIEW)
    except encode.EncodeError as e:
        raise Exit(FAILED, str(e)) from None
    except encode.ToolError as e:
        raise Exit(ENVIRONMENT, str(e)) from None
    seconds = round(time.monotonic() - t0)
    meta = {
        "width": result.width, "height": result.height, "frames": result.frames, "rate": result.rate,
        "source_width": src.width, "source_height": src.height,
        "batch": r.batch, "overlap": s.overlap, "batches": batch_count(src.frames, r.batch, s.overlap),
        "attempts": len(r.tried), "seconds": seconds, "peak_vram_mib": r.peak_mib,
        "audio": plan is not None, "audio_codec": None if plan is None else ("aac" if plan == "aac" else codec),
        "tool": "SeedVR2", "repo": SEEDVR2_REPO, "commit": SEEDVR2_COMMIT, "dit_model": DIT_MODEL,
        "vae_model": VAE_MODEL, "seed": SEED, "color_correction": COLOR_CORRECTION, "color_matrix": src.color_space,
    }
    (out / "outputs.json").write_text(json.dumps(outputs_json(meta), indent=2), encoding="utf-8")
    shutil.rmtree(frames_root, ignore_errors=True)
    say(f"{src.width}x{src.height} -> {result.width}x{result.height}, {result.frames} frames, batch {r.batch}, {seconds} s, peak VRAM {r.peak_mib} MiB")
    progress(1.0, "done")
    return OK


def main(argv=None):
    setup_streams()
    if os.name != "nt":
        # The worker stops a job with SIGTERM: a normal exit, so the attempt's tree is killed on the way out.
        signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(FAILED))
    p = argparse.ArgumentParser(prog="run.py")
    for name in ("--params", "--video", "--ffmpeg", "--ffprobe", "--out", "--work"):
        p.add_argument(name, required=True)
    a = p.parse_args(argv)
    try:
        return run(a, time.monotonic())
    except Exit as e:
        say(e.message)
        return e.code


if __name__ == "__main__":
    sys.exit(main())
