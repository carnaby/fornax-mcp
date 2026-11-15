#!/usr/bin/env python3
"""The upscale pack's setup, run with the system Python (tools.python in worker.yaml, 3.10 or newer). Everything goes
into {pack}/env, nothing outside it changes:
  env/uv/        a small venv with uv (from PyPI)
  env/python/    CPython 3.13.18, which uv downloads (the version SeedVR2 was measured with)
  env/           the job's Python environment ({python}): PyTorch with CUDA 12.8 and SeedVR2's packages, locked in
                 scripts/requirements.txt
  env/seedvr2/   SeedVR2's source at the pinned commit (a GitHub archive, checked by sha256)
  env/models/    the DiT and VAE models (7.3 GB, checked by sha256): from SEEDVR2_MODELS_FROM when it names a folder
                 that holds them (hard-linked on the same disk, else copied), otherwise downloaded from Hugging Face
Safe to run again: finished parts are kept. uv's cache (env/.uv-cache) is removed at the end.
"""
import hashlib
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

from common import (
    ENV,
    MODELS,
    MODELS_DIR,
    MODELS_URL,
    PYTHON_DIR,
    PYTHON_VERSION,
    SCRIPTS,
    SEEDVR2_DIR,
    SEEDVR2_ZIP_SHA256,
    SEEDVR2_ZIP_URL,
    UV_CACHE,
    UV_VENV,
    UV_VERSION,
    setup_streams,
    venv_python,
)

TORCH_INDEX = "https://download.pytorch.org/whl/cu128"
SOURCE_MARKER = ".fornax-source-sha256"
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
    request = urllib.request.Request(url, headers={"User-Agent": "fornax-upscale-setup"})
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


def extract_stripped(zip_path, dest):
    """The archive's files without its single root folder; a member that would land outside `dest` is refused."""
    dest = Path(dest)
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            parts = PurePosixPath(info.filename).parts[1:]
            if not parts:
                continue
            if any(part in ("..", "") for part in parts) or PurePosixPath(*parts).is_absolute() or ":" in parts[0]:
                raise SetupError(f"the archive holds a path outside its folder: {info.filename}")
            target = dest.joinpath(*parts)
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)


def ensure_source(dest_dir, fetch, url=SEEDVR2_ZIP_URL, sha256=SEEDVR2_ZIP_SHA256):
    dest_dir = Path(dest_dir)
    marker = dest_dir / SOURCE_MARKER
    if (dest_dir / "inference_cli.py").is_file() and marker.is_file() and marker.read_text(encoding="utf-8").strip() == sha256:
        say(f"keeping SeedVR2 in {dest_dir}")
        return
    part = dest_dir.parent / "seedvr2.zip.part"
    fresh = dest_dir.parent / "seedvr2.new"
    try:
        fetch(url, part)
        got = sha256_file(part)
        if got != sha256:
            raise SetupError(f"the SeedVR2 archive has sha256 {got}, not the pinned {sha256}: GitHub changed the archive, and this pack version needs a new pin")
        shutil.rmtree(fresh, ignore_errors=True)
        extract_stripped(part, fresh)
        shutil.rmtree(dest_dir, ignore_errors=True)
        os.replace(fresh, dest_dir)
        marker.write_text(sha256, encoding="utf-8")
        say(f"SeedVR2 is in {dest_dir}")
    finally:
        part.unlink(missing_ok=True)
        shutil.rmtree(fresh, ignore_errors=True)


def link_or_copy(src, dest):
    dest = Path(dest)
    dest.unlink(missing_ok=True)
    try:
        os.link(src, dest)
        say(f"linked {dest.name} (a hard link: no extra disk space)")
        return
    except OSError:
        pass
    part = dest.with_name(dest.name + ".part")
    shutil.copyfile(src, part)
    os.replace(part, dest)
    say(f"copied {dest.name}")


def ensure_models(models_dir, models_from, fetch, models=MODELS, base_url=MODELS_URL):
    models_dir = Path(models_dir)
    models_dir.mkdir(parents=True, exist_ok=True)
    for name, (size, sha256) in models.items():
        dest = models_dir / name
        if dest.is_file() and dest.stat().st_size == size and sha256_file(dest) == sha256:
            say(f"keeping {name}")
            continue
        if models_from:
            src = Path(models_from) / name
            if not src.is_file():
                raise SetupError(f"SEEDVR2_MODELS_FROM: {src} is missing")
            if src.stat().st_size != size or sha256_file(src) != sha256:
                raise SetupError(f"SEEDVR2_MODELS_FROM: {src} is not the pinned {name} (its size or sha256 differs)")
            link_or_copy(src, dest)
            continue
        part = dest.with_name(dest.name + ".part")
        try:
            fetch(base_url + name, part)
            if part.stat().st_size != size or sha256_file(part) != sha256:
                raise SetupError(f"the download of {name} does not match its pinned size and sha256: run the setup again")
            os.replace(part, dest)
            say(f"{name} is in {models_dir}")
        finally:
            part.unlink(missing_ok=True)


def uv_env():
    return dict(os.environ, UV_CACHE_DIR=str(UV_CACHE), UV_PYTHON_INSTALL_DIR=str(PYTHON_DIR), UV_NO_CONFIG="1")


def ensure_uv():
    uv = UV_VENV / ("Scripts/uv.exe" if os.name == "nt" else "bin/uv")
    if not venv_python(UV_VENV).exists():
        step([sys.executable, "-m", "venv", UV_VENV], f"creating {UV_VENV} for uv")
    step([venv_python(UV_VENV), "-m", "pip", "install", "--disable-pip-version-check", "--no-cache-dir", f"uv=={UV_VERSION}"], f"installing uv {UV_VERSION}")
    return uv


def ensure_python(uv):
    step([uv, "python", "install", PYTHON_VERSION], f"installing CPython {PYTHON_VERSION} into {PYTHON_DIR}", env=uv_env())
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
        "installing PyTorch (CUDA 12.8) and SeedVR2's packages (about 4.5 GB)",
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
        ensure_source(SEEDVR2_DIR, download)
        models_from = os.environ.get("SEEDVR2_MODELS_FROM", "").strip() or None
        if models_from:
            say(f"taking the models from {models_from} (SEEDVR2_MODELS_FROM)")
        ensure_models(MODELS_DIR, models_from, download)
    except (SetupError, OSError) as e:
        print(f"setup: {e}", file=sys.stderr, flush=True)
        sys.exit(1)
    finally:
        shutil.rmtree(UV_CACHE, ignore_errors=True)
    say("done: `fornax doctor upscale` checks it")


if __name__ == "__main__":
    main()
