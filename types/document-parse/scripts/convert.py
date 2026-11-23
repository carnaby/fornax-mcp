"""Docling and the page images (spec 11 § 4.1–4.5): the text path, the PDF's text layer and pages, images, the layout
regions for the fill-in, and the DoclingDocument of the OCR path. The only module that imports docling, docling_core,
pypdfium2 and Pillow, and only inside functions."""
import io

import common
import parse_lib as lib

PDF_DPI = 200


def docling_dir():
    """Docling's artifacts_path (read through the module: tests and the smoke run point MODELS_DIR elsewhere)."""
    return common.MODELS_DIR / "docling"


def require_docling():
    problems = common.model_problems("docling/")
    if problems:
        raise common.Unavailable("; ".join(problems) + ": run fornax types setup document-parse")


def peak_vram_mib():
    try:
        import torch
    except ImportError:
        return 0
    return round(torch.cuda.max_memory_allocated() / 2**20) if torch.cuda.is_available() else 0


def pdf_profile(path):
    """The number of characters in the text layer of each page."""
    import pypdfium2 as pdfium

    try:
        doc = pdfium.PdfDocument(str(path))
    except pdfium.PdfiumError as e:
        if "password" in str(e).lower():
            raise lib.Rejected("the PDF is protected by a password: send it without one") from None
        raise lib.Rejected(f"the document is not a readable PDF file ({lib.one_line(e)})") from None
    try:
        counts = []
        for i in range(len(doc)):
            page = doc[i]
            text = page.get_textpage()
            counts.append(text.count_chars())
            text.close()
            page.close()
        return counts
    finally:
        doc.close()


def pdf_pages(path):
    """Each page rendered at PDF_DPI as an RGB image, one at a time."""
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(path))
    try:
        for i in range(len(doc)):
            page = doc[i]
            image = page.render(scale=PDF_DPI / 72).to_pil().convert("RGB")
            page.close()
            yield image
    finally:
        doc.close()


def _open_image(path):
    from PIL import Image, UnidentifiedImageError

    try:
        return Image.open(path)
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError) as e:
        raise lib.Rejected(f"the document is not a readable image ({lib.one_line(e)})") from None


def image_frames(path):
    """The number of pages of an image (a multi-page TIFF has several)."""
    with _open_image(path) as image:
        return getattr(image, "n_frames", 1)


def image_pages(path):
    """Each frame of an image as an RGB image, one at a time."""
    from PIL import ImageSequence

    with _open_image(path) as image:
        for frame in ImageSequence.Iterator(image):
            yield frame.convert("RGB")


class TextConverter:
    """Docling's standard pipeline (spec § 4.2): text layer, layout, TableFormer, RapidOCR on bitmaps; Office, HTML, CSV
    and Markdown through Docling's own backends. Every model comes from artifacts_path."""

    def __init__(self):
        require_docling()
        from docling.datamodel.accelerator_options import AcceleratorOptions
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions
        from docling.document_converter import DocumentConverter, PdfFormatOption

        options = PdfPipelineOptions(artifacts_path=docling_dir(), accelerator_options=AcceleratorOptions(device="cuda"),
                                     do_ocr=True, ocr_options=RapidOcrOptions(), do_table_structure=True)
        self.converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})

    def convert(self, path):
        doc = self.converter.convert(str(path)).document
        return doc.export_to_markdown(), doc.export_to_dict(), len(doc.pages), len(doc.tables)


class Layout:
    """Docling's layout model on a page image without OCR, for the fill-in (spec § 4.4)."""

    def __init__(self):
        require_docling()
        from docling.datamodel.accelerator_options import AcceleratorOptions
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.document_converter import DocumentConverter, ImageFormatOption

        options = PdfPipelineOptions(artifacts_path=docling_dir(), accelerator_options=AcceleratorOptions(device="cuda"),
                                     do_ocr=False, do_table_structure=False, generate_page_images=True,
                                     images_scale=lib.CROP_SCALE)
        options.layout_options.keep_empty_clusters = True  # otherwise regions without text cells are dropped
        self.converter = DocumentConverter(format_options={InputFormat.IMAGE: ImageFormatOption(pipeline_options=options)})

    def regions(self, image):
        """(label, crop) of the regions worth reading, in reading order; crops from the page image at CROP_SCALE."""
        from docling.datamodel.base_models import DocumentStream

        buf = io.BytesIO()
        image.save(buf, format="PNG")
        buf.seek(0)
        page = self.converter.convert(DocumentStream(name="page.png", stream=buf)).pages[0]
        big = page.get_image(scale=lib.CROP_SCALE)
        clusters = []
        for c in page.predictions.layout.clusters:
            b = c.bbox.to_top_left_origin(page_height=page.size.height)
            clusters.append((c.label.value, (b.l, b.t, b.r, b.b)))
        out = []
        for label, bbox in lib.reading_order(clusters):
            box = lib.crop_box(bbox, lib.CROP_SCALE, big.width, big.height)
            if box:
                out.append((label, big.crop(box).convert("RGB")))
        return out


def build_document(pages):
    """The DoclingDocument of the OCR path (spec § 4.5): a text item per paragraph, the added regions after them
    (headings as headings); provenance is the whole page (the full-page text has no coordinates)."""
    from docling_core.types.doc import BoundingBox, CoordOrigin, DocItemLabel, DoclingDocument, ProvenanceItem, Size

    doc = DoclingDocument(name="document")
    for no, page in enumerate(pages, 1):
        doc.add_page(page_no=no, size=Size(width=page["width"], height=page["height"]))
        whole = BoundingBox(l=0, t=0, r=page["width"], b=page["height"], coord_origin=CoordOrigin.TOPLEFT)
        for text in page["paragraphs"]:
            doc.add_text(label=DocItemLabel.TEXT, text=text, prov=ProvenanceItem(page_no=no, bbox=whole, charspan=(0, len(text))))
        for label, text in page["added"]:
            prov = ProvenanceItem(page_no=no, bbox=whole, charspan=(0, len(text)))
            if label in lib.HEADING_LABELS:
                doc.add_heading(text=text, level=1, prov=prov)
            else:
                doc.add_text(label=DocItemLabel.TEXT, text=text, prov=prov)
    return doc.export_to_dict()
