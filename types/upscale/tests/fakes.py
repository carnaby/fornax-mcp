"""Stand-ins for the upscale pack's tests: a PNG writer, a fake `torch`, and (Task 7) a fake SeedVR2 CLI, a fake
nvidia-smi and a pack folder built from them."""
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
