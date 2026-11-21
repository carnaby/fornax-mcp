"""Pure functions of the tts pack (spec 10): the request a job makes, the text it speaks and in which pieces, the
pauses, ffmpeg's arguments and the output's meta. No processes and no model libraries: the tests run it with the
standard library only."""
import re
import unicodedata
from dataclasses import dataclass

LIMIT_CHARS = 50_000
CHUNK_CHARS = 400
PAUSE_CHUNK_S = 0.3
PAUSE_PARAGRAPH_S = 0.7
# The voices of each model; the first is the model's default. type.yaml's voice enum is lili followed by the
# OmniVoice voices of voices.json (tests/test_voices.py keeps them equal).
VOICES = {"piper": ("lili",), "omnivoice": ("klara", "peter")}
# The output file and ffmpeg's output arguments of each format.
FORMATS = {
    "mp3": ("speech.mp3", ("-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3")),
    "opus": ("speech.opus", ("-c:a", "libopus", "-b:a", "48k", "-f", "ogg")),
    "wav": ("speech.wav", ("-c:a", "pcm_s16le", "-f", "wav")),
}
UTF8_BOM = bytes([0xEF, 0xBB, 0xBF])
UTF16_BOMS = (bytes([0xFF, 0xFE]), bytes([0xFE, 0xFF]))


class Rejected(Exception):
    """The job cannot be spoken as asked (exit 2); the message says why in one sentence."""


@dataclass(frozen=True)
class Request:
    model: str
    voice: str
    format: str
    speed: float
    text: str | None
    text_file: str | None


@dataclass(frozen=True)
class Prepared:
    paragraphs: list  # each paragraph is a list of chunks (str)
    characters: int

    @property
    def chunks(self):
        return sum(len(p) for p in self.paragraphs)


def resolve(params, text_file):
    """The checked request. `params` is params.json (defaults filled in by the worker, but not relied on);
    `text_file` is the input's path, or None or "" when it was not given."""
    text = params.get("text")
    if text == "":
        text = None
    text_file = text_file or None
    if text is not None and text_file:
        raise Rejected("give the text parameter or a text_file, not both")
    if text is None and not text_file:
        raise Rejected("give the text to speak: the text parameter (one line) or a text_file (.txt or .md); neither was given")
    model = params.get("model", "piper")
    if model not in VOICES:
        raise Rejected(f"unknown model {model}: use {' or '.join(VOICES)}")
    voices = VOICES[model]
    voice = params.get("voice") or voices[0]
    if voice not in voices:
        raise Rejected(f"{model} has no voice {voice}; its voices: {', '.join(voices)}")
    fmt = params.get("format", "mp3")
    if fmt not in FORMATS:
        raise Rejected(f"unknown format {fmt}: use {', '.join(FORMATS)}")
    speed = float(params.get("speed", 1))
    if not 0.5 <= speed <= 2:
        raise Rejected(f"speed {speed} is outside 0.5 to 2")
    return Request(model, voice, fmt, speed, text, text_file)


def decode_text(data):
    """A text file's bytes as text: UTF-8, with or without a BOM."""
    if data.startswith(UTF8_BOM):
        data = data[len(UTF8_BOM):]
    elif data.startswith(UTF16_BOMS):
        raise Rejected("the text file is UTF-16; save it as UTF-8")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise Rejected("the text file is not UTF-8; save it as UTF-8") from None


def normalize(text):
    """NFC (a letter and its combining mark become one) and one kind of line end."""
    return unicodedata.normalize("NFC", text).replace("\r\n", "\n").replace("\r", "\n")


FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
RULE = re.compile(r"^ {0,3}([-*_])( *\1){2,} *$")
TABLE_SEPARATOR = re.compile(r"^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$")
HEADING = re.compile(r"^ {0,3}#{1,6}(\s+|$)")
CLOSING_HASHES = re.compile(r"\s+#+\s*$")
QUOTE = re.compile(r"^\s*(>\s?)+")
LIST_MARK = re.compile(r"^\s*([-*+]|\d{1,9}[.)])\s+")
IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
STRONG = re.compile(r"\*\*|__")
EMPHASIS = re.compile(r"(?<!\w)[*_](?=\S)|(?<=\S)[*_](?!\w)")


def strip_markdown(text):
    """The text of a Markdown document as it is read aloud (spec 10 § 4.2): code blocks, rules and table separators
    go; headings, list items and table rows become paragraphs of their own (plan ruling); inline marks go, link
    texts stay."""
    lines, fence = [], None
    for line in text.split("\n"):
        m = FENCE.match(line)
        if fence is not None:
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence):
                fence = None
            continue
        if m:
            fence = m.group(1)
            continue
        if RULE.match(line) or ("-" in line and TABLE_SEPARATOR.match(line)):
            lines.append("")
            continue
        own = False
        stripped = line.strip()
        if stripped.startswith("|"):
            line = ", ".join(c.strip() for c in stripped.strip("|").split("|") if c.strip())
            own = True
        if HEADING.match(line):
            line = CLOSING_HASHES.sub("", HEADING.sub("", line))
            own = True
        line = QUOTE.sub("", line)
        if LIST_MARK.match(line):
            line = LIST_MARK.sub("", line)
            own = True
        line = EMPHASIS.sub("", STRONG.sub("", LINK.sub(r"\1", IMAGE.sub("", line)))).replace("`", "")
        lines.extend(["", line, ""] if own else [line])
    return "\n".join(lines)


BLANK = re.compile(r"\n\s*\n")
SPACES = re.compile(r"\s+")


def paragraphs(text):
    """Blocks between blank lines, each on one line with single spaces; empty ones dropped."""
    out = []
    for block in BLANK.split(text):
        p = SPACES.sub(" ", block).strip()
        if p:
            out.append(p)
    return out


SENTENCE_END = re.compile(r"([.!?…]+[\"'“”’»)\]]*)\s+")


def sentences(paragraph):
    """The paragraph cut after . ! ? … (with a closing quote or bracket) that a space follows. An abbreviation such
    as "napr." may cut too early; that only moves a chunk boundary."""
    parts = SENTENCE_END.split(paragraph)
    out = [parts[i] + parts[i + 1] for i in range(0, len(parts) - 1, 2)]
    if parts[-1]:
        out.append(parts[-1])
    return [s.strip() for s in out if s.strip()]


def split_long(sentence, limit=CHUNK_CHARS):
    """A sentence longer than `limit` cut after its last comma, semicolon or colon that fits, else at its last space,
    else hard at `limit`."""
    pieces = []
    while len(sentence) > limit:
        window = sentence[: limit + 1]
        cut = max(window.rfind(", "), window.rfind("; "), window.rfind(": "))
        if cut > 0:
            cut += 1
        else:
            cut = window.rfind(" ")
            if cut <= 0:
                cut = limit
        pieces.append(sentence[:cut].strip())
        sentence = sentence[cut:].strip()
    if sentence:
        pieces.append(sentence)
    return pieces


def chunks(paragraph, limit=CHUNK_CHARS):
    """Sentences joined into chunks of at most `limit` characters; never across paragraphs (spec 10 § 4.3)."""
    out, current = [], ""
    for sentence in sentences(paragraph):
        for piece in split_long(sentence, limit):
            if current and len(current) + 1 + len(piece) > limit:
                out.append(current)
                current = piece
            else:
                current = f"{current} {piece}" if current else piece
    if current:
        out.append(current)
    return out


def prepare(raw, markdown):
    """The text to speak, in paragraphs of chunks; Rejected when nothing is left or it is over the limit."""
    text = normalize(raw)
    if markdown:
        text = strip_markdown(text)
    paras = paragraphs(text)
    characters = sum(len(p) for p in paras)
    if characters == 0:
        raise Rejected("there is nothing to speak: the text is empty" + (" without its Markdown marks" if markdown else ""))
    if characters > LIMIT_CHARS:
        raise Rejected(f"the text has {characters} characters and one job speaks at most {LIMIT_CHARS}: split the text into several jobs")
    return Prepared([chunks(p) for p in paras], characters)
