"""probe_eevee against a fake Blender: a Python script run through make_args (spec 15 § 3.1)."""
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from render_lib import eevee_probe_args, probe_eevee  # noqa: E402


def alive(pid):
    """Whether the process runs (a zombie on Linux counts as gone)."""
    if os.name == "nt":
        r = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True)
        return str(pid) in r.stdout.split()
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as f:
            return f.read().rsplit(")", 1)[1].split()[0] != "Z"
    except OSError:
        return True


class Probe(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="fornax-probe-test-")
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.seen = []  # the out_dir every run got

    def fake(self, body):
        """A fake Blender: the script gets the probe's folder as argv[1] and this test's folder as argv[2]."""
        path = os.path.join(self.dir, "fake_blender.py")
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(textwrap.dedent(body))

        def make_args(blender, script, out_dir):
            self.seen.append(out_dir)
            return [sys.executable, path, out_dir, self.dir]
        return make_args

    def assertProbeFolderGone(self):
        self.assertEqual(len(self.seen), 1)
        self.assertFalse(os.path.exists(self.seen[0]))

    def test_the_arguments(self):
        self.assertEqual(eevee_probe_args("blender", "probe.py", "tmp"),
                         ["blender", "-b", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python", "probe.py", "--", "tmp"])

    def test_a_passing_probe_gives_the_backend(self):
        make_args = self.fake("""
            import os, sys
            open(os.path.join(sys.argv[1], "probe.png"), "wb").write(b"x")
            print("Blender 5.2.2")
            print("fornax-eevee: OPENGL")
        """)
        self.assertEqual(probe_eevee("blender", "probe.py", make_args=make_args), ("OPENGL", None))
        self.assertProbeFolderGone()

    def test_a_crash_is_a_reason_not_an_exception(self):
        make_args = self.fake("""
            import os
            print("fornax-eevee: OPENGL", flush=True)
            os.abort()
        """)
        backend, reason = probe_eevee("blender", "probe.py", make_args=make_args)
        self.assertIsNone(backend)
        self.assertRegex(reason, r"^the test render ended with exit code -?\d+$")
        self.assertNotIn("exit code 0", reason)
        self.assertProbeFolderGone()

    def test_exit_0_without_the_line_gives_no_result(self):
        make_args = self.fake("""
            print("Blender 5.2.2")
        """)
        self.assertEqual(probe_eevee("blender", "probe.py", make_args=make_args), (None, "the test render gave no result"))
        self.assertProbeFolderGone()

    def test_a_hang_is_cut_off_and_the_whole_tree_is_killed(self):
        make_args = self.fake("""
            import os, subprocess, sys, time
            child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
            open(os.path.join(sys.argv[2], "child.pid"), "w").write(str(child.pid))
            open(os.path.join(sys.argv[1], "held.txt"), "w").write("x")
            print("fornax-eevee: OPENGL", flush=True)
            time.sleep(120)
        """)
        started = time.monotonic()
        result = probe_eevee("blender", "probe.py", timeout_s=3, make_args=make_args)
        self.assertEqual(result, (None, "the test render did not finish within 3 s"))
        self.assertLess(time.monotonic() - started, 30)
        child = int(Path(self.dir, "child.pid").read_text())
        deadline = time.monotonic() + 10
        while alive(child) and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertFalse(alive(child))
        self.assertProbeFolderGone()

    def test_a_blender_that_does_not_exist(self):
        missing = os.path.join(self.dir, "no-such-blender")
        backend, reason = probe_eevee(missing, "probe.py")
        self.assertIsNone(backend)
        self.assertEqual(reason, "Blender does not run (FileNotFoundError)")
        self.assertNotIn(self.dir, reason)


if __name__ == "__main__":
    unittest.main()
