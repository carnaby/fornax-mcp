#!/usr/bin/env python3
"""The tts pack's setup, run with the system Python (tools.python in worker.yaml, 3.10 or newer). Everything goes into
{pack}/env, nothing outside it changes (spec 10 § 3.2):
  env/uv/               a small venv with uv (from PyPI)
  env/python/           CPython 3.12.16, which uv downloads (the version the probe measured)
  env/                  the job's Python environment ({python}): PyTorch with CUDA 12.8, OmniVoice and Piper, locked
                        in scripts/requirements.txt
  env/models/omnivoice/ OmniVoice at its pinned revision (8 files, 3.3 GB, each checked by sha256)
  env/models/piper/     the Piper voice sk_SK-lili-medium at its pinned revision (63 MB, checked by sha256)
Safe to run again: finished parts are kept. uv's cache (env/.uv-cache) is removed at the end.
"""
import hashlib
import http.client
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

from common import (
    ENV,
    OMNIVOICE_DIR,
    OMNIVOICE_FILES,
    OMNIVOICE_URL,
    PIPER_DIR,
    PIPER_FILES,
    PIPER_URL,
    PYTHON_DIR,
    PYTHON_VERSION,
    SCRIPTS,
    UV_CACHE,
    UV_VENV,
    UV_VERSION,
    setup_streams,
    venv_python,
)

CHUNK = 8 * 1024 * 1024


class SetupError(Exception):
    pass


def say(message):
    print(f"setup: {message}", flush=True)


def step(cmd, what, env=None):
    say(what)
    r = subprocess.run([str(c) for c in cmd], env=env)
    if r.returncode != 0:
        raise SetupError(f"{what} failed (exit {r.returncode})")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            block = f.read(CHUNK)
            if not block:
                return h.hexdigest()
            h.update(block)


def download(url, dest):
    say(f"downloading {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "fornax-tts-setup"})
    done, next_line = 0, 256 * 1024 * 1024
    with urllib.request.urlopen(request, timeout=60) as r, open(dest, "wb") as f:
        while True:
            block = r.read(CHUNK)
            if not block:
                break
            f.write(block)
            done += len(block)
            if done >= next_line:
                say(f"  {done // (1024 * 1024)} MiB")
                next_line += 256 * 1024 * 1024


def ensure_files(folder, files, base_url, fetch):
    """Each pinned file (relative POSIX path -> size, sha256) in `folder`: kept when it matches, else fetched from
    base_url + path into <file>.part, checked, renamed."""
    folder = Path(folder)
    for rel, (size, sha256) in files.items():
        dest = folder / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.is_file() and dest.stat().st_size == size and sha256_file(dest) == sha256:
            say(f"keeping {rel}")
            continue
        part = dest.with_name(dest.name + ".part")
        try:
            fetch(base_url + rel, part)
            if part.stat().st_size != size or sha256_file(part) != sha256:
                raise SetupError(f"the download of {rel} does not match its pinned size and sha256: run the setup again")
            os.replace(part, dest)
            say(f"{rel} is in {folder}")
        finally:
            part.unlink(missing_ok=True)


def uv_env():
    return dict(os.environ, UV_CACHE_DIR=str(UV_CACHE), UV_PYTHON_INSTALL_DIR=str(PYTHON_DIR), UV_NO_CONFIG="1")


def bootstrap_ok(venv):
    """True when the venv's Python exists and runs pip (a half-made venv, e.g. without python3-venv, has no pip)."""
    python = venv_python(venv)
    if not python.exists():
        return False
    r = subprocess.run([str(python), "-m", "pip", "--version"], capture_output=True)
    return r.returncode == 0


def ensure_uv():
    uv = UV_VENV / ("Scripts/uv.exe" if os.name == "nt" else "bin/uv")
    if not bootstrap_ok(UV_VENV):
        say(f"creating {UV_VENV} for uv")
        r = subprocess.run([sys.executable, "-m", "venv", "--clear", str(UV_VENV)])
        if r.returncode != 0 or not bootstrap_ok(UV_VENV):
            raise SetupError(
                f"creating the venv {UV_VENV} for uv failed (exit {r.returncode}): install the venv module of tools.python"
                " (python3-venv on Debian or Ubuntu) and run the setup again"
            )
    step([venv_python(UV_VENV), "-m", "pip", "install", "--disable-pip-version-check", "--no-cache-dir", f"uv=={UV_VERSION}"], f"installing uv {UV_VERSION}")
    return uv


def ensure_python(uv):
    # --no-bin: no python3.12 in ~/.local/bin; --no-registry (Windows only): no PEP 514 entry under HKCU. Nothing
    # outside the pack.
    flags = ["--no-bin", "--no-registry"] if os.name == "nt" else ["--no-bin"]
    step([uv, "python", "install", PYTHON_VERSION, *flags], f"installing CPython {PYTHON_VERSION} into {PYTHON_DIR}", env=uv_env())
    r = subprocess.run([str(uv), "python", "find", "--managed-python", PYTHON_VERSION], env=uv_env(), capture_output=True, text=True)
    if r.returncode != 0 or not r.stdout.strip():
        raise SetupError(f"uv does not find the CPython {PYTHON_VERSION} it installed: {r.stderr.strip()}")
    return r.stdout.strip().splitlines()[-1]


def ensure_venv(uv, python):
    current = venv_python(ENV)
    if current.exists():
        r = subprocess.run([str(current), "-c", "import platform; print(platform.python_version())"], capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.strip() == PYTHON_VERSION:
            say(f"keeping the Python environment {ENV}")
            return
    step([uv, "venv", ENV, "--python", python, "--allow-existing"], f"creating the Python environment {ENV}", env=uv_env())


def sync(uv):
    step(
        [uv, "pip", "sync", SCRIPTS / "requirements.txt", "--python", venv_python(ENV), "--index-strategy", "unsafe-best-match"],
        "installing PyTorch (CUDA 12.8), OmniVoice and Piper (about 7.5 GB)",
        env=uv_env(),
    )


def main():
    setup_streams()
    if sys.version_info < (3, 10):
        print("setup: Python 3.10 or newer is needed to run the setup; point tools.python in worker.yaml at one", file=sys.stderr)
        sys.exit(1)
    say(f"everything goes into {ENV}")
    try:
        ENV.mkdir(exist_ok=True)
        uv = ensure_uv()
        python = ensure_python(uv)
        ensure_venv(uv, python)
        sync(uv)
        ensure_files(OMNIVOICE_DIR, OMNIVOICE_FILES, OMNIVOICE_URL, download)
        ensure_files(PIPER_DIR, PIPER_FILES, PIPER_URL, download)
    except (SetupError, OSError, http.client.HTTPException) as e:
        if isinstance(e, http.client.HTTPException):
            message = f"a download broke off ({type(e).__name__}: {e}): run the setup again"
        else:
            message = str(e)
        print(f"setup: {message}", file=sys.stderr, flush=True)
        sys.exit(1)
    finally:
        shutil.rmtree(UV_CACHE, ignore_errors=True)
    say("done: `fornax doctor tts` checks it")


if __name__ == "__main__":
    main()
