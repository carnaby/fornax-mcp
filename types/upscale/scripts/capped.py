#!/usr/bin/env python3
# python capped.py <arguments of inference_cli.py...>   (cwd: SeedVR2's folder; run.py starts it)
"""SeedVR2's CLI with PyTorch forbidden to reserve more GPU memory than is free now minus a margin.

Past that cap PyTorch raises an out-of-memory error instead of letting the Windows NVIDIA driver page VRAM into system
RAM, which can freeze the PC. The CLI runs in this same process (runpy), so the cap holds for everything it allocates.

"Free" is the smaller of two figures: PyTorch's own (torch.cuda.mem_get_info) and nvidia-smi's, which run.py reads
right before it starts this and hands over. PyTorch's alone is not enough: on Windows (WDDM) it does not count what
other processes hold. Without the variable (run by hand) the launcher uses PyTorch's figure.

Environment (set by run.py; nothing here switches the cap off or raises it):
  UPSCALE_MARGIN_GB  GB kept free below the cap: default 3, never below 2.
  UPSCALE_FREE_MIB   the card's free memory by nvidia-smi, in MiB; it can only lower the cap.
  UPSCALE_TETHER=1   stdin is a pipe held by run.py (the VRAM watchdog and the time limit); when run.py is gone the
                     pipe closes and this process ends with whatever it started: a job never runs unwatched.
A setting that is not a number of 0 or more ends this with 11 before anything starts; no free memory beyond the
margin ends it with 10.

This file is standalone: it imports nothing from the pack, and hides its own folder from sys.path before the CLI
runs, so no pack module can shadow one of SeedVR2's.
"""
import math
import os
import runpy
import signal
import subprocess
import sys
import threading

REFUSED, BAD_SETTING, WATCHER_GONE = 10, 11, 70
DEFAULT_MARGIN_GB = 3.0
MIN_MARGIN_GB = 2.0
GB = 1024 ** 3
MIB = 1024 ** 2


def number(name):
    """The variable as a number of 0 or more; None when it is not set (or empty); exit 11 when it is anything else."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    try:
        value = float(raw)
    except ValueError:
        value = math.nan
    if not math.isfinite(value) or value < 0:
        print(f"[capped] {name}={raw!r} is not a number of 0 or more - run.py sets it; nothing started", flush=True)
        sys.exit(BAD_SETTING)
    return value


def end_with_watcher(pipe):
    # os.read on a descriptor, not sys.stdin: a daemon thread blocked inside sys.stdin's lock aborts the
    # interpreter's shutdown after a successful run.
    try:
        while os.read(pipe, 4096):
            pass
    except OSError:
        pass
    try:
        try:
            print("[capped] the process that watches this job is gone - ending the job", flush=True)
        except Exception:
            pass  # it held the other end of stdout too: the write fails, and must not stop what follows
        if os.name == "nt":
            # By full path, as the worker runs it: not a taskkill.exe from SeedVR2's folder or PATH.
            taskkill = os.path.join(os.environ.get("SystemRoot", "C:" + chr(92) + "Windows"), "System32", "taskkill.exe")
            subprocess.run([taskkill, "/F", "/T", "/PID", str(os.getpid())], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        else:
            os.killpg(os.getpgid(0), signal.SIGKILL)  # run.py starts this in a session (process group) of its own
    finally:
        os._exit(WATCHER_GONE)  # whatever the lines above did or raised


def tether():
    # The watcher's pipe moves to a descriptor of this process alone, and descriptor 0 becomes the null device: every
    # child inherits descriptor 0, and a Python child would hang at its start-up on a pipe a thread here reads.
    pipe = os.dup(0)  # not inheritable
    null = os.open(os.devnull, os.O_RDONLY)
    os.dup2(null, 0)
    os.close(null)
    threading.Thread(target=end_with_watcher, args=(pipe,), daemon=True).start()


def main():
    if os.environ.get("UPSCALE_TETHER") == "1":
        tether()
    margin = number("UPSCALE_MARGIN_GB")
    margin = max(MIN_MARGIN_GB, DEFAULT_MARGIN_GB if margin is None else margin)
    given_mib = number("UPSCALE_FREE_MIB")
    given = None if given_mib is None else given_mib * MIB

    import torch  # after the settings: a bad setting needs no CUDA

    own, total = torch.cuda.mem_get_info(0)
    # The smaller of the two: the figure given can lower the cap, never raise it above what PyTorch itself would allow.
    free = own if given is None else min(own, given)
    budget = free - margin * GB
    figures = f"PyTorch sees {own / GB:.1f} GB free of {total / GB:.1f} GB"
    ruled = "PyTorch's figure"
    if given is not None:
        figures += f", nvidia-smi {given / GB:.1f} GB"
        ruled = "nvidia-smi's figure, the smaller" if given < own else "PyTorch's figure, the smaller"
    if budget <= 0:
        print(f"[capped] refused: {figures} - not more than the {margin:g} GB margin ({ruled}) - free the card first", flush=True)
        sys.exit(REFUSED)
    torch.cuda.set_per_process_memory_fraction(budget / total, 0)
    print(f"[capped] GPU memory: {figures}; PyTorch capped at {budget / GB:.1f} GB ({ruled} - {margin:g} GB)", flush=True)
    here = os.path.normcase(os.path.dirname(os.path.abspath(__file__)))
    sys.path[:] = [p for p in sys.path if os.path.normcase(os.path.abspath(p or ".")) != here]
    sys.argv = ["inference_cli.py", *sys.argv[1:]]
    runpy.run_path("inference_cli.py", run_name="__main__")


if __name__ == "__main__":
    main()
