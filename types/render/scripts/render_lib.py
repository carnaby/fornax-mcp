"""The render pack's logic that needs no Blender (unit-tested in CI): arguments, frames, names, outputs.json, progress,
and which nodes and sequencer strips make a scene invalid."""
import argparse
import json
import os

PREVIEW_MAX_PX = 1024
# The worker accepts at most 1000 output files per job and every frame writes two (the frame and its preview):
# 1000 // 2. A longer animation is several jobs.
MAX_FRAMES = 500
EXTENSIONS = {"png": "png", "jpg": "jpg"}
FILE_FORMATS = {"png": "PNG", "jpg": "JPEG"}
# Spec 15: the engines of the engine parameter (the log's names), their samples when the job gives none, and the
# Eevee probe (eevee_probe.py prints EEVEE_PROBE_LINE + the GPU backend).
ENGINES = {"cycles": "Cycles", "eevee": "Eevee"}
DEFAULT_SAMPLES = {"cycles": 128, "eevee": 64}
EEVEE_PROBE_LINE = "fornax-eevee: "
EEVEE_PROBE_TIMEOUT_S = 60
EEVEE_REFUSED = 'Eevee does not work on this worker (list_job_types says "Eevee unavailable"); use engine cycles'
BACKEND_LABELS = {"OPENGL": "OpenGL", "VULKAN": "Vulkan", "METAL": "Metal"}
# types/README.md: the environment text after "fornax-environment: " is at most 200 characters; the worker cuts the end.
ENVIRONMENT_MAX = 200


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
    p.add_argument("--ffmpeg", required=True)
    return p.parse_args(rest)


def frames(params):
    start = params["frame_start"]
    end = params.get("frame_end", start)
    if end < start:
        raise InvalidParams("frame_end must not be smaller than frame_start")
    if end - start + 1 > MAX_FRAMES:
        raise InvalidParams(f"at most {MAX_FRAMES} frames per job; split a longer range into several jobs")
    if params.get("video", False):
        if end == start:
            raise InvalidParams("a video needs at least 2 frames: set frame_end")
        if end - start + 1 > MAX_FRAMES - 1:
            # video.mp4 is one more file: 499 frames and their previews plus the video are 999 of the worker's 1000.
            raise InvalidParams(f"with video, at most {MAX_FRAMES - 1} frames per job; split a longer range into several jobs")
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


def outputs_entry(width, height, frame, samples, preview, engine):
    return {"meta": {"frame": frame, "width": width, "height": height, "samples": samples, "engine": engine}, "preview": preview}


def progress_line(done, total, frame):
    return json.dumps({"progress": round(done / total, 4), "message": f"frame {frame} ({done}/{total})"})


def eevee_engine_id(ids):
    """Blender's identifier of Eevee among the render engine ids: BLENDER_EEVEE in 5.x, BLENDER_EEVEE_NEXT in 4.2-4.x;
    None when this Blender has none."""
    return next((i for i in ids if i.startswith("BLENDER_EEVEE")), None)


def engine_of(params):
    """The server fills the default (cycles); a job file without it is a v2 job: Cycles."""
    return params.get("engine", "cycles")


def samples_for(params):
    """The job's samples, or the engine's default (spec 15 § 2: the schema has no default)."""
    return params.get("samples", DEFAULT_SAMPLES[engine_of(params)])


def timing_line(engine, frames_count, seconds):
    """The log's last render line: the time of the renders only (no previews, no video)."""
    per = seconds / frames_count if frames_count else 0.0
    return f"render: {frames_count} frame(s) with {ENGINES[engine]} in {seconds:.1f} s ({per:.2f} s per frame)"


def backend_label(raw):
    """gpu.platform.backend_type_get() for people: OPENGL -> OpenGL."""
    return BACKEND_LABELS.get(raw, raw)


def eevee_text(backend):
    """The environment's Eevee part: the raw backend of a passing probe, or None."""
    return f"Eevee on {backend_label(backend)}" if backend else "Eevee unavailable"


def probe_result(stdout):
    """The raw backend of the last EEVEE_PROBE_LINE line of the probe's stdout, or None."""
    prefix = EEVEE_PROBE_LINE.strip()  # lines are stripped: "fornax-eevee: " alone becomes "fornax-eevee:"
    found = None
    for line in stdout.splitlines():
        line = line.strip()
        if line.startswith(prefix):
            found = line[len(prefix):].strip() or None
    return found


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


def environment_line(version_string, kind, names, ffmpeg=None, eevee=None):
    """The check's line for list_job_types (types/README.md): Blender's version, the Cycles device, the GPUs, ffmpeg and
    whether Eevee works (eevee_text). The text stays within ENVIRONMENT_MAX characters: a long GPU list is shortened,
    so that the end (ffmpeg, Eevee) is never the part the worker cuts. "Blender X.Y" stays first (spec 14 § 3.2)."""
    head = f"Blender {version_string}, Cycles on {kind} ("
    tail = ")" + (f"; ffmpeg {ffmpeg}" if ffmpeg else "") + (f"; {eevee}" if eevee else "")
    gpus = ", ".join(names)
    room = ENVIRONMENT_MAX - len(head) - len(tail)
    if len(gpus) > room:
        gpus = gpus[:max(0, room - 3)] + "..."
    return f"fornax-environment: {head}{gpus}{tail}"


def gpu_settings(scene):
    """Cycles settings that keep the work on the card: the denoiser on the GPU (it runs on the CPU otherwise, and
    the CPU of a small PC becomes the bottleneck) and persistent data (the scene is not rebuilt for every frame).
    Returns what was set, for the log."""
    done = []
    if hasattr(scene.cycles, "denoising_use_gpu"):
        scene.cycles.denoising_use_gpu = True
        done.append("denoising on the GPU")
    scene.render.use_persistent_data = True
    done.append("persistent data")
    return done


def check_args(argv):
    """check.py's arguments after Blender's "--"."""
    rest = argv[argv.index("--") + 1:] if "--" in argv else []
    p = argparse.ArgumentParser(prog="check.py")
    p.add_argument("--ffmpeg", required=True)
    return p.parse_args(rest)


def video_args(ffmpeg, out_dir, frame_start, ext, fps, crf):
    """ffmpeg's command for video.mp4 from the frames (spec 14 § 5.2): H.264 in yuv420p, which every phone plays; the
    sizes padded to even numbers (yuv420p needs them); BT.709 colour, converted and tagged. The tags are set on the
    frames (setparams): ffmpeg's output options -color_primaries and -color_trc left them unknown in the stream. PNG
    frames carry straight alpha: they are premultiplied first, so a transparent background and its soft edges become
    black instead of their colour at full strength."""
    premultiply = "premultiply=inplace=1," if ext == "png" else ""
    return [
        ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
        "-framerate", str(fps), "-start_number", str(frame_start), "-i", os.path.join(out_dir, f"frame_%04d.{ext}"),
        "-vf", f"{premultiply}pad=ceil(iw/2)*2:ceil(ih/2)*2,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,"
               "setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709:range=tv",
        "-c:v", "libx264", "-crf", str(crf), "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", os.path.join(out_dir, "video.mp4"),
    ]


def video_entry(fps, frames_count, crf, width, height):
    """outputs.json entry of video.mp4: no preview; the size as encoded (padded to even numbers)."""
    return {"meta": {"fps": fps, "frames": frames_count, "crf": crf, "width": width + width % 2, "height": height + height % 2}}


def encoding_line():
    return json.dumps({"progress": 1.0, "message": "encoding the video"})


def ffmpeg_version(text):
    """"9.0.2" from the first line of `ffmpeg -version`; None when it is not ffmpeg's."""
    first = text.splitlines()[0] if text else ""
    parts = first.split()
    return parts[2] if len(parts) >= 3 and parts[0] == "ffmpeg" and parts[1] == "version" else None


def has_libx264(text):
    """Whether `ffmpeg -encoders` lists the libx264 encoder."""
    return any(len(line.split()) >= 2 and line.split()[1] == "libx264" for line in text.splitlines())
