#!/usr/bin/env python3
"""The tts pack's job (spec 10 § 4). argv: --params <params.json> --text-file <path, or empty when not given>
--ffmpeg <ffmpeg> --out <dir> --work <dir>. Exit 0 done, 1 failed (retried), 2 the request or the text cannot be
spoken, 3 the environment is broken (a model, a voice, CUDA or ffmpeg is missing)."""
import argparse
import json
import os
import time
from pathlib import Path

import common
import tts_lib as lib
from common import ENVIRONMENT, FAILED, INVALID, OK, progress, say, setup_streams
from encode import EncodeError, Encoder, ToolError


def fail(code, message):
    say(message)
    return code


def remove_quietly(*paths):
    """Removes files that a failed job must not leave behind; a path that cannot be removed is left as it is."""
    for path in paths:
        try:
            Path(path).unlink(missing_ok=True)
        except OSError:
            pass


def broken_environment(e):
    return fail(ENVIRONMENT, f"the pack's Python environment is broken ({lib.one_line(f'{type(e).__name__}: {e}')}): run fornax types setup tts")


def read_request(params_path, text_file):
    params = json.loads(Path(params_path).read_text(encoding="utf-8"))
    request = lib.resolve(params, text_file)
    if request.text_file:
        path = Path(request.text_file)
        return request, lib.prepare(lib.decode_text(path.read_bytes()), markdown=path.suffix.lower() == ".md")
    return request, lib.prepare(request.text, markdown=False)


def main(argv=None):
    setup_streams()
    # Before synth imports the model libraries: their caches stay in env/, and they never go online.
    os.environ.update(common.library_env())
    p = argparse.ArgumentParser(prog="run.py")
    p.add_argument("--params", required=True)
    p.add_argument("--text-file", default="")
    p.add_argument("--ffmpeg", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--work", required=True)
    a = p.parse_args(argv)
    started = time.monotonic()
    try:
        request, prepared = read_request(a.params, a.text_file or None)
    except lib.Rejected as e:
        return fail(INVALID, str(e))
    except OSError as e:
        return fail(FAILED, f"the job's files cannot be read ({lib.one_line(e)})")
    except (ValueError, TypeError, AttributeError) as e:  # not JSON, not an object, a speed that is not a number
        return fail(INVALID, f"params.json does not hold valid parameters ({lib.one_line(f'{type(e).__name__}: {e}')})")
    say(f"{request.model}, voice {request.voice}, {request.format}, speed {request.speed}: {prepared.characters} characters in {len(prepared.paragraphs)} paragraphs, {prepared.chunks} chunks")

    try:
        import synth
    except ImportError as e:
        return broken_environment(e)
    try:
        engine = synth.load(request.model, request.voice)
    except ImportError as e:
        return broken_environment(e)
    except synth.Unavailable as e:
        return fail(ENVIRONMENT, str(e))
    except Exception as e:  # a model that does not load is retried (exit 1)
        return fail(FAILED, f"the {request.model} model did not load ({lib.one_line(f'{type(e).__name__}: {e}')})")
    say(f"the model is ready after {time.monotonic() - started:.1f} s")
    plan = lib.speech_plan(prepared, engine.per_paragraph)
    try:
        encoder = Encoder(a.ffmpeg, engine.sample_rate, request.format, a.out)
    except ToolError as e:
        return fail(ENVIRONMENT, str(e))
    try:
        for i, (text, pause) in enumerate(plan, 1):
            if pause:
                encoder.write(lib.silence(pause, engine.sample_rate))
            encoder.write(engine.speak(text, request.speed))
            progress(0.98 * i / len(plan), f"chunk {i}/{len(plan)}")
        duration = encoder.seconds
        meta = lib.output_meta(request, prepared, engine.sample_rate, duration, time.monotonic() - started, engine.meta())
        path = encoder.finish()
    except EncodeError as e:
        encoder.abort()
        return fail(FAILED, str(e))
    except Exception as e:  # out of memory or any other failure while speaking: retried
        encoder.abort()
        return fail(FAILED, lib.failure_text(e))
    except BaseException:
        encoder.abort()
        raise
    outputs = Path(a.out) / "outputs.json"
    try:
        outputs.write_text(json.dumps({path.name: {"meta": meta}}, ensure_ascii=False), encoding="utf-8")
    except OSError as e:
        remove_quietly(path, outputs)
        return fail(FAILED, f"outputs.json could not be written ({lib.one_line(e)})")
    progress(1.0, "done")
    say(f"{path.name}: {duration:.1f} s of speech in {meta['seconds']} s")
    return OK


if __name__ == "__main__":
    raise SystemExit(main())
