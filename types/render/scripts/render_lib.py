"""The render pack's logic that needs no Blender (unit-tested in CI): arguments, frames, names, outputs.json, progress."""
import argparse
import json

PREVIEW_MAX_PX = 1024
# More frames than this in one job is a mistake (6 hours would never be enough); a long animation is several jobs.
MAX_FRAMES = 10_000
EXTENSIONS = {"png": "png", "jpg": "jpg"}
FILE_FORMATS = {"png": "PNG", "jpg": "JPEG"}


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
