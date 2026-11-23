#!/usr/bin/env python3
"""The document-parse pack's job (spec 11 § 4). argv: --params <params.json> --document <path> --out <dir> --work <dir>.
Exit 0 done (also when no text was found), 1 failed (retried), 2 the document cannot be read as asked, 3 the environment
is broken (a model, a library or CUDA is missing)."""
import argparse
import importlib.metadata
import json
import os
import time
from pathlib import Path

import common
import parse_lib as lib
from common import ENVIRONMENT, FAILED, INVALID, OK, progress, say, setup_streams


def fail(code, message):
    say(message)
    return code


def broken_environment(e):
    return fail(ENVIRONMENT, f"the pack's Python environment is broken ({lib.one_line(f'{type(e).__name__}: {e}')}): run fornax types setup document-parse")


def docling_version():
    try:
        return importlib.metadata.version("docling")
    except importlib.metadata.PackageNotFoundError:
        return "?"


def read_request(params_path, document):
    """The ocr mode and the kind of the document, checked before anything heavy is imported."""
    ocr = lib.read_params(Path(params_path).read_bytes())
    kind = lib.kind_of(Path(document).name)
    with open(document, "rb") as f:
        problem = lib.content_problem(kind, f.read(1024))
    if problem:
        raise lib.Rejected(problem)
    return ocr, kind


def choose(convert, document, kind, ocr):
    """The path and the number of pages (None when only Docling can tell, e.g. a DOCX); spec § 4.1."""
    chars = convert.pdf_profile(document) if kind == "pdf" else None
    path = lib.choose_path(kind, ocr, chars)
    if chars is not None:
        pages = len(chars)
    elif kind == "image":
        pages = convert.image_frames(document)
    else:
        pages = None
    if pages is not None:
        problem = lib.page_problem(path, pages)
        if problem:
            raise lib.Rejected(problem)
    return path, pages


def text_path(convert, document):
    converter = convert.TextConverter()
    progress(0.05, "converting")
    markdown, document_dict, pages, tables = converter.convert(document)
    return markdown, document_dict, pages, tables, None, convert.peak_vram_mib()


def ocr_path(convert, document, kind, pages):
    """Each page: the full page, then the layout's regions the full page missed (spec § 4.3, § 4.4)."""
    import ocr

    engine = ocr.PaddleOcr()
    layout = convert.Layout()
    say("the models are ready")
    images = convert.pdf_pages(document) if kind == "pdf" else convert.image_pages(document)
    texts, doc_pages, added_total = [], [], 0
    for i, image in enumerate(images, 1):
        full = engine.read(image, lib.FULL_PAGE_TOKENS)
        regions = [(label, engine.read(crop, lib.token_limit(crop.width, crop.height), lib.REGION_PENALTY))
                   for label, crop in layout.regions(image)]
        added = lib.fill_in(full, regions)
        added_total += len(added)
        texts.append(lib.page_markdown(full, added))
        doc_pages.append({"width": image.width, "height": image.height, "paragraphs": lib.paragraphs(full), "added": added})
        progress(0.98 * i / pages, f"page {i}/{pages}")
    return lib.join_pages(texts), convert.build_document(doc_pages), len(texts), 0, added_total, engine.peak_vram_mib()


def write_outputs(out, files):
    """Each output as <name>.part, renamed only once all are written; after a failure none of them is left."""
    out = Path(out)
    parts = [(out / f"{name}.part", out / name, text) for name, text in files.items()]
    try:
        for part, _dest, text in parts:
            part.write_text(text, encoding="utf-8", newline="\n")
        for part, dest, _text in parts:
            os.replace(part, dest)
    except OSError:
        for part, dest, _text in parts:
            for path in (part, dest):
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass  # a folder in the way, or a file another process holds: left as it is
        raise


def main(argv=None):
    setup_streams()
    # Before Docling, torch and transformers are imported: their caches stay in env/, and they never go online.
    os.environ.update(common.library_env())
    p = argparse.ArgumentParser(prog="run.py")
    p.add_argument("--params", required=True)
    p.add_argument("--document", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--work", required=True)
    a = p.parse_args(argv)
    started = time.monotonic()
    try:
        ocr, kind = read_request(a.params, a.document)
    except lib.Rejected as e:
        return fail(INVALID, str(e))
    except OSError as e:
        return fail(FAILED, f"the job's files cannot be read ({lib.one_line(e)})")
    try:
        import convert
    except ImportError as e:
        return broken_environment(e)
    try:
        path, pages = choose(convert, a.document, kind, ocr)
    except lib.Rejected as e:
        return fail(INVALID, str(e))
    except ImportError as e:
        return broken_environment(e)
    except Exception as e:  # a library that fails on a document it should read: retried
        return fail(FAILED, lib.failure_text(e, "the document could not be inspected"))
    say(f"{kind}" + (f", {pages} pages" if pages is not None else "") + f": the {path} path")
    try:
        if path == "text":
            markdown, document, pages, tables, added, vram = text_path(convert, a.document)
        else:
            markdown, document, pages, tables, added, vram = ocr_path(convert, a.document, kind, pages)
    except lib.Rejected as e:
        return fail(INVALID, str(e))
    except common.Unavailable as e:
        return fail(ENVIRONMENT, str(e))
    except ImportError as e:
        return broken_environment(e)
    except Exception as e:  # out of memory, a model or Docling failing: retried
        return fail(FAILED, lib.failure_text(e, "converting the document failed"))
    # Docling's Markdown ends without a newline: every document.md ends with exactly one.
    markdown = (markdown.rstrip() if markdown.strip() else lib.NO_TEXT) + "\n"
    meta = lib.output_meta(path, kind, pages, tables, markdown, added, time.monotonic() - started, vram, docling_version())
    try:
        write_outputs(a.out, {
            "document.md": markdown,
            "document.json": json.dumps(document, ensure_ascii=False),
            "outputs.json": json.dumps(lib.outputs_json(meta), ensure_ascii=False),
        })
    except OSError as e:
        return fail(FAILED, f"the outputs could not be written ({lib.one_line(e)})")
    progress(1.0, "done")
    say(f"document.md: {meta['characters']} characters from {pages} pages in {meta['seconds']} s")
    return OK


if __name__ == "__main__":
    raise SystemExit(main())
