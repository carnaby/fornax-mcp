"""Render a frame range of the input .blend with Cycles on the GPU (spec 6.5). Runs inside Blender:
  blender -b --factory-startup --disable-autoexec --python-exit-code 1 <scene> --python render.py --
          --params <params.json> --scene <scene> --out <dir>
Writes <out>/frame_NNNN.<png|jpg>, a JPEG preview of each in <out>/previews/, and <out>/outputs.json; prints one
progress line per frame. Exit codes: 0 done; 1 failed (an exception); 2 the scene or the params are invalid;
3 Cycles finds no GPU.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
from blender_gpu import enable_gpu  # noqa: E402
from render_lib import FILE_FORMATS, InvalidParams, frame_name, frames, outputs_entry, preview_name, preview_size, progress_line, script_args  # noqa: E402


def leave(code, message):
    print(f"render: {message}", file=sys.stderr, flush=True)
    sys.stdout.flush()
    # Not sys.exit: Blender would go on with the rest of its command line.
    os._exit(code)


def same_file(a, b):
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


def save_preview(source, target):
    """A JPEG of at most 1024 px on the longer side; returns the frame's own (width, height)."""
    image = bpy.data.images.load(source, check_existing=False)
    try:
        width, height = image.size
        w, h = preview_size(width, height)
        if (w, h) != (width, height):
            image.scale(w, h)
        image.filepath_raw = target
        image.file_format = "JPEG"
        image.save()
        return width, height
    finally:
        bpy.data.images.remove(image)


def main():
    args = script_args(sys.argv)
    # Blender opens a broken or foreign file as its default scene and carries on: render only the input itself.
    if not bpy.data.filepath or not same_file(bpy.data.filepath, args.scene):
        leave(2, "the input could not be opened as a Blender scene")
    with open(args.params, encoding="utf-8") as f:
        params = json.load(f)
    try:
        todo = frames(params)
    except InvalidParams as e:
        leave(2, str(e))
    kind, names = enable_gpu()
    if kind is None:
        leave(3, "Cycles finds no GPU (OptiX, CUDA, HIP, oneAPI or Metal); check the driver, then fornax doctor render")
    print(f"render: Cycles on {kind}: {', '.join(names)}", file=sys.stderr, flush=True)

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "GPU"
    samples = params.get("samples", 128)
    scene.cycles.samples = samples
    fmt = params.get("format", "png")
    settings = scene.render.image_settings
    settings.file_format = FILE_FORMATS[fmt]
    settings.color_mode = "RGBA" if fmt == "png" else "RGB"
    if fmt == "jpg":
        settings.quality = 90
    scene.render.use_file_extension = False

    out = os.path.abspath(args.out)
    os.makedirs(os.path.join(out, "previews"), exist_ok=True)
    entries = {}
    for done, frame in enumerate(todo, 1):
        scene.frame_set(frame)
        name = frame_name(frame, fmt)
        scene.render.filepath = os.path.join(out, name)
        bpy.ops.render.render(write_still=True)
        width, height = save_preview(os.path.join(out, name), os.path.join(out, preview_name(frame)))
        entries[name] = outputs_entry(width, height, frame, samples, preview_name(frame))
        print(progress_line(done, len(todo), frame), flush=True)
    with open(os.path.join(out, "outputs.json"), "w", encoding="utf-8") as f:
        json.dump(entries, f)


main()
