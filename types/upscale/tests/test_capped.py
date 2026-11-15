import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from fakes import write_fake_torch

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
CAPPED = SCRIPTS / "capped.py"
MIB_PER_GB = 1024

FAKE_CLI = '''import os, sys
print("cli ran with", " ".join(sys.argv[1:]), flush=True)
norm = lambda p: os.path.normcase(os.path.abspath(p or "."))
hidden = norm(os.environ["CAPPED_DIR"]) not in [norm(p) for p in sys.path]
print("scripts dir hidden" if hidden else "scripts dir visible", flush=True)
'''

# Starts a grandchild that writes a heartbeat file every 0.1 s, then waits: the tether test checks the heartbeat stops.
SLEEPING_CLI = '''import subprocess, sys, time
beat = sys.argv[sys.argv.index("--beat") + 1]
code = chr(10).join(["import time", "while True:", "    open(%r, 'a').write('.')" % beat, "    time.sleep(0.1)", ""])
subprocess.Popen([sys.executable, "-c", code])
print("cli started", flush=True)
time.sleep(60)
'''


class CappedTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        write_fake_torch(self.dir)
        (self.dir / "inference_cli.py").write_text(FAKE_CLI, encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def env(self, torch_free_gb, extra):
        clean = {k: v for k, v in os.environ.items() if not k.upper().startswith(("UPSCALE_", "PYTHON"))}
        return dict(clean, PYTHONPATH=str(self.dir), PYTHONDONTWRITEBYTECODE="1", PYTHONUTF8="1", STUB_FREE_GB=str(torch_free_gb), CAPPED_DIR=str(SCRIPTS), **extra)

    def launch(self, torch_free_gb, **extra):
        r = subprocess.run([sys.executable, str(CAPPED), "w1.mp4", "--batch_size", "21"], cwd=self.dir, env=self.env(torch_free_gb, extra), capture_output=True, text=True, encoding="utf-8", timeout=60)
        lines = [line for line in (r.stdout + r.stderr).splitlines() if line]
        fraction = next((m.group(1) for m in (re.fullmatch(r"stub fraction ([0-9.]+) device 0", line) for line in lines) if m), None)
        return r.returncode, lines, None if fraction is None else float(fraction) * 16

    def test_alone_pytorchs_figure_minus_3_gb_then_the_cli_in_the_same_process(self):
        code, lines, cap = self.launch(14.8)
        self.assertEqual(code, 0)
        self.assertAlmostEqual(cap, 11.8, places=3)
        self.assertIn("[capped] GPU memory: PyTorch sees 14.8 GB free of 16.0 GB; PyTorch capped at 11.8 GB (PyTorch's figure - 3 GB)", lines)
        self.assertIn("cli ran with w1.mp4 --batch_size 21", lines)
        self.assertIn("scripts dir hidden", lines)

    def test_nvidia_smis_smaller_figure_rules_and_the_line_says_so(self):
        code, lines, cap = self.launch(14.8, UPSCALE_FREE_MIB="13145")
        self.assertEqual(code, 0)
        self.assertAlmostEqual(cap, 13145 / MIB_PER_GB - 3, places=3)
        self.assertIn("[capped] GPU memory: PyTorch sees 14.8 GB free of 16.0 GB, nvidia-smi 12.8 GB; PyTorch capped at 9.8 GB (nvidia-smi's figure, the smaller - 3 GB)", lines)

    def test_the_figure_handed_over_never_raises_the_cap(self):
        self.assertAlmostEqual(self.launch(10, UPSCALE_FREE_MIB="15161")[2], 7, places=3)
        self.assertAlmostEqual(self.launch(10, UPSCALE_FREE_MIB="999999999")[2], 7, places=3)

    def test_the_margin_applies_to_the_smaller_figure_and_never_goes_below_2_gb(self):
        self.assertAlmostEqual(self.launch(14.8, UPSCALE_FREE_MIB="13145", UPSCALE_MARGIN_GB="4")[2], 13145 / MIB_PER_GB - 4, places=3)
        self.assertAlmostEqual(self.launch(14.8, UPSCALE_FREE_MIB="13145", UPSCALE_MARGIN_GB="0")[2], 13145 / MIB_PER_GB - 2, places=3)

    def test_refuses_with_10_when_nothing_is_left_beyond_the_margin(self):
        code, lines, cap = self.launch(14.8, UPSCALE_FREE_MIB="2800")
        self.assertEqual((code, cap), (10, None))
        self.assertEqual(lines, ["[capped] refused: PyTorch sees 14.8 GB free of 16.0 GB, nvidia-smi 2.7 GB - not more than the 3 GB margin (nvidia-smi's figure, the smaller) - free the card first"])
        self.assertEqual(self.launch(2.5)[0], 10)

    def test_a_setting_that_is_not_a_number_ends_with_11(self):
        for junk in ("abc", "-5", "nan", "inf", "12 GB", "0x3000"):
            code, lines, cap = self.launch(14.8, UPSCALE_FREE_MIB=junk)
            self.assertEqual((code, cap), (11, None), junk)
            self.assertEqual(lines, [f"[capped] UPSCALE_FREE_MIB={junk!r} is not a number of 0 or more - run.py sets it; nothing started"], junk)
        self.assertEqual(self.launch(14.8, UPSCALE_MARGIN_GB="x")[0], 11)
        # an empty variable is no variable
        self.assertEqual(self.launch(14.8, UPSCALE_FREE_MIB="  ")[0], 0)

    def test_the_tether_ends_the_job_and_what_it_started_when_the_watcher_is_gone(self):
        (self.dir / "inference_cli.py").write_text(SLEEPING_CLI, encoding="utf-8")
        beat = self.dir / "beat.txt"
        kwargs = {"start_new_session": True} if os.name != "nt" else {}
        p = subprocess.Popen([sys.executable, str(CAPPED), "--beat", str(beat)], cwd=self.dir, env=self.env(14.8, {"UPSCALE_TETHER": "1"}), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **kwargs)
        try:
            deadline = time.monotonic() + 30
            while not (beat.exists() and beat.stat().st_size > 2):
                self.assertLess(time.monotonic(), deadline, "the grandchild never started")
                time.sleep(0.1)
            p.stdin.close()  # the watcher is gone
            self.assertNotEqual(p.wait(timeout=20), 0)
            time.sleep(0.5)
            size = beat.stat().st_size
            time.sleep(1.0)
            self.assertEqual(beat.stat().st_size, size, "the grandchild still runs")
        finally:
            if p.poll() is None:
                p.kill()
            p.stdout.close()


if __name__ == "__main__":
    unittest.main()
