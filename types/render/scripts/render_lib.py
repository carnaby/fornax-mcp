"""The render pack's logic that needs no Blender (unit-tested in CI): arguments, frames, names, outputs.json, progress,
and which nodes and sequencer strips make a scene invalid."""
import argparse
import json

PREVIEW_MAX_PX = 1024
# The worker accepts at most 1000 output files per job and every frame writes two (the frame and its preview):
# 1000 // 2. A longer animation is several jobs.
MAX_FRAMES = 500
EXTENSIONS = {"png": "png", "jpg": "jpg"}
FILE_FORMATS = {"png": "PNG", "jpg": "JPEG"}


# Geometry nodes that read a file by path (OBJ, PLY, STL, CSV, Text, VDB import in recent Blender).
REFUSED_NODE_PREFIXES = ("GeometryNodeImport",)
# Sequencer strip types that read a file (type -> the word used in the message).
FILE_STRIP_TYPES = {"IMAGE": "image", "MOVIE": "movie", "SOUND": "sound"}


class InvalidParams(ValueError):
    pass


def script_args(argv):
    """The arguments after Blender's "--"."""
    rest = argv[argv.index("--") + 1:] if "--" in argv else []
    p = argparse.ArgumentParser(prog="render.py")
    p.add_argument("--params", required=True)
    p.add_argument("--scene", required=True)
    p.add_argument("--out", required=True)
    return p.parse_args(rest)


def frames(params):
    start = params["frame_start"]
    end = params.get("frame_end", start)
    if end < start:
        raise InvalidParams("frame_end must not be smaller than frame_start")
    if end - start + 1 > MAX_FRAMES:
        raise InvalidParams(f"at most {MAX_FRAMES} frames per job; split a longer range into several jobs")
    return list(range(start, end + 1))


def frame_name(frame, fmt):
    return f"frame_{frame:04d}.{EXTENSIONS[fmt]}"


def preview_name(frame):
    return f"previews/frame_{frame:04d}.jpg"


def preview_size(width, height, limit=PREVIEW_MAX_PX):
    """At most `limit` pixels on the longer side, never enlarged, at least 1 pixel."""
    longer = max(width, height)
    if longer <= limit:
        return width, height
    return max(1, round(width * limit / longer)), max(1, round(height * limit / longer))


def outputs_entry(width, height, frame, samples, preview):
    return {"meta": {"frame": frame, "width": width, "height": height, "samples": samples}, "preview": preview}


def progress_line(done, total, frame):
    return json.dumps({"progress": round(done / total, 4), "message": f"frame {frame} ({done}/{total})"})


def refused_node(bl_idname, mode):
    """What kind of refused node this is (for the message), or None: nodes that run code or read a file by path."""
    if bl_idname == "ShaderNodeScript":
        return "OSL script node"
    if bl_idname == "ShaderNodeTexIES" and mode == "EXTERNAL":
        return "external IES texture node"
    if bl_idname.startswith(REFUSED_NODE_PREFIXES):
        return "geometry Import node"
    return None


def first_refused_node(nodes):
    """The kind of the first refused node among (bl_idname, mode) pairs, or None."""
    for bl_idname, mode in nodes:
        kind = refused_node(bl_idname, mode)
        if kind is not None:
            return kind
    return None


def first_file_strip(strip_types):
    """The kind of the first sequencer strip that reads a file, or None."""
    for strip_type in strip_types:
        if strip_type in FILE_STRIP_TYPES:
            return FILE_STRIP_TYPES[strip_type]
    return None
