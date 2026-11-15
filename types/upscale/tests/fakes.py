"""Stand-ins for the upscale pack's tests: a PNG writer, a fake `torch`, and (Task 7) a fake SeedVR2 CLI, a fake
nvidia-smi and a pack folder built from them."""
import json
import shutil
import struct
import zlib
from pathlib import Path

PNG_SIGNATURE = bytes([0x89]) + b"PNG" + bytes([13, 10, 26, 10])


def png_bytes(width, height, rgb):
    """A solid-colour 8-bit RGB PNG."""
    row = bytes([0]) + bytes(rgb) * width
    raw = row * height

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return PNG_SIGNATURE + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


# 16 GB in all; STUB_FREE_GB is what PyTorch "sees" free (default 15).
FAKE_TORCH = '''import os
GB = 1024 ** 3
__version__ = "0.0-fake"


class OutOfMemoryError(RuntimeError):
    pass


class version:
    cuda = "12.8"


class cuda:
    @staticmethod
    def mem_get_info(device=0):
        return int(float(os.environ.get("STUB_FREE_GB", "15")) * GB), 16 * GB

    @staticmethod
    def set_per_process_memory_fraction(fraction, device=0):
        print(f"stub fraction {fraction:.6f} device {device}", flush=True)

    @staticmethod
    def is_available():
        return os.environ.get("STUB_NO_CUDA") != "1"
'''


def write_fake_torch(root):
    folder = Path(root) / "torch"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "__init__.py").write_text(FAKE_TORCH, encoding="utf-8")


SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"

# A stand-in for SeedVR2's inference_cli.py: behaviour from behavior.json next to it. Writes PNG frames into
# <--output>/<stem>/<stem>_<n>.png as the real CLI does, and prints its kind of lines.
FAKE_CLI = '''import json, os, struct, sys, time, zlib
here = os.path.dirname(os.path.abspath(__file__))
b = json.load(open(os.path.join(here, "behavior.json"), encoding="utf-8"))
args = sys.argv[1:]
video = args[0]
out = args[args.index("--output") + 1]
batch = int(args[args.index("--batch_size") + 1])
with open(os.path.join(here, "calls.txt"), "a", encoding="utf-8") as f:
    f.write(" ".join(args[1:]) + chr(10))
mode = b.get("mode", "ok")
if mode == "early-oom":
    print("CUDA error: out of memory", flush=True)
    sys.exit(1)
print("Phase 1: Encoding", flush=True)
print("Encoding batch 1/2", flush=True)
if mode == "oom-above" and batch > b["max_batch"]:
    print("Upscaling batch 1/2", flush=True)
    print("torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB", flush=True)
    sys.exit(1)
if mode == "hog":
    with open(b["smi_state"], "w", encoding="utf-8") as f:
        f.write("16000 16311 1")
    time.sleep(60)
if mode == "sleep":
    while True:
        with open(os.path.join(here, "beat.txt"), "a", encoding="utf-8") as f:
            f.write(".")
        time.sleep(0.1)


def png(width, height, rgb):
    raw = (bytes([0]) + bytes(rgb) * width) * height

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    head = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return bytes([0x89]) + b"PNG" + bytes([13, 10, 26, 10]) + chunk(b"IHDR", head) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


stem = os.path.splitext(os.path.basename(video))[0]
folder = os.path.join(out, stem)
os.makedirs(folder, exist_ok=True)
data = png(b["width"], b["height"], (192, 128, 64))
for i in range(b["frames"] - (1 if mode == "few-frames" else 0)):
    with open(os.path.join(folder, f"{stem}_{i:06d}.png"), "wb") as f:
        f.write(data)
for phase in ("Upscaling", "Decoding", "Post-processing"):
    print(f"{phase} batch 2/2", flush=True)
'''

# A stand-in for nvidia-smi: the card's state from smi.txt next to it ("used total gpus"), else 1100 of 16311, one card.
FAKE_SMI = '''import os, sys
state = os.path.join(os.path.dirname(os.path.abspath(__file__)), "smi.txt")
used, total, gpus = 1100, 16311, 1
if os.path.exists(state):
    used, total, gpus = (int(x) for x in open(state, encoding="utf-8").read().split())
for i in range(gpus):
    if any(a.startswith("--query-gpu=name") for a in sys.argv[1:]):
        print(f"Fake GPU {i}, {total}, {used}, {total - used}")
    else:
        print(used)
'''

WRAPPER = '''import sys
sys.path.insert(0, {scripts!r})
import supervise
supervise.NVIDIA_SMI = [sys.executable, {smi!r}]
{patch}
import {module}
sys.exit({module}.main(sys.argv[1:]))
'''
# check.py compares the models' sizes with the pinned ones: its wrapper pins the fake models' 4 bytes instead.
SMALL_MODELS = "import common" + chr(10) + "common.MODELS = {name: (4, sha) for name, (size, sha) in common.MODELS.items()}"


def set_card(root, used, total=16311, gpus=1):
    (Path(root) / "smi.txt").write_text(f"{used} {total} {gpus}", encoding="utf-8")


def make_pack(root, behavior):
    """A pack under `root`/pack with the real scripts, the fake CLI and fake models; the fake torch, the fake
    nvidia-smi and the wrappers (wrap_run.py, wrap_check.py) in `root`. Run a wrapper with PYTHONPATH=root."""
    root = Path(root)
    pack = root / "pack"
    shutil.copytree(SCRIPTS, pack / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
    cli = pack / "env" / "seedvr2"
    cli.mkdir(parents=True)
    (cli / "inference_cli.py").write_text(FAKE_CLI, encoding="utf-8")
    (cli / "behavior.json").write_text(json.dumps(dict({"smi_state": str(root / "smi.txt")}, **behavior)), encoding="utf-8")
    models = pack / "env" / "models"
    models.mkdir()
    for name in ("seedvr2_ema_3b_fp16.safetensors", "ema_vae_fp16.safetensors"):
        (models / name).write_bytes(b"fake")
    write_fake_torch(root)
    (root / "fake_smi.py").write_text(FAKE_SMI, encoding="utf-8")
    for module in ("run", "check"):
        patch = SMALL_MODELS if module == "check" else ""
        (root / f"wrap_{module}.py").write_text(WRAPPER.format(scripts=str(pack / "scripts"), smi=str(root / "fake_smi.py"), patch=patch, module=module), encoding="utf-8")
    return pack
