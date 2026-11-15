"""The upscale pack's logic that needs no GPU and starts no process (unit-tested in CI): settings, batches and the
time estimate, reading ffprobe and nvidia-smi, refusals, SeedVR2's arguments and environment, its output lines, the
encoder's arguments, outputs.json, and what a failed run says."""
import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path

from common import DIT_MODEL

# Frames per batch when `batch` is not given; measured on a 16 GB card with 1-1.5 GB used by the desktop.
DEFAULT_BATCH = {1080: 21, 1440: 13}
# What an out-of-memory steps down through, from the batch in use; at its end the job gives up.
BATCH_LADDER = (29, 21, 13, 9)
DEFAULT_OVERLAP = 3
# About 88 s per batch of 21 at 1080p, linear in the batch; 1440p took 1.7 times as long.
SECONDS_PER_BATCH_FRAME = 88 / 21
RES_TIME = {1080: 1.0, 1440: 1.7}
# The job's own limit for every attempt together: below max_runtime (3 h), so it ends with its own sentence.
TIME_LIMIT_S = 150 * 60
MARGIN_GB = 3
WATCHDOG_HEADROOM_MIB = 1000
POLL_S = 2.0
READ_TIMEOUT_S = 2.0
MAX_BLIND_POLLS = 3
BT601_MATRICES = ("smpte170m", "bt470bg")
FREE_THE_CARD = "free the card: close GPU-heavy programs, put the display on the integrated GPU"

PROBE_ARGS = [
    "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
    "stream=width,height,r_frame_rate,avg_frame_rate,nb_read_frames,color_space,color_primaries,color_transfer",
    "-of", "json",
]
AUDIO_PROBE_ARGS = ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "json"]
# The first line is GPU 0, the card the job runs on (CUDA_DEVICE_ORDER=PCI_BUS_ID makes PyTorch count the same way).
GPU_QUERY = ["--query-gpu=name,memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"]
USED_QUERY = ["--query-gpu=memory.used", "--format=csv,noheader,nounits"]


class Rejected(Exception):
    """Invalid input: the job fails at once (exit 2)."""


@dataclass(frozen=True)
class Settings:
    resolution: int
    batch: int
    overlap: int
    audio: bool


def settings(params):
    resolution = int(params.get("resolution", 1080))
    batch = params.get("batch")
    batch = DEFAULT_BATCH[resolution] if batch is None else int(batch)
    overlap = int(params.get("overlap", DEFAULT_OVERLAP))
    if overlap >= batch:
        raise Rejected(
            f"overlap {overlap} must be smaller than the batch ({batch}): SeedVR2 would drop it to 0, no overlap at "
            "all; lower overlap or raise batch"
        )
    return Settings(resolution, batch, overlap, bool(params.get("audio", False)))


def next_batch(batch, overlap):
    """The next step down the ladder, or None at its end, also where that step would not be longer than the overlap."""
    smaller = [b for b in BATCH_LADDER if b < batch]
    if not smaller or smaller[0] <= overlap:
        return None
    return smaller[0]


def batch_count(frames, batch, overlap):
    """The batches SeedVR2 runs: one from frame 0, then one every batch - overlap frames, until what is left is not
    longer than the overlap (its encode loop). With uniform batches each costs about the same."""
    step = batch - overlap if overlap > 0 else batch
    n = 0
    idx = 0
    while idx < frames:
        if idx > 0 and min(idx + batch, frames) - idx <= overlap:
            break
        n += 1
        idx += step
    return n


def estimate_seconds(frames, batch, overlap, resolution):
    return batch_count(frames, batch, overlap) * batch * SECONDS_PER_BATCH_FRAME * RES_TIME[resolution]


def minutes(seconds):
    return max(1, math.ceil(seconds / 60))


@dataclass(frozen=True)
class Probe:
    width: int
    height: int
    rate: str  # r_frame_rate as ffprobe prints it ("24/1", "24000/1001"): passed to the encoder unrounded
    fps: float
    variable_rate: bool
    frames: int
    color_space: object  # str or None
    color_primaries: object
    color_transfer: object


def _ratio(value):
    parts = str(value or "").split("/")
    try:
        num = float(parts[0])
        den = float(parts[1]) if len(parts) > 1 else 1.0
    except ValueError:
        return 0.0
    return num / den if den else 0.0


def _tag(value):
    return value if isinstance(value, str) and value not in ("", "unknown") else None


def _streams(text):
    try:
        data = json.loads(text)
    except ValueError:
        return []
    return (data.get("streams") or []) if isinstance(data, dict) else []


def parse_probe(text):
    streams = _streams(text)
    if not streams:
        raise Rejected("the file has no video stream ffprobe can read")
    s = streams[0]
    rate = str(s.get("r_frame_rate") or "")
    fps = _ratio(rate)
    avg = _ratio(s.get("avg_frame_rate"))
    try:
        frames, width, height = int(s.get("nb_read_frames")), int(s.get("width")), int(s.get("height"))
    except (TypeError, ValueError):
        frames = width = height = 0
    if not fps > 0 or frames < 1 or width < 1 or height < 1:
        raise Rejected("ffprobe could not read the size, frame rate and frame count of the video")
    return Probe(
        width, height, rate, fps, avg > 0 and abs(avg - fps) / fps > 0.005, frames,
        _tag(s.get("color_space")), _tag(s.get("color_primaries")), _tag(s.get("color_transfer")),
    )


def parse_audio_codec(text):
    streams = _streams(text)
    if not streams:
        return None
    return streams[0].get("codec_name") or None


def colour_problem(p):
    if p.color_space in BT601_MATRICES:
        return None
    tags = (
        f"colour matrix {p.color_space or 'untagged'}, primaries {p.color_primaries or 'untagged'}, "
        f"transfer {p.color_transfer or 'untagged'}"
    )
    return (
        "its colours would shift: SeedVR2 reads frames with the BT.601 matrix whatever the tag, and this clip is not "
        f"BT.601 ({tags}); this type takes {' or '.join(BT601_MATRICES)}"
    )


def size_problem(p, resolution):
    short = min(p.width, p.height)
    if short < resolution:
        return None
    return f"its short side is already {short} px, not smaller than the {resolution} asked for: nothing to upscale"


def time_problem(seconds, limit_s=TIME_LIMIT_S):
    if seconds <= limit_s:
        return None
    return (
        f"it would take about {minutes(seconds)} min (an estimate: about 88 s per batch of 21 at 1080p), over the "
        f"{limit_s // 60} min one job may take: send a shorter clip, or a smaller overlap (fewer batches)"
    )


def check_source(probe, s, limit_s=TIME_LIMIT_S):
    """Refuses (Rejected) a clip the job would fail on, before anything starts."""
    for problem in (
        colour_problem(probe),
        size_problem(probe, s.resolution),
        time_problem(estimate_seconds(probe.frames, s.batch, s.overlap, s.resolution), limit_s),
    ):
        if problem:
            raise Rejected(problem)


@dataclass(frozen=True)
class Gpu:
    name: str
    total_mib: int
    used_mib: int
    free_mib: int


def parse_gpus(text):
    """Every card of an answer to GPU_QUERY ("name, total, used, free" in MiB); ValueError when one cannot be read."""
    gpus = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        cells = [c.strip() for c in line.split(",")]
        problem = f'could not read nvidia-smi\'s answer ("{line[:120]}"): expected "name, total, used, free" in MiB'
        if len(cells) < 4:
            raise ValueError(problem)
        try:
            total, used, free = (int(c) for c in cells[-3:])
        except ValueError:
            raise ValueError(problem) from None
        if total <= 0 or used < 0 or free < 0:
            raise ValueError(problem)
        gpus.append(Gpu(", ".join(cells[:-3]), total, used, free))
    if not gpus:
        raise ValueError("nvidia-smi listed no GPU")
    return gpus


def parse_used_mib(text):
    """The watchdog's reading (GPU 0, MiB in use by every program), or None when nvidia-smi printed no number."""
    for line in text.splitlines():
        line = line.strip()
        if line:
            return int(line) if re.fullmatch(r"[0-9]+", line) else None
    return None


def watchdog_limit(total_mib):
    return total_mib - WATCHDOG_HEADROOM_MIB


def card_refusal(gpu, limit_mib, margin_gb=MARGIN_GB):
    """Why no attempt may start on the card as it is now, or None."""
    if gpu.used_mib > limit_mib:
        return f"{gpu.used_mib} MiB of the card is already in use, over the watchdog's {limit_mib} MiB: {FREE_THE_CARD}"
    if gpu.free_mib - margin_gb * 1024 <= 0:
        return (
            f"only {gpu.free_mib} MiB of the card is free, not more than the {margin_gb} GB kept free below PyTorch's "
            f"cap: {FREE_THE_CARD}"
        )
    return None


def model_problems(models_dir, models):
    """What is wrong with the models in `models_dir` by name and size (no sha256: that takes too long for a check)."""
    problems = []
    for name, (size, _sha) in models.items():
        path = Path(models_dir) / name
        if not path.is_file():
            problems.append(f"model {name} is missing in {models_dir}: run fornax types install upscale")
        elif path.stat().st_size != size:
            problems.append(f"model {name} has {path.stat().st_size} bytes, not {size}: run fornax types install upscale")
    return problems
