"""The image half of convert.py, where Pillow is installed in the Python running the tests (skipped otherwise: the pack's
tests need only the standard library)."""
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import convert  # noqa: E402

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


if __name__ == "__main__":
    unittest.main()
