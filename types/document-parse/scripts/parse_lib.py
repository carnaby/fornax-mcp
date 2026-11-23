"""Pure functions of the document-parse pack (spec 11): the request, the kind of document and the path it takes, the
limits, the fill-in from the layout, the Markdown and the outputs. No processes and no model libraries: the tests run
it with the standard library only."""
import json
import re
from collections import Counter

LIMIT_PAGES = {"text": 1000, "ocr": 200}
SCAN_CHARS_PER_PAGE = 50
KINDS = {
    ".pdf": "pdf", ".docx": "docx", ".xlsx": "xlsx", ".pptx": "pptx", ".html": "html", ".htm": "html", ".csv": "csv",
    ".md": "md", ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".tif": "image",
    ".tiff": "image", ".bmp": "image",
}
OCR_MODES = ("auto", "always")
PDF_MAGIC = b"%PDF-"
ZIP_MAGIC = bytes([0x50, 0x4B, 0x03, 0x04])
OFFICE = ("docx", "xlsx", "pptx")


class Rejected(Exception):
    """The document cannot be read as asked (exit 2); the message says why in one sentence."""


def one_line(text, limit=300):
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def failure_text(error, failed):
    """The log's last line when a model or Docling failed (exit 1); out of memory gets its own sentence."""
    what = one_line(f"{type(error).__name__}: {error}")
    if "OutOfMemoryError" in type(error).__name__ or "out of memory" in str(error).lower():
        return f"the card ran out of memory ({what}): another program may hold it; the job is tried again later"
    return f"{failed} ({what})"


def read_params(data):
    """The checked `ocr` value of params.json (the worker fills in the default, but it is not relied on)."""
    try:
        params = json.loads(data.decode("utf-8"))
    except (ValueError, RecursionError) as e:  # not UTF-8, not JSON, or nested deeper than json reads
        raise Rejected(f"params.json does not hold valid parameters ({one_line(f'{type(e).__name__}: {e}')})") from None
    if not isinstance(params, dict):
        raise Rejected(f"params.json does not hold valid parameters (an object is expected, not {type(params).__name__})")
    ocr = params.get("ocr", "auto")
    if not isinstance(ocr, str) or ocr not in OCR_MODES:
        raise Rejected(f"ocr must be auto or always, not {ocr!r}")
    return ocr


def kind_of(name):
    """The kind of a document by its file name's extension."""
    suffix = "." + name.rsplit(".", 1)[1].lower() if "." in name else ""
    if suffix not in KINDS:
        what = suffix or "without an extension"
        raise Rejected(f"documents of type {what} are not supported: send {', '.join(sorted(KINDS))}")
    return KINDS[suffix]


def content_problem(kind, head):
    """A sentence when the first bytes (up to 1 KiB) do not fit the kind; None when they do or only a library can tell
    (images are opened by Pillow, HTML, CSV and Markdown are text)."""
    if not head:
        return "the document is empty"
    if kind == "pdf" and PDF_MAGIC not in head[:1024]:
        return "the document is not a readable PDF file"
    if kind in OFFICE and not head.startswith(ZIP_MAGIC):
        return f"the document is not a readable {kind.upper()} file"
    return None


def choose_path(kind, ocr, chars_per_page):
    """`ocr` (PaddleOCR-VL page by page) or `text` (Docling's standard pipeline); spec § 4.1."""
    if kind == "image":
        return "ocr"
    if kind != "pdf":
        return "text"
    if ocr == "always":
        return "ocr"
    pages = len(chars_per_page or [])
    if not pages:
        return "text"
    average = sum(chars_per_page) / pages
    empty = sum(1 for n in chars_per_page if n == 0)
    return "ocr" if average < SCAN_CHARS_PER_PAGE and empty * 2 >= pages else "text"


def page_problem(path, pages):
    """A sentence when the document has more pages than one job of this path reads."""
    limit = LIMIT_PAGES[path]
    if pages <= limit:
        return None
    scanned = "scanned " if path == "ocr" else ""
    return f"the document has {pages} pages and one job reads at most {limit} {scanned}pages: split the document into several jobs"
