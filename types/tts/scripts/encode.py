"""Streams the speech into ffmpeg (float32 PCM on its stdin) while it is being spoken, and delivers speech.<ext> only
when ffmpeg succeeded (spec 10 § 4.7)."""
import os
import subprocess
import threading
import time
from pathlib import Path

from tts_lib import encode_args, output_name


class EncodeError(Exception):
    """The encode failed (run.py exits 1); nothing is delivered."""


class ToolError(Exception):
    """ffmpeg does not run (run.py exits 3)."""


# How long a temporary file another process still holds is tried again before it is left behind.
REMOVE_WAIT_S = 5.0


def remove_soon(path, seconds=None):
    """Removes `path` (already gone is fine); True once it is gone. On Windows a file that is still open cannot be
    removed (WinError 32): it is tried again until `seconds` (REMOVE_WAIT_S) are up. Never raises: a failed cleanup
    must not replace the error being raised."""
    deadline = time.monotonic() + (REMOVE_WAIT_S if seconds is None else seconds)
    while True:
        try:
            Path(path).unlink(missing_ok=True)
            return True
        except OSError:
            if os.name != "nt" or time.monotonic() >= deadline:
                return False
            time.sleep(0.05)


def kill_tree(pid):
    """Windows: a launcher (scoop's or chocolatey's shim) runs the real ffmpeg as its child; kill both."""
    subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], stdin=subprocess.DEVNULL, capture_output=True)


class Encoder:
    """ffmpeg writing <out>/speech.part.<ext>; finish() renames it to speech.<ext>, abort() removes it."""

    def __init__(self, ffmpeg, sample_rate, fmt, out_dir):
        self.sample_rate = sample_rate
        self.dest = Path(out_dir) / output_name(fmt)
        self.tmp = self.dest.with_name(f"{self.dest.stem}.part{self.dest.suffix}")
        self.written = 0
        self.closed = False
        try:
            self.p = subprocess.Popen([ffmpeg, *encode_args(fmt, sample_rate, self.tmp)], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        except OSError as e:
            raise ToolError(f"{ffmpeg} does not run ({e}): check tools.ffmpeg in worker.yaml") from None
        self.err = []
        self.reader = threading.Thread(target=lambda: self.err.append(self.p.stderr.read()), daemon=True)
        self.reader.start()

    @property
    def seconds(self):
        return self.written / 4 / self.sample_rate

    def write(self, pcm):
        try:
            self.p.stdin.write(pcm)
        except OSError:
            code = self.p.wait()
            self._join()
            raise EncodeError(self._why(f"ffmpeg stopped taking the speech (exit {code})")) from None
        self.written += len(pcm)

    def finish(self):
        try:
            try:
                self.p.stdin.close()
            except OSError:
                pass
            code = self.p.wait()
            self._join()
            if code != 0:
                raise EncodeError(self._why(f"ffmpeg could not encode the speech (exit {code})"))
            os.replace(self.tmp, self.dest)
            self.closed = True
            return self.dest
        except BaseException:
            self.abort()
            raise

    def abort(self):
        """Stops ffmpeg and removes the temporary file; safe to call more than once."""
        if self.closed:
            return
        self.closed = True
        if self.p.poll() is None:
            if os.name == "nt":
                kill_tree(self.p.pid)
            self.p.kill()
        self.p.wait()
        try:
            self.p.stdin.close()
        except OSError:
            pass
        self._join()
        remove_soon(self.tmp)

    def _join(self):
        self.reader.join(10)
        if not self.reader.is_alive() and not self.p.stderr.closed:
            self.p.stderr.close()

    def _why(self, head):
        lines = b"".join(self.err).decode("utf-8", "replace").strip().splitlines()
        return f"{head}{': ' + lines[-1] if lines else ''}"
