#!/usr/bin/env python3
"""Run one transcribe job (spec 6.5): ffmpeg, then Whisper, then (diarize) pyannote, each in its own process, one
after another, so the two models are never in the GPU's memory at once.

argv: --params <params.json> --audio <input> --ffmpeg <ffmpeg> --out <dir> --work <dir>
Writes <out>/transcript.json:
  {"model": "large-v3", "language": "sk", "duration_ms": 4200,
   "segments": [{"start_ms": 0, "end_ms": 1500, "text": "...", "speaker": "S1"}],
   "diarization": {"model": "...", "speakers": 2} or {"error": "..."}}     (diarization only when asked for)
Progress goes to stdout as JSON lines, everything else to stderr (the job's log).
Exit codes: 0 done (also: no sound track; speakers not recognized); 1 failed (retry); 2 the input cannot be read;
3 the environment is broken (ffmpeg or Whisper missing, no CUDA).
Only the standard library: this runs in {pack}/env, but must not depend on what the setup installed there.
"""
import argparse
import json
import re
import subprocess
import sys
import threading
from pathlib import Path

from common import DIARIZE_ENV, ENVIRONMENT, FAILED, INVALID, MODEL_MISSING, OK, SCRIPTS, child_env, clock, fail, progress, setup_streams, venv_python
from speakers import DIARIZE_MODEL, assign_speakers, normalize_diarization, normalize_transcript, without_words

PROGRESS_LINE = re.compile(r"^PROGRESS (\d{1,12})\s*$")
# ffmpeg's complaint about a recording without a sound track (a screen recording without the microphone).
NO_AUDIO = re.compile(r"does not contain any stream|matches no streams", re.IGNORECASE)
# Shares of the progress bar.
EXTRACTED = 0.05
TRANSCRIBED_BEFORE_SPEAKERS = 0.8
DONE = 0.99


class DiarizeError(Exception):
    pass


def parse_args(argv=None):
    p = argparse.ArgumentParser(prog="run.py")
    for name in ("--params", "--audio", "--ffmpeg", "--out", "--work"):
        p.add_argument(name, required=True)
    return p.parse_args(argv)


def call(cmd, payload, on_progress, env=None):
    """Run a child with JSON on stdin; its PROGRESS lines feed on_progress, its other stderr lines go to ours. (code, stdout)."""
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)

    def pump():
        for raw in proc.stderr:
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            m = PROGRESS_LINE.match(line)
            if m:
                on_progress(int(m.group(1)))
            elif line:
                print(line, file=sys.stderr, flush=True)

    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    try:
        proc.stdin.write(json.dumps(payload).encode("utf-8"))
        proc.stdin.close()
    except (BrokenPipeError, OSError):
        pass
    out = proc.stdout.read()
    code = proc.wait()
    reader.join()
    return code, out.decode("utf-8", "replace")


def extract_audio(ffmpeg_cmd, source, wav):
    """16 kHz mono 16-bit WAV for Whisper and pyannote; False when the recording has no sound track."""
    cmd = [*ffmpeg_cmd, "-nostdin", "-v", "error", "-i", str(source), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", str(wav)]
    try:
        r = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True)
    except FileNotFoundError:
        fail(ENVIRONMENT, "ffmpeg was not found: set tools.ffmpeg in worker.yaml")
    except OSError as e:
        fail(ENVIRONMENT, f"ffmpeg could not be started ({e.strerror}): check tools.ffmpeg in worker.yaml")
    if r.returncode == 0:
        return True
    err = r.stderr.decode("utf-8", "replace")
    if NO_AUDIO.search(err):
        return False
    print(err[-2000:], file=sys.stderr, flush=True)
    fail(INVALID, "ffmpeg could not read the input")


def wav_duration_ms(wav):
    """The length of the WAV ffmpeg wrote: 32 bytes a millisecond after the 44-byte header."""
    return max(0, round((Path(wav).stat().st_size - 44) / 32))


def scaled(start, end, done_ms, total_ms):
    return start + (end - start) * (min(done_ms / total_ms, 1.0) if total_ms else 0.0)


def transcribe(whisper_cmd, wav, params, total_ms, end):
    def on_ms(ms):
        progress(scaled(EXTRACTED, end, ms, total_ms), f"transcribing {clock(ms)} / {clock(total_ms)}")

    options = {"wav": str(wav), "model": params.get("model") or "large-v3", "language": params.get("language"), "initial_prompt": params.get("initial_prompt")}
    try:
        code, text = call(whisper_cmd, options, on_ms, env=child_env())
    except FileNotFoundError:
        fail(ENVIRONMENT, "the Python environment of this pack is missing: run its setup again (see setup.md)")
    if code == ENVIRONMENT:
        fail(ENVIRONMENT, "Whisper reported a broken environment (see the lines above)")
    if code != 0:
        fail(FAILED, f"transcription failed (exit {code})")
    try:
        return normalize_transcript(json.loads(text))
    except ValueError:
        fail(FAILED, "the transcriber printed no transcript")


def diarize(diarize_cmd, wav, speakers, total_ms):
    def on_ms(ms):
        progress(scaled(TRANSCRIBED_BEFORE_SPEAKERS, DONE, ms, total_ms), f"recognizing speakers {clock(ms)} / {clock(total_ms)}")

    try:
        code, text = call(diarize_cmd, {"wav": str(wav), "speakers": speakers}, on_ms)
    except (FileNotFoundError, PermissionError):
        raise DiarizeError("speaker recognition is not installed: run the setup again (see setup.md)")
    if code == MODEL_MISSING:
        raise DiarizeError("the speaker recognition model is not downloaded: setup.md says how to get it")
    if code != 0:
        raise DiarizeError(f"speaker recognition failed (exit {code})")
    try:
        return normalize_diarization(json.loads(text))
    except ValueError:
        raise DiarizeError("the diarizer printed no turns")


def run(args, *, ffmpeg_cmd, whisper_cmd, diarize_cmd):
    params = json.loads(Path(args.params).read_text(encoding="utf-8"))
    out, work = Path(args.out), Path(args.work)
    wav = work / "audio.wav"
    want_speakers = bool(params.get("diarize"))
    progress(0, "extracting the audio")
    has_audio = extract_audio(ffmpeg_cmd, args.audio, wav)
    total_ms = wav_duration_ms(wav) if has_audio else 0
    result = {"language": None, "duration_ms": None, "segments": []}
    if has_audio:
        progress(EXTRACTED, "transcribing")
        result = transcribe(whisper_cmd, wav, params, total_ms, TRANSCRIBED_BEFORE_SPEAKERS if want_speakers else DONE)
    segments = without_words(result["segments"])
    diarization = None
    if want_speakers:
        if not result["segments"]:
            diarization = {"model": DIARIZE_MODEL, "speakers": 0}
        else:
            progress(TRANSCRIBED_BEFORE_SPEAKERS, "recognizing speakers")
            try:
                d = diarize(diarize_cmd, wav, params.get("speakers"), total_ms)
                merged = assign_speakers(result["segments"], d["turns"])
                segments, diarization = merged["segments"], {"model": d["model"], "speakers": merged["speakers"]}
            except (DiarizeError, ValueError) as e:
                # The transcript is the expensive part: it goes out without speakers.
                print(f"transcribe: speakers not recognized: {e}", file=sys.stderr, flush=True)
                diarization = {"error": str(e)}
    transcript = {"model": params.get("model") or "large-v3", "language": result["language"], "duration_ms": result["duration_ms"], "segments": segments}
    if diarization is not None:
        transcript["diarization"] = diarization
    (out / "transcript.json").write_text(json.dumps(transcript, ensure_ascii=False), encoding="utf-8")
    progress(1, f"{len(segments)} segment(s)")
    return OK


def main():
    setup_streams()
    args = parse_args()
    sys.exit(
        run(
            args,
            ffmpeg_cmd=[args.ffmpeg],
            whisper_cmd=[sys.executable, str(SCRIPTS / "whisper.py")],
            diarize_cmd=[str(venv_python(DIARIZE_ENV)), str(SCRIPTS / "diarize.py")],
        )
    )


if __name__ == "__main__":
    main()
