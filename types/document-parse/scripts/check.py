#!/usr/bin/env python3
"""The document-parse pack's check (runs in {pack}/env, at most 120 s, without loading a model; spec 11 § 3.3): the
model files are in place, docling, rapidocr, pypdfium2 and transformers are installed, transformers has PaddleOCR-VL,
PyTorch sees CUDA. No arguments. Exit 0 ready (a summary line and the fornax-environment line), 3 not ready (one sentence)."""
import argparse
import importlib.metadata
import importlib.util
import os
import platform
import sys

import common
from common import ENVIRONMENT, say, setup_streams

LIBRARIES = ("docling", "rapidocr", "pypdfium2", "transformers")


def version(dist):
    try:
        return importlib.metadata.version(dist)
    except importlib.metadata.PackageNotFoundError:
        return "?"


def fail(message):
    say(message)
    sys.exit(ENVIRONMENT)


def main(argv=None):
    setup_streams()
    os.environ.update(common.library_env())
    argparse.ArgumentParser(prog="check.py").parse_args(argv)
    problems = common.model_problems("")
    if problems:
        fail("; ".join(problems) + ": run fornax types setup document-parse")
    for module in LIBRARIES:
        if importlib.util.find_spec(module) is None:
            fail(f"{module} is not installed in this pack: run fornax types setup document-parse")
    try:
        import torch
    except Exception as e:  # a broken env raises anything at import
        fail(f"PyTorch does not load ({e}): run fornax types setup document-parse")
    if not torch.cuda.is_available():
        fail("PyTorch sees no CUDA device: install or update the NVIDIA driver")
    try:
        import transformers

        transformers.PaddleOCRVLForConditionalGeneration  # noqa: B018  (a lazy attribute: this imports the model code)
    except Exception as e:
        fail(f"transformers {version('transformers')} has no PaddleOCR-VL ({type(e).__name__}): run fornax types setup document-parse")
    environment = (f"PyTorch {torch.__version__} (CUDA {torch.version.cuda}), docling {version('docling')}, "
                   f"transformers {version('transformers')}, rapidocr {version('rapidocr')}; {torch.cuda.get_device_name(0)}")
    print(f"Python {platform.python_version()}, {environment}")
    print(f"fornax-environment: {environment}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
