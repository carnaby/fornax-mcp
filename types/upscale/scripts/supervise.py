"""Runs SeedVR2's launcher under the VRAM watchdog and the time limit, steps the batch down on an out-of-memory, and
kills an attempt's whole process tree. Reads nvidia-smi."""
import codecs
import os
import queue
import signal
import subprocess
import threading

from upscale_lib import (
    GPU_QUERY,
    MAX_BLIND_POLLS,
    POLL_S,
    READ_TIMEOUT_S,
    REFUSED_PREFIX,
    USED_QUERY,
    Attempt,
    LadderResult,
    LineSplitter,
    Stopped,
    began_processing,
    is_out_of_memory,
    is_progress_bar,
    next_batch,
    parse_gpus,
    parse_used_mib,
)

# The command that reads the card; tests replace it with a fake.
NVIDIA_SMI = ["nvidia-smi"]
CAPPED_REFUSED, CAPPED_BAD_SETTING = 10, 11
TAIL_LINES = 12


class Broken(Exception):
    """The environment cannot run the job (run.py exits 3)."""


class CardBusy(Exception):
    """The card cannot take an attempt now (refused before it started; run.py exits 1)."""


def nvidia_smi(args, timeout):
    r = subprocess.run([*NVIDIA_SMI, *args], stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
    if r.returncode != 0:
        raise OSError(f"exit {r.returncode}")
    return r.stdout.decode("utf-8", "replace")


def read_gpu():
    """The one card's state (Broken: no answer, or not exactly one card)."""
    try:
        gpus = parse_gpus(nvidia_smi(GPU_QUERY, 15))
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        raise Broken(
            f"nvidia-smi did not answer ({e}): it comes with the NVIDIA driver, and without it the watchdog cannot see "
            "the card, so nothing runs"
        ) from None
    if len(gpus) != 1:
        raise Broken(f"nvidia-smi lists {len(gpus)} GPUs: more than one GPU is not supported yet")
    return gpus[0]


def read_used_mib():
    """The watchdog's reading, or None (no answer in READ_TIMEOUT_S, or no number)."""
    try:
        return parse_used_mib(nvidia_smi(USED_QUERY, READ_TIMEOUT_S))
    except (OSError, subprocess.TimeoutExpired):
        return None


def kill_tree(pid):
    """Ends a process and everything it started, at once."""
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            pass
    else:
        try:
            os.killpg(pid, signal.SIGKILL)  # ProcessJob starts it in a session (process group) of its own
        except (ProcessLookupError, PermissionError):
            pass


class ProcessJob:
    """A started process; its stdout and stderr together go to `on_line` line by line. Its stdin is a pipe this side
    never writes: the launcher ends when it closes (the tether)."""

    def __init__(self, argv, cwd, env, on_line):
        kwargs = {"start_new_session": True} if os.name != "nt" else {}
        self._p = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **kwargs)
        self.pid = self._p.pid
        self._splitter = LineSplitter(on_line)
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._reader.start()

    def _read(self):
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        fd = self._p.stdout.fileno()
        while True:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            self._splitter.push(decoder.decode(chunk))
        self._splitter.push(decoder.decode(b"", final=True))
        self._splitter.flush()

    def wait(self, timeout):
        """The exit code, or None when it still runs after `timeout` seconds (None: wait for the end)."""
        try:
            code = self._p.wait(timeout)
        except subprocess.TimeoutExpired:
            return None
        self._reader.join(5)  # every line is handed over before the code; a grandchild holding the pipe cannot block
        for stream in (self._p.stdin, self._p.stdout):
            try:
                stream.close()
            except OSError:
                pass
        return code

    def kill(self):
        if self._p.poll() is None:
            kill_tree(self._p.pid)
        try:
            self._p.kill()
        except OSError:
            pass


def _read_with_timeout(read, timeout):
    box = queue.Queue(maxsize=1)

    def go():
        try:
            box.put(read())
        except Exception:
            box.put(None)

    threading.Thread(target=go, daemon=True).start()
    try:
        return box.get(timeout=max(0.0, timeout))
    except queue.Empty:
        return None


def supervise(start, read_used_mib, limit_mib, max_seconds, clock, on_line=None, poll_s=POLL_S, read_timeout_s=READ_TIMEOUT_S):
    """Runs one attempt under the watchdog and the time limit: reads the card at once and then every `poll_s`, and
    kills the attempt's tree the moment a reading passes `limit_mib`, the time is up, or MAX_BLIND_POLLS readings in a
    row gave no number. A reading that takes longer than `read_timeout_s` counts as none. Whatever raises here kills
    the attempt first."""
    t0 = clock()

    def elapsed():
        return clock() - t0

    state = {"began": False, "oom": False, "early": False, "refused": None}
    tail = []

    def handle(line):
        if began_processing(line):
            state["began"] = True
        if is_out_of_memory(line):
            state["oom" if state["began"] else "early"] = True
        if line.startswith(REFUSED_PREFIX):
            state["refused"] = line
        if not is_progress_bar(line):
            tail.append(line)
            del tail[:-TAIL_LINES]
        if on_line:
            on_line(line)

    job = start(handle)
    peak, blind, stopped, code = 0, 0, None, None
    try:
        while True:
            read_at = elapsed()
            if read_at >= max_seconds:
                stopped = Stopped("time")
                break
            used = _read_with_timeout(read_used_mib, min(read_timeout_s, max_seconds - read_at))
            code = job.wait(0)
            if code is not None:
                break
            if used is not None:
                blind = 0
                peak = max(peak, used)
            if used is not None and used > limit_mib:
                stopped = Stopped("vram", used_mib=used, limit_mib=limit_mib)
            elif elapsed() >= max_seconds:
                stopped = Stopped("time")
            elif used is None:
                blind += 1
                if blind >= MAX_BLIND_POLLS:
                    stopped = Stopped("blind", polls=blind)
            if stopped:
                break
            code = job.wait(max(0.0, min(read_at + poll_s, max_seconds) - elapsed()))
            if code is not None:
                break
    except BaseException:
        job.kill()
        raise
    if stopped:
        job.kill()
        code = job.wait(None)
    return Attempt(
        code=1 if code is None else code, stopped=stopped, peak_mib=peak, seconds=elapsed(),
        out_of_memory=state["oom"], early_out_of_memory=state["early"], refused=state["refused"], tail=list(tail),
    )


def run_ladder(batch, overlap, start_attempt, read_used_mib, limit_mib, max_seconds, clock, say=None, on_line=None, poll_s=POLL_S, read_timeout_s=READ_TIMEOUT_S):
    """One clip through SeedVR2: an attempt at `batch`; one that fails with an out-of-memory raised after processing
    began (the cap held) is tried again once per step down the ladder, each step said. Not tried again: an attempt the
    watchdog killed (the card is contested), a launcher that refused or found a bad setting, an out-of-memory before
    processing began (CUDA could not start), any other failure. `max_seconds` holds for every attempt together."""
    t0 = clock()
    tried, peak = [], 0
    while True:
        tried.append(batch)
        left = max_seconds - (clock() - t0)
        try:
            last = supervise(lambda handle, b=batch: start_attempt(b, handle), read_used_mib, limit_mib, left, clock, on_line, poll_s, read_timeout_s)
        except CardBusy as e:
            last = Attempt(code=1, refused=str(e))
            return LadderResult(False, "refused", batch, tried, last, peak, clock() - t0)
        peak = max(peak, last.peak_mib)

        def done(ok, reason=None):
            return LadderResult(ok, reason, batch, tried, last, peak, clock() - t0)

        if last.stopped:
            return done(False, last.stopped.guard)
        if last.code == 0:
            return done(True)
        if last.code == CAPPED_BAD_SETTING:
            return done(False, "bad-env")
        if last.refused or last.code == CAPPED_REFUSED:
            return done(False, "refused")
        if not last.out_of_memory:
            return done(False, "startup" if last.early_out_of_memory else "exit")
        smaller = next_batch(batch, overlap)
        if smaller is None:
            return done(False, "oom")
        if clock() - t0 >= max_seconds:
            return done(False, "time")
        if say:
            say(f"out of memory at batch {batch} (PyTorch's cap held, nothing spilled): trying batch {smaller}")
        batch = smaller
