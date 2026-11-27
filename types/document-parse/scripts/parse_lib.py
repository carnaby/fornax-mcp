"""Pure functions of the document-parse pack (spec 11): the request, the kind of document and the path it takes, the
limits, the fill-in from the layout, the Markdown and the outputs. No processes and no model libraries: the tests run
it with the standard library only."""
import difflib
import json
import re
import unicodedata
from collections import Counter

LIMIT_PAGES = {"text": 1000, "ocr": 200}
SCAN_CHARS_PER_PAGE = 50
EMPTY_PAGE_CHARS = 10  # fewer characters than this: a page without text (a page number, a short stamp)
KINDS = {
    ".pdf": "pdf", ".docx": "docx", ".xlsx": "xlsx", ".pptx": "pptx", ".html": "html", ".htm": "html", ".csv": "csv",
    ".md": "md", ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".tif": "image",
    ".tiff": "image", ".bmp": "image",
}
OCR_MODES = ("auto", "always")
PDF_MAGIC = b"%PDF-"
ZIP_MAGIC = bytes([0x50, 0x4B, 0x03, 0x04])
OFFICE = ("docx", "xlsx", "pptx")
OLE2_MAGIC = bytes([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])
PROTECTED_OFFICE = ("the file is protected by a password or is an old Office format: send it without a password, saved as "
                    ".docx, .xlsx or .pptx")


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


def conversion_problem(status, messages):
    """None when Docling converted every page; otherwise a sentence (Docling drops a failed page and reports
    partial_success without raising, which must not pass as a whole document)."""
    if status == "success":
        return None
    problem = f"Docling read only part of the document ({status})"
    return f"{problem}: {'; '.join(messages)}" if messages else problem


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
    if kind in OFFICE and head.startswith(OLE2_MAGIC):
        return PROTECTED_OFFICE  # Office encrypts into an OLE2 file; a renamed .doc/.xls/.ppt looks the same
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
    empty = sum(1 for n in chars_per_page if n < EMPTY_PAGE_CHARS)
    return "ocr" if average < SCAN_CHARS_PER_PAGE and empty * 2 >= pages else "text"


def page_problem(path, pages):
    """A sentence when the document has more pages than one job of this path reads."""
    limit = LIMIT_PAGES[path]
    if pages <= limit:
        return None
    scanned = "scanned " if path == "ocr" else ""
    return f"the document has {pages} pages and one job reads at most {limit} {scanned}pages: split the document into several jobs"


# --- The OCR path: fill-in from the layout (spec § 4.4) and the outputs (spec § 4.5, § 5).

FULL_PAGE_TOKENS = 4096
REGION_PENALTY = 1.05
CROP_SCALE = 2.0
CROP_PAD = 4
CROP_MIN = 8
FILL_FOUND = 0.5
# How close a garbled word must be to a page word (difflib ratio, diacritics folded) to count as found.
FUZZY_CUTOFF = 0.8
FILL_LABELS = ("text", "section_header", "title", "list_item", "caption", "page_header", "page_footer", "picture")
HEADING_LABELS = ("section_header", "title")
KEPT_LABELS = ("list_item", "caption", "page_header", "page_footer")
NO_TEXT = "<!-- no text found -->"
IMAGE_MARK = "<!-- image -->"
ADDED = "<!-- added from layout -->"
OCR_MODEL_REPO = "PaddlePaddle/PaddleOCR-VL-1.6"
OCR_REVISION = "132c45f52c0a26ed5a6b2f6bd8e3985794cc27dd"
BACKSLASH = chr(92)


def words(text):
    return re.findall(r"\w+", text.lower())


def token_limit(width, height):
    """At most about one character per 12 x 20 px of a crop at scale 2: a QR code or an icon cannot loop for long."""
    return max(16, min(1024, int(width * height / (12 * 20) / 3)))


def added_label(label):
    """The document.json label of an added region that is not a heading: its own where Docling has one for text, else
    text (the text read in a picture is text, not the picture's caption)."""
    return label if label in KEPT_LABELS else "text"


def has_latex(text):
    """Whether the text holds a LaTeX command (a backslash before a letter) or a LaTeX math opener; a backslash before
    anything else (a digit, a space, a lone backslash at the end) is text. A Windows path such as C:\\Users counts as
    LaTeX by this rule, which is what OCR of an icon needs (spec 12 ruling)."""
    i = text.find(BACKSLASH)
    while i >= 0:
        after = text[i + 1:i + 2]
        if (after.isascii() and after.isalpha()) or after in ("(", "["):
            return True
        i = text.find(BACKSLASH, i + 1)
    return False


def is_junk(text):
    """A region's text that is not worth adding: under 3 letters or digits (an icon read as "Q") or LaTeX (an arrow
    icon read as a LaTeX arrow)."""
    return sum(1 for ch in text if ch.isalnum()) < 3 or has_latex(text)


def reading_order(clusters):
    """The layout regions worth reading, top to bottom (in 8-point bands) and left to right."""
    kept = [(label, bbox) for label, bbox in clusters if label in FILL_LABELS]
    return sorted(kept, key=lambda c: (int(c[1][1] // 8), c[1][0]))


def crop_box(bbox, scale, width, height):
    """The pixel box of a region (page coordinates, top-left origin) in the page image at `scale`, padded and clipped;
    None when it is narrower or lower than CROP_MIN pixels."""
    left, top, right, bottom = bbox
    box = (max(0, round(left * scale - CROP_PAD)), max(0, round(top * scale - CROP_PAD)),
           min(width, round(right * scale + CROP_PAD)), min(height, round(bottom * scale + CROP_PAD)))
    if box[2] - box[0] < CROP_MIN or box[3] - box[1] < CROP_MIN:
        return None
    return box


CAPITAL_SHARP_S = chr(0x1E9E)  # German, in the same block as the stacked letters


def _stacked(text):
    """Whether the text has a letter of Latin Extended Additional (U+1E00-U+1EFF: Vietnamese and other letters with two
    marks), the letters of the misread the rule is for. Only these: a missed region brings other letters a page lacks by
    its nature (kΩ, μA, α, a Romanian ș, another script), so they decide nothing (final review)."""
    return any(0x1E00 <= ord(ch) <= 0x1EFF and ch != CAPITAL_SHARP_S for ch in unicodedata.normalize("NFKC", text) if ch.isalpha())


def _fold(word):
    """A word without its diacritics, as OCR of a photo often loses them."""
    return "".join(ch for ch in unicodedata.normalize("NFKD", word) if not unicodedata.combining(ch))


def fill_in(page_text, regions):
    """The regions (label, text) whose words the page's text mostly misses, each added once, junk left out. Two rules
    read the page (deferred 0.14.0, phone photos): a region with stacked Latin letters on a page whose own text has
    none is a misread (a Slovak field label came back as "IỆDPH/DRỖ"), and a word of letters that is a garbled form of a
    page word of the same length (FUZZY_CUTOFF after folding diacritics, 4 or more letters) counts as found. Numbers
    are never compared loosely: a garbled number is a different number. Accepted: an inflected repeat of page words
    ("faktúry" for "faktúra") counts as found too."""
    have = Counter(words(page_text))
    misread = any(ch.isalpha() for ch in page_text) and not _stacked(page_text)
    added = []
    for label, text in regions:
        text = text.strip()
        if is_junk(text) or (misread and _stacked(text)):
            continue
        found = words(text)
        if not found:
            continue
        exact = Counter(found) & have
        by_length = {}
        for w in have:
            if w.isalpha():
                by_length.setdefault(len(w), set()).add(_fold(w))
        near = sum(n for w, n in (Counter(found) - exact).items()
                   if len(w) >= 4 and w.isalpha() and difflib.get_close_matches(_fold(w), by_length.get(len(w), ()), n=1, cutoff=FUZZY_CUTOFF))
        if (sum(exact.values()) + near) / len(found) < FILL_FOUND:
            added.append((label, text))
            have.update(found)
    return added


def paragraphs(text):
    return [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]


def page_markdown(text, added):
    """A page of the OCR path: the model's text, then the added regions under a marker (their place is not known)."""
    parts = [text.strip()] if text.strip() else []
    if added:
        parts.append(ADDED)
        parts += [("## " + t) if label in HEADING_LABELS else t for label, t in added]
    return "\n\n".join(parts)


def join_pages(pages):
    """document.md: one page as it is, several under <!-- page N --> markers, nothing at all as NO_TEXT."""
    if not any(p.strip() for p in pages):
        return NO_TEXT + "\n"
    if len(pages) == 1:
        return pages[0].strip() + "\n"
    blocks = []
    for i, page in enumerate(pages, 1):
        blocks.append(f"<!-- page {i} -->" + ("\n\n" + page.strip() if page.strip() else ""))
    return "\n\n".join(blocks) + "\n"


def has_text(markdown):
    """Whether Markdown holds any text besides Docling's image placeholders and the no-text marker."""
    return bool(markdown.replace(IMAGE_MARK, "").replace(NO_TEXT, "").strip())


def finish_markdown(markdown):
    """document.md as written: it ends with exactly one newline; without any text it ends with NO_TEXT, after the image
    placeholders (they stay: the reader sees there were pictures)."""
    text = markdown.rstrip()
    if has_text(text) or text.endswith(NO_TEXT):
        return text + "\n"
    return (text + "\n\n" + NO_TEXT if text else NO_TEXT) + "\n"


def output_meta(path, kind, pages, tables, markdown, added, seconds, peak_vram_mib, docling):
    """The meta of document.md in outputs.json: scalars only (spec § 5)."""
    meta = {"path": path, "kind": kind, "pages": pages, "tables": tables,
            "characters": len(markdown) if has_text(markdown) else 0}
    if path == "ocr":
        meta["added_regions"] = added
    meta.update({"seconds": round(seconds, 1), "peak_vram_mib": peak_vram_mib, "docling": docling})
    if path == "ocr":
        meta.update({"ocr_model_repo": OCR_MODEL_REPO, "ocr_revision": OCR_REVISION})
    return meta


def outputs_json(meta):
    return {"document.md": {"meta": meta}, "document.json": {"meta": {"format": "DoclingDocument"}}}


def converting(pages, seconds):
    """The text path's progress message while Docling converts (spec 13 § 4): the page count when it is known."""
    if not pages:
        return f"converting, {seconds} s"
    return f"converting {pages} {'page' if pages == 1 else 'pages'}, {seconds} s"
