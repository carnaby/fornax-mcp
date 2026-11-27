import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from fakes import calls, make_pack

PDF = b"%PDF-1.7\n% made up\n"
DOCX = bytes([0x50, 0x4B, 0x03, 0x04]) + b"made up"


def last_line(log):
    """The worker reports a failed job by the last non-empty line of its log."""
    return [line for line in log.splitlines() if line.strip()][-1]


class RunCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.out = self.root / "out"
        self.work = self.root / "work"
        self.out.mkdir()
        self.work.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def doc(self, name, content):
        folder = self.root / "in"
        folder.mkdir(exist_ok=True)
        path = folder / name
        path.write_bytes(content)
        return path

    def run_job(self, document, params=None, behavior=None, raw_params=None):
        make_pack(self.root, behavior)
        text = raw_params if raw_params is not None else json.dumps(params or {})
        (self.work / "params.json").write_text(text, encoding="utf-8")
        argv = [sys.executable, str(self.root / "wrap_run.py"), "--params", str(self.work / "params.json"),
                "--document", str(document), "--out", str(self.out), "--work", str(self.work)]
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        r = subprocess.run(argv, env=env, capture_output=True, text=True, encoding="utf-8", timeout=120)
        return r.returncode, r.stdout, r.stderr

    def outputs(self):
        return sorted(p.name for p in self.out.iterdir())

    def meta(self):
        return json.loads((self.out / "outputs.json").read_text(encoding="utf-8"))["document.md"]["meta"]

    def markdown(self):
        return (self.out / "document.md").read_text(encoding="utf-8")

    def messages(self, out):
        return [json.loads(line)["message"] for line in out.splitlines() if line.startswith("{")]


class RejectTest(RunCase):
    """Rejections come before any model loads."""

    def test_a_file_that_is_not_its_kind_is_refused_before_any_model(self):
        code, _, err = self.run_job(self.doc("faktura.pdf", b"<!DOCTYPE html><html>Not found</html>"))
        self.assertEqual(code, 2)
        self.assertEqual(last_line(err), "document-parse: the document is not a readable PDF file")
        self.assertEqual(calls(self.root), [])
        code, _, err = self.run_job(self.doc("zmluva.docx", b"<html></html>"))
        self.assertEqual(code, 2)
        self.assertEqual(last_line(err), "document-parse: the document is not a readable DOCX file")
        self.assertEqual(self.outputs(), [])

    def test_bad_params_and_an_unsupported_type(self):
        code, _, err = self.run_job(self.doc("a.pdf", PDF), raw_params="[1]")
        self.assertEqual(code, 2)
        self.assertTrue(last_line(err).startswith("document-parse: params.json does not hold valid parameters ("), err)
        code, _, err = self.run_job(self.doc("a.pdf", PDF), params={"ocr": "never"})
        self.assertEqual((code, last_line(err)), (2, "document-parse: ocr must be auto or always, not 'never'"))
        code, _, err = self.run_job(self.doc("old.doc", b"made up"))
        self.assertEqual(code, 2)
        self.assertTrue(last_line(err).startswith("document-parse: documents of type .doc are not supported: send "), err)

    def test_an_empty_document(self):
        code, _, err = self.run_job(self.doc("a.md", b""))
        self.assertEqual((code, last_line(err)), (2, "document-parse: the document is empty"))

    def test_a_pdf_with_a_password(self):
        code, _, err = self.run_job(self.doc("a.pdf", PDF), behavior={"pdf_error": "password"})
        self.assertEqual((code, last_line(err)), (2, "document-parse: the PDF is protected by a password: send it without one"))

    def test_too_many_scanned_pages(self):
        code, _, err = self.run_job(self.doc("a.pdf", PDF), behavior={"pdf_chars": [0] * 201})
        self.assertEqual(code, 2)
        self.assertEqual(last_line(err), "document-parse: the document has 201 pages and one job reads at most 200 scanned pages: split the document into several jobs")
        self.assertNotIn("Layout", [c.get("call") for c in calls(self.root)])

    def test_an_unreadable_image(self):
        code, _, err = self.run_job(self.doc("a.png", b"made up"), behavior={"image_error": "cannot identify image file"})
        self.assertEqual((code, last_line(err)), (2, "document-parse: the document is not a readable image (cannot identify image file)"))

    def test_a_missing_document_file_is_exit_1(self):
        code, _, err = self.run_job(self.root / "in" / "gone.pdf")
        self.assertEqual(code, 1)
        self.assertTrue(last_line(err).startswith("document-parse: the job's files cannot be read ("), err)


class EnvironmentTest(RunCase):
    def test_a_missing_model_or_library_is_exit_3(self):
        code, _, err = self.run_job(self.doc("a.docx", DOCX), behavior={"mode": "unavailable"})
        self.assertEqual(code, 3)
        self.assertTrue(last_line(err).endswith(": run fornax types setup document-parse"), err)
        code, _, err = self.run_job(self.doc("a.docx", DOCX), behavior={"mode": "import-error"})
        self.assertEqual((code, last_line(err)), (3, "document-parse: the pack's Python environment is broken (ImportError: No module named 'docling'): run fornax types setup document-parse"))

    def test_a_model_that_does_not_load_is_exit_1(self):
        code, _, err = self.run_job(self.doc("a.png", b"made up"), behavior={"mode": "load-error"})
        self.assertEqual((code, last_line(err)), (1, "document-parse: converting the document failed (RuntimeError: the weights are broken)"))
        self.assertEqual(self.outputs(), [])


class TextPathTest(RunCase):
    def test_a_docx_takes_the_text_path(self):
        code, out, err = self.run_job(self.doc("zmluva.docx", DOCX))
        self.assertEqual(code, 0, err)
        self.assertEqual(self.outputs(), ["document.json", "document.md", "outputs.json"])
        self.assertTrue(self.markdown().startswith("# Zmluva"))
        meta = self.meta()
        self.assertEqual({k: meta[k] for k in ("path", "kind", "pages", "tables", "peak_vram_mib")},
                         {"path": "text", "kind": "docx", "pages": 2, "tables": 1, "peak_vram_mib": 0})
        self.assertNotIn("ocr_model_repo", meta)
        self.assertEqual(json.loads((self.out / "document.json").read_text(encoding="utf-8"))["name"], "document")
        self.assertEqual(json.loads(out.splitlines()[-1])["progress"], 1.0)
        self.assertNotIn("Layout", [c.get("call") for c in calls(self.root)])

    def test_a_text_pdf_takes_the_text_path_and_a_scan_the_ocr_path(self):
        code, _, err = self.run_job(self.doc("a.pdf", PDF), behavior={"pdf_chars": [1500, 2000]})
        self.assertEqual(code, 0, err)
        self.assertEqual(self.meta()["path"], "text")
        code, out, err = self.run_job(self.doc("a.pdf", PDF), behavior={"pdf_chars": [0, 0], "full": ["Strana jedna.", "Strana dva."]})
        self.assertEqual(code, 0, err)
        self.assertEqual((self.meta()["path"], self.meta()["pages"]), ("ocr", 2))
        self.assertEqual(self.markdown(), "<!-- page 1 -->\n\nStrana jedna.\n\n<!-- page 2 -->\n\nStrana dva.\n")
        self.assertIn("page 2/2", self.messages(out))

    def test_ocr_always_reads_a_text_pdf_as_images(self):
        code, _, err = self.run_job(self.doc("a.pdf", PDF), params={"ocr": "always"}, behavior={"pdf_chars": [1500]})
        self.assertEqual(code, 0, err)
        self.assertEqual(self.meta()["path"], "ocr")

    def test_a_failed_conversion_is_exit_1(self):
        code, _, err = self.run_job(self.doc("a.docx", DOCX), behavior={"convert_error": "Invalid code point"})
        self.assertEqual((code, last_line(err)), (1, "document-parse: converting the document failed (RuntimeError: Invalid code point)"))
        self.assertEqual(self.outputs(), [])

    def test_a_long_conversion_keeps_saying_it_runs(self):
        code, out, err = self.run_job(self.doc("a.pdf", PDF), behavior={"pdf_chars": [1500, 1500], "convert_seconds": 5, "tick_s": 2})
        self.assertEqual(code, 0, err)
        messages = self.messages(out)
        # A second of room on each side of every tick (deferred 0.14.2: the margins were half a second).
        self.assertIn("converting 2 pages, 2 s", messages)
        self.assertIn("converting 2 pages, 4 s", messages)
        self.assertEqual(messages[-1], "done")

    def test_a_failed_conversion_stops_the_ticker(self):
        code, out, err = self.run_job(self.doc("a.docx", DOCX), behavior={"convert_error": "Invalid code point", "convert_seconds": 3, "tick_s": 2})
        self.assertEqual(code, 1, err)
        messages = self.messages(out)
        self.assertIn("converting, 2 s", messages)
        self.assertNotIn("converting, 4 s", messages)
        self.assertEqual(messages[-1], "converting, 2 s")  # nothing after the failure

    def test_document_md_ends_with_one_newline(self):
        code, _, err = self.run_job(self.doc("a.docx", DOCX), behavior={"markdown": "# Zmluva\n\nText."})
        self.assertEqual(code, 0, err)
        self.assertEqual(self.markdown(), "# Zmluva\n\nText.\n")
        self.assertEqual(self.meta()["characters"], len("# Zmluva\n\nText.\n"))

    def test_a_presentation_of_pictures_only(self):
        code, _, err = self.run_job(self.doc("a.pptx", DOCX), behavior={"markdown": "<!-- image -->\n\n<!-- image -->", "tables": 0})
        self.assertEqual(code, 0, err)
        self.assertEqual(self.markdown(), "<!-- image -->\n\n<!-- image -->\n\n<!-- no text found -->\n")
        self.assertEqual(self.meta()["characters"], 0)

    def test_a_docx_with_a_password_is_refused_before_docling(self):
        ole2 = bytes([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) + b"made up"
        code, _, err = self.run_job(self.doc("a.docx", ole2))
        self.assertEqual((code, last_line(err)), (2, "document-parse: the file is protected by a password or is an old Office format: send it without a password, saved as .docx, .xlsx or .pptx"))
        self.assertEqual(self.outputs(), [])

    def test_a_document_without_text_on_the_text_path(self):
        code, _, err = self.run_job(self.doc("a.docx", DOCX), behavior={"markdown": "", "tables": 0})
        self.assertEqual(code, 0, err)
        self.assertEqual(self.markdown(), "<!-- no text found -->\n")
        self.assertEqual(self.meta()["characters"], 0)


class OcrPathTest(RunCase):
    def test_an_image_gets_the_page_and_the_missing_regions(self):
        behavior = {"full": "Новая заметка\nМастерская", "regions": [["text", "Открыть"], ["picture", "Q"], ["text", "Новая заметка"]]}
        code, out, err = self.run_job(self.doc("screen.png", b"made up"), behavior=behavior)
        self.assertEqual(code, 0, err)
        self.assertEqual(self.markdown(), "Новая заметка\nМастерская\n\n<!-- added from layout -->\n\nОткрыть\n")
        meta = self.meta()
        self.assertEqual({k: meta[k] for k in ("path", "kind", "pages", "added_regions", "peak_vram_mib", "ocr_model_repo")},
                         {"path": "ocr", "kind": "image", "pages": 1, "added_regions": 1, "peak_vram_mib": 2400,
                          "ocr_model_repo": "PaddlePaddle/PaddleOCR-VL-1.6"})
        reads = [c for c in calls(self.root) if c.get("call") == "read"]
        self.assertEqual([(c["crop"], c["max_new_tokens"], c["penalty"]) for c in reads],
                         [(False, 4096, 1.0), (True, 33, 1.05), (True, 33, 1.05), (True, 33, 1.05)])
        self.assertIn("page 1/1", self.messages(out))

    def test_an_image_without_text_is_not_an_error(self):
        code, _, err = self.run_job(self.doc("portrait.jpg", b"made up"), behavior={"full": "", "regions": []})
        self.assertEqual(code, 0, err)
        self.assertEqual(self.markdown(), "<!-- no text found -->\n")
        self.assertEqual(self.meta()["characters"], 0)

    def test_a_failure_on_a_later_page_leaves_no_output(self):
        code, out, err = self.run_job(self.doc("scan.pdf", PDF), behavior={"pdf_chars": [0] * 5, "fail_at_page": 3})
        self.assertEqual(code, 1)
        self.assertTrue(last_line(err).startswith("document-parse: the card ran out of memory (OutOfMemoryError: CUDA out of memory."), err)
        self.assertEqual(self.outputs(), [])
        self.assertIn("page 2/5", self.messages(out))
        self.assertNotIn("page 3/5", self.messages(out))

    def test_a_failed_outputs_write_leaves_no_output(self):
        code, _, err = self.run_job(self.doc("a.png", b"made up"), behavior={"block_outputs": str(self.out / "document.json")})
        self.assertEqual(code, 1)
        self.assertTrue(last_line(err).startswith("document-parse: the outputs could not be written ("), err)
        self.assertEqual([name for name in self.outputs() if name != "document.json"], [])


if __name__ == "__main__":
    unittest.main()
