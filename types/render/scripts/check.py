"""The render pack's check, inside Blender: blender -b --factory-startup --python-exit-code 1 --python check.py
Blender 4.2 or newer, and a GPU for Cycles. Exit 0 ready (a summary line and the fornax-environment line), 3 not ready."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
from blender_gpu import enable_gpu  # noqa: E402
from render_lib import environment_line  # noqa: E402

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
print(f"Blender {bpy.app.version_string}, Cycles on {kind}: {', '.join(names)}", flush=True)
print(environment_line(bpy.app.version_string, kind, names), flush=True)
