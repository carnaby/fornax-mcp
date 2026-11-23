import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import parse_lib as lib  # noqa: E402
from parse_lib import Rejected  # noqa: E402


class ParamsTest(unittest.TestCase):
    def test_ocr_defaults_to_auto(self):
        self.assertEqual(lib.read_params(b"{}"), "auto")
        self.assertEqual(lib.read_params(b'{"ocr": "always"}'), "always")

    def test_what_is_not_a_request_is_rejected(self):
        for data, sentence in ((b"{text", r"^params\.json does not hold valid parameters \(JSONDecodeError: "),
                               (b"[1, 2]", r"^params\.json does not hold valid parameters \(an object is expected, not list\)$"),
                               (bytes([0xFF, 0xFE, 0x7B, 0x7D]), r"^params\.json does not hold valid parameters \(UnicodeDecodeError: "),
                               (b"[" * 100_000, r"^params\.json does not hold valid parameters \(RecursionError: "),
                               (b'{"ocr": "never"}', r"^ocr must be auto or always, not 'never'$"),
                               (b'{"ocr": 1}', r"^ocr must be auto or always, not 1$")):
            with self.subTest(data=data[:20]), self.assertRaisesRegex(Rejected, sentence):
                lib.read_params(data)


class KindTest(unittest.TestCase):
    def test_every_extension_of_the_contract_has_a_kind(self):
        contract = [".pdf", ".docx", ".xlsx", ".pptx", ".html", ".htm", ".csv", ".md", ".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp"]
        self.assertEqual(sorted(lib.KINDS), sorted(contract))
        self.assertEqual(lib.kind_of("document.PDF"), "pdf")
        self.assertEqual(lib.kind_of("scan.JPEG"), "image")
        self.assertEqual(lib.kind_of("page.htm"), "html")

    def test_another_extension_is_refused(self):
        with self.assertRaisesRegex(Rejected, r"^documents of type \.doc are not supported: send \.bmp, \.csv, "):
            lib.kind_of("old.doc")
        with self.assertRaisesRegex(Rejected, r"^documents of type without an extension are not supported"):
            lib.kind_of("document")

    def test_the_content_must_fit_the_kind(self):
        zip_head = bytes([0x50, 0x4B, 0x03, 0x04]) + b"rest"
        self.assertIsNone(lib.content_problem("pdf", b"%PDF-1.7 rest"))
        self.assertIsNone(lib.content_problem("pdf", b"junk before " + b"%PDF-1.4"))  # readers allow bytes before the header
        self.assertIsNone(lib.content_problem("docx", zip_head))
        self.assertIsNone(lib.content_problem("html", b"<html>"))
        self.assertIsNone(lib.content_problem("image", b"anything: Pillow decides"))
        self.assertEqual(lib.content_problem("pdf", b"<!DOCTYPE html><html>"), "the document is not a readable PDF file")
        self.assertEqual(lib.content_problem("xlsx", b"<html>"), "the document is not a readable XLSX file")
        self.assertEqual(lib.content_problem("md", b""), "the document is empty")
        self.assertEqual(lib.content_problem("pdf", b""), "the document is empty")


class PathTest(unittest.TestCase):
    def test_images_and_forced_pdfs_take_the_ocr_path(self):
        self.assertEqual(lib.choose_path("image", "auto", None), "ocr")
        self.assertEqual(lib.choose_path("image", "always", None), "ocr")
        self.assertEqual(lib.choose_path("pdf", "always", [3000, 3000]), "ocr")

    def test_office_and_text_kinds_take_the_text_path_even_with_always(self):
        for kind in ("docx", "xlsx", "pptx", "html", "csv", "md"):
            with self.subTest(kind=kind):
                self.assertEqual(lib.choose_path(kind, "always", None), "text")

    def test_a_pdf_with_a_text_layer_takes_the_text_path(self):
        self.assertEqual(lib.choose_path("pdf", "auto", [1800, 2400, 900]), "text")

    def test_a_scan_with_a_few_characters_per_page_is_a_scan(self):
        # A scanner's page number on every second page: average under 50, at least half the pages empty.
        self.assertEqual(lib.choose_path("pdf", "auto", [0, 3, 0, 3]), "ocr")
        self.assertEqual(lib.choose_path("pdf", "auto", [0, 0, 0]), "ocr")

    def test_a_mixed_pdf_stays_on_the_text_path(self):
        # Mostly text with a scanned appendix: average over 50 -> text path (RapidOCR reads the scanned pages).
        self.assertEqual(lib.choose_path("pdf", "auto", [2000, 2000, 0, 0]), "text")
        # Few characters but every page has some (a form with labels only): fewer than half empty -> text path.
        self.assertEqual(lib.choose_path("pdf", "auto", [20, 30, 25, 40]), "text")

    def test_a_pdf_without_pages_takes_the_text_path(self):
        self.assertEqual(lib.choose_path("pdf", "auto", []), "text")

    def test_page_limits(self):
        self.assertIsNone(lib.page_problem("text", 1000))
        self.assertIsNone(lib.page_problem("ocr", 200))
        self.assertEqual(lib.page_problem("text", 1001), "the document has 1001 pages and one job reads at most 1000 pages: split the document into several jobs")
        self.assertEqual(lib.page_problem("ocr", 201), "the document has 201 pages and one job reads at most 200 scanned pages: split the document into several jobs")


class TextTest(unittest.TestCase):
    def test_one_line(self):
        self.assertEqual(lib.one_line("a\n  b\tc"), "a b c")
        self.assertEqual(len(lib.one_line("x" * 400)), 300)

    def test_failure_text(self):
        self.assertEqual(lib.failure_text(RuntimeError("boom"), "converting the document failed"), "converting the document failed (RuntimeError: boom)")
        oom = type("OutOfMemoryError", (RuntimeError,), {})("CUDA out of memory. Tried to allocate 2.00 GiB")
        self.assertTrue(lib.failure_text(oom, "x").startswith("the card ran out of memory (OutOfMemoryError: CUDA out of memory."))


if __name__ == "__main__":
    unittest.main()
