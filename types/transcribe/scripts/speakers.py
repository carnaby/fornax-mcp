"""Whisper's segments and pyannote's turns, cleaned and joined (ported from Tabula's worker, same author, MIT)."""
import math
import re

DIARIZE_MODEL = "pyannote/speaker-diarization-community-1"
# A word outside every turn takes the nearest turn's speaker only this close; further away it continues the previous word's.
NEAREST_TURN_MS = 1000
_SPACE = re.compile(r"\s+")
_PRINTABLE = re.compile(r"^[\x20-\x7e]{1,200}$")


def _ms(value):
    """Whole milliseconds rounded half up (as JavaScript's Math.round), or None."""
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return math.floor(f + 0.5) if math.isfinite(f) else None


def _text(value):
    return _SPACE.sub(" ", "" if value is None else str(value)).strip()


def normalize_words(raw):
    words = []
    for w in raw if isinstance(raw, list) else []:
        if not isinstance(w, dict):
            continue
        start, end, text = _ms(w.get("start_ms")), _ms(w.get("end_ms")), _text(w.get("text"))
        if start is None or end is None or not text:
            continue
        start = max(0, start)
        words.append({"start_ms": start, "end_ms": max(start, end), "text": text})
    words.sort(key=lambda w: w["start_ms"])
    return words


def normalize_transcript(raw):
    """whisper.py's output: whole milliseconds, one-line texts, no empty ones, in time order. Words stay for assign_speakers."""
    if not isinstance(raw, dict) or not isinstance(raw.get("segments"), list):
        raise ValueError("the transcriber printed no segments")
    segments = []
    for s in raw["segments"]:
        if not isinstance(s, dict):
            continue
        start, end, text = _ms(s.get("start_ms")), _ms(s.get("end_ms")), _text(s.get("text"))
        if start is None or end is None or not text:
            continue
        start = max(0, start)
        item = {"start_ms": start, "end_ms": max(start, end), "text": text}
        if isinstance(s.get("words"), list):
            item["words"] = normalize_words(s["words"])
        segments.append(item)
    segments.sort(key=lambda s: s["start_ms"])
    language = raw.get("language")
    duration = _ms(raw.get("duration_ms"))
    return {
        "language": language if isinstance(language, str) and language else None,
        "duration_ms": duration if duration is not None and duration > 0 else None,
        "segments": segments,
    }


def normalize_diarization(raw):
    """diarize.py's output: turns with a length and a speaker; the model's name."""
    if not isinstance(raw, dict) or not isinstance(raw.get("turns"), list):
        raise ValueError("the diarizer printed no turns")
    turns = []
    for t in raw["turns"]:
        if not isinstance(t, dict):
            continue
        start, end = _ms(t.get("start_ms")), _ms(t.get("end_ms"))
        speaker = t.get("speaker") if isinstance(t.get("speaker"), str) else ""
        if start is None or end is None or not speaker:
            continue
        start = max(0, start)
        if end > start:
            turns.append({"start_ms": start, "end_ms": end, "speaker": speaker})
    model = raw.get("model")
    return {"model": model if isinstance(model, str) and _PRINTABLE.match(model) else DIARIZE_MODEL, "turns": turns}


def without_words(segments):
    out = []
    for s in segments:
        item = {"start_ms": s["start_ms"], "end_ms": s["end_ms"], "text": s["text"]}
        if s.get("speaker"):
            item["speaker"] = s["speaker"]
        out.append(item)
    return out


def assign_speakers(segments, turns):
    """
    Every word gets the speaker it overlaps most; a word in no turn the nearest turn's speaker when that is within
    NEAREST_TURN_MS, else the previous word's (the first word: the nearest turn's). A segment is split where the
    speaker changes: the parts get their words' times and texts; a segment of one speaker keeps Whisper's own text and
    times; a segment without words gets the speaker who overlaps it most. Speakers are renamed S1, S2 ... by their
    first line. Equal overlaps and distances go to the earlier turn. No turns: the segments come back without speakers.
    """
    if not turns:
        return {"segments": without_words(segments), "speakers": 0}
    ordered = sorted(turns, key=lambda t: (t["start_ms"], t["end_ms"]))
    previous = [None]

    def speaker_for(start, end):
        overlap = {}
        nearest, distance = None, math.inf
        for t in ordered:
            # Sorted by start: every later turn is at least this far away.
            if t["start_ms"] - end > distance:
                break
            o = min(end, t["end_ms"]) - max(start, t["start_ms"])
            if o > 0:
                overlap[t["speaker"]] = overlap.get(t["speaker"], 0) + o
            d = max(t["start_ms"] - end, start - t["end_ms"], 0)
            if d < distance:
                distance, nearest = d, t["speaker"]
        best, most = None, 0
        for speaker, o in overlap.items():
            if o > most:
                best, most = speaker, o
        if best is None:
            best = nearest if distance <= NEAREST_TURN_MS or previous[0] is None else previous[0]
        previous[0] = best
        return best

    out = []
    for s in segments:
        words = s.get("words") or []
        if not words:
            out.append({"start_ms": s["start_ms"], "end_ms": s["end_ms"], "text": s["text"], "speaker": speaker_for(s["start_ms"], s["end_ms"])})
            continue
        parts = []
        for w in words:
            speaker = speaker_for(w["start_ms"], w["end_ms"])
            if parts and parts[-1]["speaker"] == speaker:
                parts[-1]["words"].append(w)
            else:
                parts.append({"speaker": speaker, "words": [w]})
        if len(parts) == 1:
            out.append({"start_ms": s["start_ms"], "end_ms": s["end_ms"], "text": s["text"], "speaker": parts[0]["speaker"]})
            continue
        for p in parts:
            out.append({
                "start_ms": p["words"][0]["start_ms"],
                "end_ms": p["words"][-1]["end_ms"],
                "text": " ".join(w["text"] for w in p["words"]),
                "speaker": p["speaker"],
            })
    names = {}
    for s in out:
        if s["speaker"] not in names:
            names[s["speaker"]] = f"S{len(names) + 1}"
    if len(names) > 99:
        raise ValueError("more than 99 speakers")
    return {"segments": [{**s, "speaker": names[s["speaker"]]} for s in out], "speakers": len(names)}
