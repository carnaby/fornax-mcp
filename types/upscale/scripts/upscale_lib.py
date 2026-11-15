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


def cli_args(video, frames_root, models_dir, resolution, batch, overlap):
    """inference_cli.py's arguments as they were measured: PNG frames into <frames_root>/<stem>/<stem>_<n>.png,
    uniform batches with `overlap` frames of temporal overlap, the VAE tiled at 512 with 64 of overlap, both models
    offloaded to the CPU with 32 blocks swapped. Seed (42) and colour correction (lab) are the CLI's defaults."""
    return [
        str(video), "--output", str(frames_root), "--output_format", "png", "--model_dir", str(models_dir),
        "--dit_model", DIT_MODEL, "--resolution", str(resolution),
        "--batch_size", str(batch), "--uniform_batch_size", "--temporal_overlap", str(overlap),
        "--vae_encode_tiled", "--vae_encode_tile_size", "512", "--vae_encode_tile_overlap", "64",
        "--vae_decode_tiled", "--vae_decode_tile_size", "512", "--vae_decode_tile_overlap", "64",
        "--dit_offload_device", "cpu", "--vae_offload_device", "cpu", "--blocks_to_swap", "32", "--swap_io_components",
    ]


# Never inherited: the batches were measured with PyTorch's native allocator and on device 0, the card the watchdog reads.
JOB_ENV_REMOVED = ("PYTORCH_CUDA_ALLOC_CONF", "CUDA_VISIBLE_DEVICES")


def job_env(base, free_mib, margin_gb=MARGIN_GB):
    """The attempt's environment: the worker's without JOB_ENV_REMOVED and any UPSCALE_* (whatever their case: Windows
    takes names in any), plus UTF-8 unbuffered output (the CLI prints emoji), PyTorch counting cards as nvidia-smi does,
    and the launcher's three settings: the margin, the card's free memory by nvidia-smi right before this start, and
    the tether."""
    own = {
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUNBUFFERED": "1",
        "CUDA_DEVICE_ORDER": "PCI_BUS_ID",
        "UPSCALE_MARGIN_GB": str(margin_gb),
        "UPSCALE_FREE_MIB": str(int(free_mib)),
        "UPSCALE_TETHER": "1",
    }
    dropped = set(JOB_ENV_REMOVED) | set(own)
    env = {k: v for k, v in base.items() if k.upper() not in dropped and not k.upper().startswith("UPSCALE_")}
    env.update(own)
    return env


PHASES = ("Encoding", "Upscaling", "Decoding", "Post-processing")
# SeedVR2's four phases fill this share of the progress; the encode takes the rest.
CLI_SHARE = 0.95
REFUSED_PREFIX = "[capped] refused"
_PROGRESS = re.compile(r"(Encoding|Upscaling|Decoding|Post-processing) batch ([0-9]+)/([0-9]+)")
_PHASE = re.compile(r"Phase [0-9]: ")
_OOM = re.compile(r"out of memory|OutOfMemoryError|allocation on device", re.IGNORECASE)
_BAR = re.compile(r"[0-9]+%\|")


def is_out_of_memory(line):
    return bool(_OOM.search(line))


def began_processing(line):
    return bool(_PHASE.search(line) or _PROGRESS.search(line))


def is_progress_bar(line):
    return bool(_BAR.search(line))


def progress_of(line):
    """(fraction, message) for a batch line of the CLI, or None."""
    m = _PROGRESS.search(line)
    if not m:
        return None
    phase, n, total = m.group(1), int(m.group(2)), int(m.group(3))
    if total < 1:
        return None
    fraction = CLI_SHARE * (PHASES.index(phase) + min(n, total) / total) / len(PHASES)
    return fraction, f"{phase.lower()} batch {n}/{total}"


class LineSplitter:
    """Cuts a process's output into lines as it comes: at LF, and at CR too (tqdm redraws its bar with it); empty lines
    are dropped."""

    def __init__(self, on_line):
        self._on_line = on_line
        self._rest = ""

    def push(self, text):
        parts = re.split(r"[\r\n]", self._rest + text)
        self._rest = parts.pop()
        for part in parts:
            self._emit(part)

    def flush(self):
        self._emit(self._rest)
        self._rest = ""

    def _emit(self, line):
        if line.strip():
            self._on_line(line)


def frame_files(names, stem):
    """SeedVR2's frames of a clip, `<stem>_<n>.png`, in number order."""
    pattern = re.compile(re.escape(stem) + r"_([0-9]+)\.png", re.IGNORECASE)
    found = []
    for name in names:
        m = pattern.fullmatch(name)
        if m:
            found.append((int(m.group(1)), name))
    return [name for _, name in sorted(found)]


# Sound codecs MP4 carries as they are; any other (e.g. PCM from a .mov) is encoded to AAC.
COPY_AUDIO_CODECS = ("aac", "mp3", "alac", "opus", "ac3", "eac3")
AAC_BITRATE = "256k"


def audio_plan(requested, codec):
    """None: no sound in the result; "copy": the source's track as it is; "aac": encoded to AAC."""
    if not requested or not codec:
        return None
    return "copy" if codec in COPY_AUDIO_CODECS else "aac"


def encode_args(probe, out, audio_source=None, audio=None):
    """ffmpeg's arguments for SeedVR2's PNGs (piped in, in order) -> `out`: the source's frame rate, libx264 CRF 12,
    yuv420p at an even size, the source's colour tags, and the source's sound when `audio` says so.

    Only a BT.601 source: SeedVR2 reads frames through OpenCV, which converts with the BT.601 matrix whatever the tags
    say, so the frames go back through BT.601 and the file carries the source's own tags. ffmpeg drops
    -color_primaries and -color_trc for piped PNGs, so the tags go into x264's own options as well."""
    cs = probe.color_space
    if cs not in BT601_MATRICES:
        raise ValueError(f"encode_args: the source's colour matrix is {cs or 'untagged'}, not BT.601")
    vui = [f"colormatrix={cs}", "range=tv"]
    tags = ["-colorspace", cs]
    if probe.color_primaries:
        vui.append(f"colorprim={probe.color_primaries}")
        tags += ["-color_primaries", probe.color_primaries]
    if probe.color_transfer:
        vui.append(f"transfer={probe.color_transfer}")
        tags += ["-color_trc", probe.color_transfer]
    tags += ["-color_range", "tv"]
    args = ["-v", "error", "-y", "-f", "image2pipe", "-framerate", probe.rate, "-c:v", "png", "-i", "-"]
    if audio:
        args += ["-i", str(audio_source), "-map", "0:v", "-map", "1:a:0"]
    args += [
        "-vf", "scale=w=trunc(iw/2)*2:h=trunc(ih/2)*2:out_color_matrix=bt601:out_range=tv,format=yuv420p",
        "-c:v", "libx264", "-crf", "12", "-preset", "slow", "-pix_fmt", "yuv420p",
        "-x264-params", ":".join(vui), *tags,
    ]
    if audio == "copy":
        args += ["-c:a", "copy"]
    elif audio == "aac":
        args += ["-c:a", "aac", "-b:a", AAC_BITRATE]
    else:
        args += ["-an"]
    return args + ["-movflags", "+faststart", "-f", "mp4", str(out)]


PREVIEW_MAX_PX = 1024
OUTPUT = "upscaled.mp4"
PREVIEW = "previews/upscaled.jpg"


def preview_size(width, height, limit=PREVIEW_MAX_PX):
    """At most `limit` pixels on the longer side, never enlarged, at least 1 pixel."""
    longer = max(width, height)
    if longer <= limit:
        return width, height
    return max(1, round(width * limit / longer)), max(1, round(height * limit / longer))


def outputs_json(meta):
    for key, value in meta.items():
        scalar = value is None or isinstance(value, (bool, int, float)) or (isinstance(value, str) and len(value) <= 1000)
        if not scalar:
            raise ValueError(f"meta {key} is not a scalar (a string of up to 1000 characters, a number, a boolean or null)")
    return {OUTPUT: {"preview": PREVIEW, "meta": meta}}


@dataclass(frozen=True)
class Stopped:
    """Why the watchdog killed an attempt: "vram", "time" or "blind"."""

    guard: str
    used_mib: int = 0
    limit_mib: int = 0
    polls: int = 0


@dataclass
class Attempt:
    """One run of the launcher: its exit code (of a killed one whatever the system gave), the guard that killed it,
    the highest reading of the card while it ran, and what its output said."""

    code: int
    stopped: object = None  # Stopped or None
    peak_mib: int = 0
    seconds: float = 0.0
    out_of_memory: bool = False  # after SeedVR2 began processing: the batch was too large for the cap
    early_out_of_memory: bool = False  # before it began: CUDA itself could not start
    refused: object = None  # the launcher's "[capped] refused" line, or CardBusy's sentence
    tail: list = field(default_factory=list)


@dataclass
class LadderResult:
    ok: bool
    reason: object  # None when ok; else one of REASON_CODES
    batch: int  # the batch of the last attempt
    tried: list
    last: object  # the last Attempt
    peak_mib: int
    seconds: float


# How run.py exits for each reason: an outside cause (1, retried later; the worker waits for a free card), the
# type's own limits (4, a retry would end the same), a bug in the pack (3).
REASON_CODES = {"vram": 1, "blind": 1, "refused": 1, "startup": 1, "exit": 1, "time": 4, "oom": 4, "bad-env": 3}


def failure_lines(r, overlap, limit_s=TIME_LIMIT_S):
    """What a failed run says: what happened and what to do."""
    tried = " -> ".join(str(b) for b in r.tried)
    last = r.last or Attempt(code=1)
    s = last.stopped
    tail = [f"  | {line}" for line in last.tail]
    if s and s.guard == "vram":
        return [
            f"killed by the VRAM watchdog: the card had {s.used_mib} MiB in use, over the limit of {s.limit_mib}; "
            f"past the card's memory the driver pages into system RAM, which can freeze the PC; {FREE_THE_CARD}"
        ]
    if s and s.guard == "blind":
        return [
            f"killed because nvidia-smi gave no reading {s.polls} times in a row: without it the watchdog cannot see "
            "the card, and the job does not run unwatched; check the NVIDIA driver"
        ]
    if r.reason == "time":
        return [
            f"stopped after {limit_s // 60} min, the time this type gives one job (batches tried: {tried}): send a "
            f"shorter clip; a job that crawls means the card is shared ({FREE_THE_CARD})"
        ]
    if r.reason == "oom":
        lower = next_batch(r.tried[0], overlap)
        return [
            f"out of memory at batch {r.batch} (tried {tried}), the end of the batch ladder at overlap {overlap}: PyTorch "
            f"is capped at the card's free memory minus the margin, and that was not enough; nothing spilled; "
            f"{FREE_THE_CARD}" + ("" if lower else "; or a smaller overlap")
        ]
    if r.reason == "refused":
        return [f"not started: {last.refused or 'the launcher found no free memory beyond the margin'}"]
    if r.reason == "startup":
        return [
            "out of memory before SeedVR2 began processing: CUDA itself could not start on the card (it is full, or "
            f"the driver failed), so no smaller batch was tried; {FREE_THE_CARD}",
            *tail,
        ]
    if r.reason == "bad-env":
        return ["the launcher refused its settings (a bug in this pack):", *tail]
    return [f"SeedVR2 ended with exit code {last.code} at batch {r.batch}; its last lines:", *tail]
