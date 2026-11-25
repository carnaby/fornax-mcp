import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import run  # noqa: E402


class WriteOutputsTest(unittest.TestCase):
    def test_any_failure_during_the_renames_leaves_no_output(self):
        real = os.replace
        done = []

        def replace(src, dst):
            if done:
                raise KeyboardInterrupt  # not an OSError: Ctrl+C, or a bug
            done.append(dst)
            real(src, dst)

        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(os, "replace", replace):
                with self.assertRaises(KeyboardInterrupt):
                    run.write_outputs(tmp, {"document.md": "A\n", "document.json": "{}"})
            self.assertEqual(sorted(os.listdir(tmp)), [])

    def test_all_outputs_are_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            run.write_outputs(tmp, {"document.md": "A\n", "document.json": "{}"})
            self.assertEqual(sorted(os.listdir(tmp)), ["document.json", "document.md"])


if __name__ == "__main__":
    unittest.main()
