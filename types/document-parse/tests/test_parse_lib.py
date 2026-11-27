import sys
import unicodedata
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import parse_lib as lib  # noqa: E402
from parse_lib import Rejected  # noqa: E402


class ParamsTest(unittest.TestCase):
    def test_ocr_defaults_to_auto(self):
        self.assertEqual(lib.read_params(b"{}").ocr, "auto")
        self.assertEqual(lib.read_params(b'{"ocr": "always"}').ocr, "always")

    def test_read_params_defaults_and_values(self):
        self.assertEqual(lib.read_params(b"{}"), lib.Params("auto", False, 0.85))
        self.assertEqual(lib.read_params(b'{"blocks": true, "min_confidence": 0.7}'), lib.Params("auto", True, 0.7))
        self.assertEqual(lib.read_params(b'{"min_confidence": 1}'), lib.Params("auto", False, 1))
        for bad, msg in ((b'{"blocks": "true"}', "^blocks must be true or false$"),
                         (b'{"min_confidence": 1.5}', "^min_confidence must be a number from 0 to 1$"),
                         (b'{"min_confidence": true}', "^min_confidence must be a number from 0 to 1$")):
            with self.subTest(bad=bad), self.assertRaisesRegex(Rejected, msg):
                lib.read_params(bad)

    def test_what_is_not_a_request_is_rejected(self):
        for data, sentence in ((b"{text", r"^params\.json does not hold valid parameters \(JSONDecodeError: "),
                               (b"[1, 2]", r"^params\.json does not hold valid parameters \(an object is expected, not list\)$"),
                               (bytes([0xFF, 0xFE, 0x7B, 0x7D]), r"^params\.json does not hold valid parameters \(UnicodeDecodeError: "),
                               # How deep json reads depends on the stack (Python 3.14 guards C recursion by stack size).
                               (b"[" * 100_000, r"^params\.json does not hold valid parameters \((RecursionError|JSONDecodeError): "),
                               (b'{"ocr": "never"}', r"^ocr must be auto or always, not 'never'$"),
                               (b'{"ocr": 1}', r"^ocr must be auto or always, not 1$")):
            with self.subTest(data=data[:20]), self.assertRaisesRegex(Rejected, sentence):
                lib.read_params(data)

    def test_json_nested_deeper_than_the_stack_is_rejected(self):
        deep = RecursionError("maximum recursion depth exceeded")
        with mock.patch.object(lib.json, "loads", side_effect=deep):
            with self.assertRaisesRegex(Rejected, r"^params\.json does not hold valid parameters \(RecursionError: "):
                lib.read_params(b"[[[")


class KindTest(unittest.TestCase):
    def test_every_extension_of_the_contract_has_a_kind(self):
        contract = [".pdf", ".docx", ".xlsx", ".pptx", ".html", ".htm", ".csv", ".md", ".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp"]
        self.assertEqual(sorted(lib.KINDS), sorted(contract))
        self.assertEqual(lib.kind_of("document.PDF"), "pdf")
        self.assertEqual(lib.kind_of("scan.JPEG"), "image")
        self.assertEqual(lib.kind_of("page.htm"), "html")

    def test_an_encrypted_or_old_office_file_gets_the_password_sentence(self):
        ole2 = bytes([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) + b"rest"
        sentence = "the file is protected by a password or is an old Office format: send it without a password, saved as .docx, .xlsx or .pptx"
        for kind in ("docx", "xlsx", "pptx"):
            with self.subTest(kind=kind):
                self.assertEqual(lib.content_problem(kind, ole2), sentence)
        self.assertEqual(lib.content_problem("pdf", ole2), "the document is not a readable PDF file")
        self.assertEqual(lib.content_problem("docx", b"<html>"), "the document is not a readable DOCX file")

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
    def test_converting(self):
        self.assertEqual(lib.converting(50, 40), "converting 50 pages, 40 s")
        self.assertEqual(lib.converting(1, 3), "converting 1 page, 3 s")
        self.assertEqual(lib.converting(None, 7), "converting, 7 s")
        self.assertEqual(lib.converting(0, 7), "converting, 7 s")

    def test_one_line(self):
        self.assertEqual(lib.one_line("a\n  b\tc"), "a b c")
        self.assertEqual(len(lib.one_line("x" * 400)), 300)

    def test_failure_text(self):
        self.assertEqual(lib.failure_text(RuntimeError("boom"), "converting the document failed"), "converting the document failed (RuntimeError: boom)")
        oom = type("OutOfMemoryError", (RuntimeError,), {})("CUDA out of memory. Tried to allocate 2.00 GiB")
        self.assertTrue(lib.failure_text(oom, "x").startswith("the card ran out of memory (OutOfMemoryError: CUDA out of memory."))

    def test_a_conversion_that_lost_pages_is_a_failure(self):
        # Docling drops a page that failed (e.g. TableFormer out of memory) and reports partial_success without raising.
        self.assertIsNone(lib.conversion_problem("success", []))
        problem = lib.conversion_problem("partial_success", ["Page 17: CUDA out of memory.", "Page 18: boom"])
        self.assertEqual(problem, "Docling read only part of the document (partial_success): Page 17: CUDA out of memory.; Page 18: boom")
        self.assertTrue(lib.failure_text(RuntimeError(problem), "x").startswith("the card ran out of memory"))
        self.assertEqual(lib.conversion_problem("failure", []), "Docling read only part of the document (failure)")


class FillInTest(unittest.TestCase):
    def test_words_are_lowercase_word_characters(self):
        self.assertEqual(lib.words("Daňový ÚRAD, č. 222/2004!"), ["daňový", "úrad", "č", "222", "2004"])

    def test_token_limit_follows_the_area_within_bounds(self):
        self.assertEqual(lib.token_limit(10, 10), 16)
        self.assertEqual(lib.token_limit(1200, 200), 333)  # 1200 * 200 / 240 / 3
        self.assertEqual(lib.token_limit(4000, 4000), 1024)

    def test_junk(self):
        bs = chr(92)
        junk = ("Q", "山", "", "  ", "12", "☑" + bs + "(" + bs + "Leftrightarrow" + bs + ")☑", "$" + bs + "Rightarrow$",
                "$" + bs + "checkmark$", "$" + bs + "times$", "$" + bs + "leftarrow$ next", bs + "[x" + bs + "]")
        for text in junk:
            with self.subTest(text=text):
                self.assertTrue(lib.is_junk(text))
        kept = ("NASA", "Открыть", "kde je najblizsia pekaren ?", "K7Q2048315500ZXB", "12 34", "0905 123 456", "12.03.2026",
                "14:30", "C:" + bs + " 10", "ab " + bs + " 2")
        for text in kept:
            with self.subTest(text=text):
                self.assertFalse(lib.is_junk(text))

    def test_an_added_region_keeps_its_label_unless_it_is_a_picture(self):
        for label in ("list_item", "caption", "page_header", "page_footer"):
            with self.subTest(label=label):
                self.assertEqual(lib.added_label(label), label)
        for label in ("text", "picture"):
            with self.subTest(label=label):
                self.assertEqual(lib.added_label(label), "text")

    def test_fill_in_adds_a_phone_number_the_page_misses(self):
        self.assertEqual(lib.fill_in("Kontakt", [("text", "0905 123 456")]), [("text", "0905 123 456")])

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

    def test_fill_in_skips_letters_of_a_script_the_page_never_uses(self):
        # Deferred 0.14.0 (phone photo): a field label came back as "IỆDPH/DRỖ"; Slovak text has no such letters.
        page = "Faktúra číslo 2026001\nDodávateľ: Príklad s.r.o., IČO 12345678, DIČ 2020123456"
        self.assertEqual(lib.fill_in(page, [("text", "IỆDPH/DRỖ")]), [])
        # Letters of Latin-1 and Latin Extended-A always pass (a name like Müller on a page without umlauts).
        self.assertEqual(lib.fill_in(page, [("text", "Müller Straße 5")]), [("text", "Müller Straße 5")])
        # A page whose own text uses that script keeps the region.
        self.assertEqual(lib.fill_in("Hóa đơn điện tử số 12", [("text", "Người bán hàng")]), [("text", "Người bán hàng")])
        # A page without letters of its own decides nothing.
        self.assertEqual(lib.fill_in("", [("text", "Người bán")]), [("text", "Người bán")])

    def test_fill_in_keeps_symbols_names_and_scripts_a_missed_region_may_bring(self):
        # Final review: only the stacked Latin letters of the observed misread count; a missed region brings letters
        # the page lacks by its nature (units, Greek symbols, names, another script).
        page = "Faktúra číslo 2026001\nDodávateľ: Príklad s.r.o., IČO 12345678, DIČ 2020123456"
        for text in ("Odpor R1 = 10 kΩ, prúd 5 μA", "hladina významnosti α = 0,05", "Ștefan Ionescu", "HAUPTSTRAẞE 5", "Zertiﬁkat Nummer",
                     "Адреса доставки Київ"):
            self.assertEqual(lib.fill_in(page, [("text", text)]), [("text", text)], text)
        # A page in decomposed form (NFD) still counts its own letters.
        nfd = unicodedata.normalize("NFD", "Hóa đơn điện tử số 12")
        self.assertEqual(lib.fill_in(nfd, [("text", "Người bán hàng")]), [("text", "Người bán hàng")])

    def test_fill_in_takes_a_garbled_repeat_of_page_words_as_found(self):
        # Deferred 0.14.0 (phone photo): a garbled repeat of a field label was added as new text.
        page = "Variabilný symbol 2026001 Dátum splatnosti 15.12.2026"
        self.assertEqual(lib.fill_in(page, [("text", "Varlabilny symboI")]), [])
        self.assertEqual(lib.fill_in(page, [("text", "Konštantný symbol 0308")]), [("text", "Konštantný symbol 0308")])

    def test_fill_in_never_takes_a_different_number_as_a_repeat(self):
        # Final review: a garbled number is a different number; only words of letters are compared loosely.
        page = "IČO 12345678 IBAN SK31 1200 0000 1987 4263 7541"
        self.assertEqual(lib.fill_in(page, [("text", "12345679")]), [("text", "12345679")])
        self.assertEqual(lib.fill_in(page, [("text", "7542 9910")]), [("text", "7542 9910")])


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


    def test_finish_markdown(self):
        self.assertEqual(lib.finish_markdown("# A\n\nText."), "# A\n\nText.\n")
        self.assertEqual(lib.finish_markdown(""), lib.NO_TEXT + "\n")
        self.assertEqual(lib.finish_markdown("  \n"), lib.NO_TEXT + "\n")
        self.assertEqual(lib.finish_markdown(lib.NO_TEXT + "\n"), lib.NO_TEXT + "\n")
        self.assertEqual(lib.finish_markdown("Text <!-- image -->"), "Text <!-- image -->\n")

    def test_pictures_only_say_no_text_and_keep_the_placeholders(self):
        md = lib.finish_markdown("<!-- image -->\n\n<!-- image -->\n")
        self.assertEqual(md, "<!-- image -->\n\n<!-- image -->\n\n" + lib.NO_TEXT + "\n")
        self.assertFalse(lib.has_text(md))
        self.assertEqual(lib.output_meta("text", "pptx", 2, 0, md, None, 1.0, 0, "x")["characters"], 0)


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


def one_token_per_word(text, low):
    """(token_ends, token_probs) with one token per word and one per run of whitespace; a word's probability from
    `low` (1.0 otherwise), whitespace 1.0."""
    import re

    ends, probs = [], []
    for m in re.finditer(r"\S+|\s+", text):
        ends.append(m.end())
        probs.append(1.0 if m.group().isspace() else low.get(m.group(), 1.0))
    return ends, probs


class BlocksTest(unittest.TestCase):
    """Spec 16 § 4 (G1): words, their confidence and the paragraph blocks of blocks.json."""

    def test_blocks_send_a_pdf_down_the_ocr_path_and_refuse_office(self):
        self.assertEqual(lib.choose_path("pdf", "auto", [1500, 1500], blocks=True), "ocr")
        self.assertEqual(lib.choose_path("pdf", "auto", [1500, 1500]), "text")
        self.assertEqual(lib.choose_path("image", "auto", None, blocks=True), "ocr")
        with self.assertRaisesRegex(Rejected, "^blocks needs an image or a PDF$"):
            lib.choose_path("docx", "auto", None, blocks=True)

    def test_word_confidence_is_the_lowest_overlapping_token(self):
        # "Košice, ok": tokens "Ko" "šice" "," " ok"
        self.assertEqual(lib.word_confidences("Košice, ok", [2, 6, 7, 10], [0.99, 0.6, 0.9, 0.98]), [(0, 7, 0.6), (8, 10, 0.98)])

    def test_empty_token_spans_are_ignored(self):
        self.assertEqual(lib.word_confidences("ab", [0, 2, 2], [0.1, 0.9, 0.2]), [(0, 2, 0.9)])

    def test_paragraph_blocks_mark_uncertain_words(self):
        text = "EN: Take 2 tablets daily,\nWarnings: none.\n\nDE: Dosierung: 2 Tabletten"
        words = lib.word_confidences(text, *one_token_per_word(text, {"daily,": 0.7, "Dosierung:": 0.9}))
        blocks = lib.paragraph_blocks(text, words, 0.85)
        self.assertEqual([b["text"][:3] for b in blocks], ["EN:", "DE:"])
        self.assertEqual(blocks[0], {
            "label": "paragraph", "bbox": None,
            "text": "EN: Take 2 tablets daily,\nWarnings: none.", "marked": "EN: Take 2 tablets [[daily,]]\nWarnings: none.",
            "confidence": 0.7, "uncertain": [{"word": "daily,", "confidence": 0.7}],
        })
        self.assertEqual((blocks[1]["confidence"], blocks[1]["uncertain"]), (0.9, []))

    def test_blocks_from_text_with_crlf_and_padding(self):
        text = "  Erste Zeile\r\n\r\nzweite  "
        words = lib.word_confidences(text, *one_token_per_word(text, {"zweite": 0.5}))
        self.assertEqual([(b["text"], b["marked"]) for b in lib.paragraph_blocks(text, words, 0.85)],
                         [("Erste Zeile", "Erste Zeile"), ("zweite", "[[zweite]]")])

    def test_threshold_edges(self):
        text = "a b"
        words = lib.word_confidences(text, *one_token_per_word(text, {"a": 0.99}))
        self.assertEqual(lib.paragraph_blocks(text, words, 0)[0]["uncertain"], [])
        self.assertEqual(lib.paragraph_blocks(text, words, 1)[0]["marked"], "[[a]] b")

    def test_a_block_without_words_is_certain(self):
        self.assertEqual(lib.paragraph_blocks("x", [], 0.85)[0]["confidence"], 1.0)

    def test_empty_page_has_no_blocks(self):
        doc = lib.blocks_json([{"width": 10, "height": 20, "blocks": lib.paragraph_blocks("", [], 0.85)}], 0.85)
        self.assertEqual(doc, {"min_confidence": 0.85, "marker": "[[ ]]",
                               "pages": [{"page": 1, "width": 10, "height": 20, "preprocessed": False, "blocks": []}]})

    def test_outputs_json_lists_blocks_only_when_written(self):
        self.assertNotIn("blocks.json", lib.outputs_json({"path": "ocr"}))
        meta = {"format": "fornax-blocks", "blocks": 2, "uncertain_words": 1}
        self.assertEqual(lib.outputs_json({"path": "ocr"}, meta)["blocks.json"], {"meta": meta})


if __name__ == "__main__":
    unittest.main()
