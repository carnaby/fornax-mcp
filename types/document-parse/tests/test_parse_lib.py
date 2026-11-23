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

    def test_a_page_number_on_every_page_of_a_scan_is_still_a_scan(self):
        # A page with fewer than 10 characters (a page number, a short stamp) counts as a page without text.
        self.assertEqual(lib.choose_path("pdf", "auto", [3] * 10), "ocr")
        self.assertEqual(lib.choose_path("pdf", "auto", [9, 2, 5]), "ocr")
        self.assertEqual(lib.choose_path("pdf", "auto", [10, 12, 11]), "text")

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


class FillInTest(unittest.TestCase):
    def test_words_are_lowercase_word_characters(self):
        self.assertEqual(lib.words("Daňový ÚRAD, č. 222/2004!"), ["daňový", "úrad", "č", "222", "2004"])

    def test_token_limit_follows_the_area_within_bounds(self):
        self.assertEqual(lib.token_limit(10, 10), 16)
        self.assertEqual(lib.token_limit(1200, 200), 333)  # 1200 * 200 / 240 / 3
        self.assertEqual(lib.token_limit(4000, 4000), 1024)

    def test_junk(self):
        bs = chr(92)
        for text in ("Q", "山", "", "  ", "☑" + bs + "(" + bs + "Leftrightarrow" + bs + ")☑", "12 34"):
            with self.subTest(text=text):
                self.assertTrue(lib.is_junk(text))
        for text in ("NASA", "Открыть", "kde je najblizsia pekaren ?", "K7Q2048315500ZXB"):
            with self.subTest(text=text):
                self.assertFalse(lib.is_junk(text))

    def test_reading_order_is_top_to_bottom_then_left_to_right_and_drops_tables(self):
        clusters = [("text", (300, 100, 400, 110)), ("table", (0, 50, 100, 60)), ("text", (10, 103, 50, 112)),
                    ("section_header", (10, 10, 200, 30)), ("formula", (0, 0, 5, 5)), ("picture", (0, 200, 50, 250))]
        self.assertEqual(lib.reading_order(clusters), [
            ("section_header", (10, 10, 200, 30)), ("text", (10, 103, 50, 112)), ("text", (300, 100, 400, 110)), ("picture", (0, 200, 50, 250)),
        ])

    def test_crop_box_scales_pads_clips_and_skips_slivers(self):
        self.assertEqual(lib.crop_box((10, 20, 110, 70), 2.0, 1000, 1000), (16, 36, 224, 144))
        self.assertEqual(lib.crop_box((0, 0, 600, 50), 2.0, 1000, 90), (0, 0, 1000, 90))
        # 1 px wide: 2 px at scale 2, plus 4 px of padding on each side = 10 px, kept.
        self.assertEqual(lib.crop_box((10, 10, 11, 60), 2.0, 1000, 1000), (16, 16, 26, 124))

    def test_a_crop_narrower_than_8_px_is_skipped(self):
        # 1 px wide at the right edge: clipped to the image, 4 px of padding on one side only.
        self.assertIsNone(lib.crop_box((499, 10, 500, 60), 2.0, 1000, 1000))

    def test_fill_in_adds_missing_regions_once_and_skips_junk(self):
        page = "Новая заметка\nМастерская\nЗдесь можно записать свои мысли."
        regions = [("text", "Открыть"), ("picture", "Q"), ("text", "Новая заметка"), ("text", "kde je najblizsia pekaren ?"),
                   ("text", "kde je najblizsia pekaren ?"), ("picture", "山"), ("section_header", "Вчера")]
        self.assertEqual(lib.fill_in(page, regions), [("text", "Открыть"), ("text", "kde je najblizsia pekaren ?"), ("section_header", "Вчера")])

    def test_fill_in_keeps_a_region_that_is_mostly_on_the_page(self):
        page = "Daňový úrad Nitra pobočka Levice"
        # Three of four words are on the page: found 0.75, not added.
        self.assertEqual(lib.fill_in(page, [("text", "Daňový úrad Nitra Bratislava")]), [])
        # One of three: added.
        self.assertEqual(lib.fill_in(page, [("text", "Finančná správa Levice")]), [("text", "Finančná správa Levice")])


class MarkdownTest(unittest.TestCase):
    def test_paragraphs(self):
        self.assertEqual(lib.paragraphs("a\nb\n\n  \nc\n"), ["a\nb", "c"])
        self.assertEqual(lib.paragraphs("  \n"), [])

    def test_page_markdown_puts_added_regions_after_a_marker(self):
        self.assertEqual(lib.page_markdown("Text strany.\n", []), "Text strany.")
        self.assertEqual(lib.page_markdown("Text strany.", [("text", "Открыть"), ("section_header", "Вчера")]),
                         "Text strany.\n\n<!-- added from layout -->\n\nОткрыть\n\n## Вчера")
        self.assertEqual(lib.page_markdown("", [("title", "NASA")]), "<!-- added from layout -->\n\n## NASA")
        self.assertEqual(lib.page_markdown("  ", []), "")

    def test_join_pages(self):
        self.assertEqual(lib.join_pages(["Jedna."]), "Jedna.\n")
        self.assertEqual(lib.join_pages(["Jedna.", "", "Tri."]), "<!-- page 1 -->\n\nJedna.\n\n<!-- page 2 -->\n\n<!-- page 3 -->\n\nTri.\n")
        self.assertEqual(lib.join_pages(["", " "]), "<!-- no text found -->\n")
        self.assertEqual(lib.join_pages([]), "<!-- no text found -->\n")


class OutputTest(unittest.TestCase):
    def test_meta_holds_only_scalars(self):
        meta = lib.output_meta("ocr", "image", 1, 0, "Text\n", 2, 12.345, 2400, "2.151.1")
        self.assertEqual(meta, {"path": "ocr", "kind": "image", "pages": 1, "tables": 0, "characters": 5, "added_regions": 2,
                                "seconds": 12.3, "peak_vram_mib": 2400, "docling": "2.151.1",
                                "ocr_model_repo": "PaddlePaddle/PaddleOCR-VL-1.6", "ocr_revision": "132c45f52c0a26ed5a6b2f6bd8e3985794cc27dd"})
        text = lib.output_meta("text", "docx", 0, 3, "| a |\n", None, 0.04, 0, "2.151.1")
        self.assertNotIn("ocr_model_repo", text)
        self.assertNotIn("added_regions", text)
        for value in list(meta.values()) + list(text.values()):
            self.assertIsInstance(value, (str, int, float))

    def test_no_text_counts_zero_characters(self):
        self.assertEqual(lib.output_meta("ocr", "image", 1, 0, lib.NO_TEXT + "\n", 0, 1.0, 1, "x")["characters"], 0)

    def test_outputs_json(self):
        meta = {"path": "text"}
        self.assertEqual(lib.outputs_json(meta), {"document.md": {"meta": meta}, "document.json": {"meta": {"format": "DoclingDocument"}}})


if __name__ == "__main__":
    unittest.main()
