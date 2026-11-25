"""The render pack's check, inside Blender: blender -b --factory-startup --python-exit-code 1 --python check.py -- --ffmpeg <ffmpeg>
Blender 4.2 or newer, a GPU for Cycles and ffmpeg with libx264. Exit 0 ready (a summary line and the
fornax-environment line), 3 not ready."""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
from blender_gpu import enable_gpu  # noqa: E402
from render_lib import check_args, environment_line, ffmpeg_version, has_libx264  # noqa: E402

MINIMUM = (4, 2, 0)


def leave(code, message):
    print(f"render: {message}", file=sys.stderr, flush=True)
    sys.stdout.flush()
    os._exit(code)


if tuple(bpy.app.version) < MINIMUM:
    leave(3, f"Blender {bpy.app.version_string} is too old; 4.2 or newer is needed")
kind, names = enable_gpu()
if kind is None:
    leave(3, "Cycles finds no GPU (OptiX, CUDA, HIP, oneAPI or Metal); install or update the GPU driver")
ffmpeg = check_args(sys.argv).ffmpeg
try:
    encoders = subprocess.run([ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    version = subprocess.run([ffmpeg, "-version"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
except (OSError, subprocess.TimeoutExpired) as e:
    leave(3, f"ffmpeg does not run ({type(e).__name__}): check tools.ffmpeg in worker.yaml")
if not has_libx264(encoders.stdout):
    leave(3, "ffmpeg has no libx264 encoder: install an ffmpeg build with libx264")
ffmpeg_text = ffmpeg_version(version.stdout) or "?"
print(f"Blender {bpy.app.version_string}, Cycles on {kind}: {', '.join(names)}; ffmpeg {ffmpeg_text}", flush=True)
print(environment_line(bpy.app.version_string, kind, names, ffmpeg_text), flush=True)
