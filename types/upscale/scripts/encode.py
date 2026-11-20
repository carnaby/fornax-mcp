"""Encodes SeedVR2's PNG frames into the result, checks it frame by frame count, and makes its preview. Needs ffmpeg
and ffprobe."""
import os
import subprocess
import threading
from pathlib import Path

from supervise import kill_tree
from upscale_lib import AUDIO_PROBE_ARGS, PROBE_ARGS, Rejected, encode_args, parse_audio_codec, parse_probe, preview_size


class EncodeError(Exception):
    """The encode failed (run.py exits 1); nothing is delivered."""


class ToolError(Exception):
    """ffmpeg or ffprobe does not run (run.py exits 3)."""


def _run(argv, timeout):
    try:
        return subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
    except OSError as e:
        raise ToolError(f"{argv[0]} does not run ({e}): check tools in worker.yaml") from None


def probe(ffprobe, path):
    """The video stream of `path` (Rejected: unreadable; ToolError: ffprobe does not run)."""
    try:
        r = _run([ffprobe, *PROBE_ARGS, str(path)], 600)
    except subprocess.TimeoutExpired:
        raise Rejected("ffprobe took more than 10 minutes to read the video") from None
    try:
        return parse_probe(r.stdout.decode("utf-8", "replace"))
    except Rejected as e:
        detail = r.stderr.decode("utf-8", "replace").strip().splitlines()
        raise Rejected(f"{e}{': ' + detail[-1] if detail else ''}") from None


def audio_codec(ffprobe, path):
    """The codec of the first sound track, or None (no track, or unreadable)."""
    try:
        r = _run([ffprobe, *AUDIO_PROBE_ARGS, str(path)], 120)
    except subprocess.TimeoutExpired:
        return None
    return parse_audio_codec(r.stdout.decode("utf-8", "replace"))


def encode_frames(ffmpeg, ffprobe, frames, src, out, audio_source=None, audio=None, on_progress=None):
    """The PNGs, in order, piped into libx264 (encode_args) -> `out`, written as <stem>.part.mp4 first: a file with
    another number of frames than went in is removed, not delivered. Returns the written file's probe."""
    out = Path(out)
    tmp = out.with_name(out.stem + ".part.mp4")
    try:
        p = subprocess.Popen([ffmpeg, *encode_args(src, tmp, audio_source, audio)], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except OSError as e:
        raise ToolError(f"{ffmpeg} does not run ({e}): check tools.ffmpeg in worker.yaml") from None
    err = []
    reader = threading.Thread(target=lambda: err.append(p.stderr.read()), daemon=True)
    reader.start()
    try:
        try:
            for i, frame in enumerate(frames):
                try:
                    p.stdin.write(Path(frame).read_bytes())
                except OSError:
                    break  # the encoder ended early: its exit code says why
                if on_progress and (i + 1) % 24 == 0:
                    on_progress(i + 1, len(frames))
            try:
                p.stdin.close()
            except OSError:
                pass
            code = p.wait()
        except BaseException:
            # A launcher (scoop's or chocolatey's shim) runs the real ffmpeg as its child: killing only the launcher
            # left ffmpeg holding the temporary file for a moment, and on Windows it could not be removed.
            if os.name == "nt" and p.poll() is None:  # once reaped, its pid may already be another process's
                kill_tree(p.pid)
            p.kill()
            p.wait()
            try:
                p.stdin.close()
            except OSError:
                pass
            raise
        finally:
            reader.join(10)
            if not reader.is_alive():
                p.stderr.close()
        if code != 0:
            lines = b"".join(err).decode("utf-8", "replace").strip().splitlines()
            raise EncodeError(f"ffmpeg could not encode the frames (exit {code}){': ' + lines[-1] if lines else ''}")
        try:
            written = probe(ffprobe, tmp)
        except Rejected as e:
            raise EncodeError(f"the encoded file could not be read back ({e})") from None
        if written.frames != len(frames):
            raise EncodeError(f"the encoded file has {written.frames} frames, {len(frames)} went in")
        os.replace(tmp, out)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return written


def make_preview(ffmpeg, frame, width, height, dest):
    """A JPEG of one frame, at most PREVIEW_MAX_PX on the longer side."""
    w, h = preview_size(width, height)
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        r = _run([ffmpeg, "-v", "error", "-y", "-i", str(frame), "-vf", f"scale={w}:{h}", "-frames:v", "1", "-update", "1", "-q:v", "3", str(dest)], 120)
    except subprocess.TimeoutExpired:
        raise EncodeError("ffmpeg took more than 2 minutes for the preview") from None
    if r.returncode != 0:
        raise EncodeError(f"ffmpeg could not write the preview (exit {r.returncode})")
