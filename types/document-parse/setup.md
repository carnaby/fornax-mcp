# document-parse

Turns a document into Markdown (`document.md`) and Docling's JSON (`document.json`). Two paths, chosen per job:

- **text path** (Docling's standard pipeline): PDFs with a text layer, DOCX, XLSX, PPTX, HTML, CSV and Markdown. The
  text comes from the file itself; tables become Markdown tables; images inside a PDF (for example labels stored as a
  picture) are read by RapidOCR.
- **OCR path** (PaddleOCR-VL 1.6 on the GPU): images and PDFs without a text layer. Each page is read whole, then the
  regions Docling's layout model finds and the page missed (buttons, labels in graphics) are read one by one and added
  at the end of the page under `<!-- added from layout -->`.

A job never goes online.

## What you need

- An NVIDIA card with about 3 GB of free memory and a driver for CUDA 12.8 (without CUDA the type is not offered).
- `tools.python` in `worker.yaml`: Python 3.10 or newer, used only to run the setup.
- About 10 GB of disk for the pack.

## Install

    fornax types install document-parse

The setup puts everything into the pack's `env/` folder: uv, CPython 3.12.16, the locked Python environment (PyTorch
with CUDA 12.8, Docling, transformers) and the model files (PaddleOCR-VL 1.6, Docling's layout and table models,
RapidOCR), each checked by size and sha256. Deleting the pack deletes all of it. Run it again after a failure: finished
parts are kept.

## Check

    fornax doctor document-parse

## Parameters

| Name | Values | Default | Meaning |
| --- | --- | --- | --- |
| `ocr` | `auto`, `always` | `auto` | `auto` reads a PDF's text layer and uses OCR only for a scan; `always` reads every PDF page as an image (for a PDF whose text layer is garbled). Images always go through OCR; Office files never do. |
| `blocks` | `true`, `false` | `false` | Also `blocks.json` (below), for a human check of what OCR read. A PDF then goes through OCR; an Office, HTML, CSV or Markdown file is refused (exit 2). |
| `min_confidence` | 0 to 1 | 0.85 | With `blocks`, a word below this confidence is marked uncertain. |

A PDF counts as a scan when it has fewer than 50 characters per page on average and at least half of its pages have
fewer than 10 (a page number or a short stamp counts as no text). A PDF with only some scanned pages takes the text
path, where RapidOCR reads those pages; send `ocr: always` to read the whole PDF with PaddleOCR-VL instead (also for a
scan whose every page carries a longer stamp, such as the name of the scanning app).

Limits: 200 MB per file, 1000 pages on the text path, 200 pages on the OCR path (split larger documents), 3 hours
per job (a dense scanned page takes about 20 s).

## Output

- `document.md`: the Markdown. Several pages of the OCR path are separated by `<!-- page N -->`. A document without
  any text (a photo, a portrait) gives `<!-- no text found -->` and the job still succeeds: describing a picture needs
  another tool.
- `document.json`: the DoclingDocument (`export_to_dict`). On the OCR path each paragraph is a text item whose
  provenance is its whole page.
- `meta` of `document.md`: `path` (`text` or `ocr`), `kind`, `pages`, `tables`, `characters`, `added_regions` (OCR
  path), `seconds`, `peak_vram_mib`, `docling` (version), and on the OCR path `ocr_model_repo` and `ocr_revision`.
- `blocks.json` (with `blocks`): `{"min_confidence", "marker": "[[ ]]", "pages": [{"page", "width", "height",
  "preprocessed", "blocks": [...]}]}`. Each block is a paragraph of the page as PaddleOCR-VL read it (a label usually
  gives one per language): `label` `paragraph`, `bbox` `null`, `text`, `marked` (the text with every uncertain word in
  `[[ ]]`), `confidence` (its least sure word) and `uncertain` (`word` and `confidence`). A word's confidence is the
  lowest probability of the model's tokens in it; on phone photos of labels about 5 % of correct words fall under 0.85
  too (names, rare words, the label's own typos), so it marks what to check, not what is wrong. The language of a block
  is not detected. Its `meta`: `format` `fornax-blocks`, `blocks`, `uncertain_words`.

## What it does not do

- Describe pictures without text, fill a JSON schema, extract the images of a document, write formulas as LaTeX.
- Tables on scans stay text (lines), not Markdown tables.
- Handwriting is read as far as the model manages, without a promise.

## Licences

Docling MIT; Docling's layout and table models Apache 2.0 / CDLA-Permissive-2.0; PaddleOCR-VL 1.6 Apache 2.0; RapidOCR
and its PP-OCR models Apache 2.0.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | done (also when no text was found) |
| 1 | failed, tried again: out of GPU memory, Docling or the model failed on a valid file |
| 2 | the document cannot be read as asked: bad parameters, not a file of its kind, empty, a PDF with a password, too many pages |
| 3 | the pack is not ready: a model file or library is missing, or CUDA is not there (run `fornax types setup document-parse`) |
