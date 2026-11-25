"""The image half of convert.py, where Pillow is installed in the Python running the tests (skipped otherwise: the pack's
tests need only the standard library)."""
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import convert  # noqa: E402
import parse_lib as lib  # noqa: E402

HAS_PILLOW = importlib.util.find_spec("PIL") is not None
ORIENTATION = 0x0112


@unittest.skipUnless(HAS_PILLOW, "Pillow is not installed in this Python")
class ImagePagesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_a_phone_photo_is_turned_the_way_its_exif_says(self):
        # Phones store an upright photo as landscape pixels plus Orientation 6 (turn 90 degrees clockwise to show).
        from PIL import Image

        path = Path(self.tmp.name) / "photo.jpg"
        exif = Image.Exif()
        exif[ORIENTATION] = 6
        Image.new("RGB", (40, 20), "white").save(path, exif=exif)
        pages = list(convert.image_pages(path))
        self.assertEqual([p.size for p in pages], [(20, 40)])
        self.assertEqual(pages[0].mode, "RGB")

    def test_an_image_without_exif_keeps_its_size(self):
        from PIL import Image

        path = Path(self.tmp.name) / "scan.png"
        Image.new("L", (40, 20), 255).save(path)
        self.assertEqual([p.size for p in convert.image_pages(path)], [(40, 20)])

    def test_a_truncated_image_is_refused_when_counting_pages(self):
        # Pillow opens lazily: without reading the pixels a cut-off file would fail only after the models load.
        from PIL import Image

        path = Path(self.tmp.name) / "cut.png"
        Image.effect_noise((200, 200), 64).save(path)
        data = path.read_bytes()
        path.write_bytes(data[: len(data) // 2])
        with self.assertRaises(lib.Rejected) as cm:
            convert.image_frames(path)
        self.assertTrue(str(cm.exception).startswith("the document is not a readable image ("), str(cm.exception))

    def test_a_multi_page_tiff_still_counts_its_pages(self):
        from PIL import Image

        path = Path(self.tmp.name) / "pages.tif"
        Image.new("L", (20, 20), 255).save(path, save_all=True, append_images=[Image.new("L", (20, 20), 0)])
        self.assertEqual(convert.image_frames(path), 2)

    def test_transparent_parts_become_white_not_black(self):
        from PIL import Image

        path = Path(self.tmp.name) / "logo.png"
        image = Image.new("RGBA", (40, 20), (0, 0, 0, 0))
        image.putpixel((5, 5), (0, 0, 0, 255))
        image.save(path)
        page = list(convert.image_pages(path))[0]
        self.assertEqual(page.mode, "RGB")
        self.assertEqual(page.getpixel((0, 0)), (255, 255, 255))
        self.assertEqual(page.getpixel((5, 5)), (0, 0, 0))

    def test_a_palette_image_with_a_transparent_colour_becomes_white_there(self):
        from PIL import Image

        path = Path(self.tmp.name) / "icon.png"
        image = Image.new("P", (10, 10), 0)
        image.putpalette([0, 0, 0, 200, 0, 0] + [0] * 762)
        image.putpixel((1, 1), 1)
        image.save(path, transparency=0)
        page = list(convert.image_pages(path))[0]
        self.assertEqual(page.getpixel((0, 0)), (255, 255, 255))
        self.assertEqual(page.getpixel((1, 1)), (200, 0, 0))

    def test_an_opaque_image_is_unchanged(self):
        from PIL import Image

        self.assertEqual(convert.rgb(Image.new("L", (4, 4), 7)).getpixel((0, 0)), (7, 7, 7))


if __name__ == "__main__":
    unittest.main()
