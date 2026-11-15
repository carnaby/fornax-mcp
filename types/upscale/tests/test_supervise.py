import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import supervise as sv  # noqa: E402
import upscale_lib as lib  # noqa: E402

LIMIT = 15311
OOM = "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB"


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class FakeJob:
    """Ends by itself at `ends_at` (seconds on the clock) with `code`; waiting moves the clock."""

    def __init__(self, clock, ends_at, code=0):
        self.clock, self.ends_at, self.code, self.killed = clock, ends_at, code, False

    def wait(self, timeout):
        if self.killed:
            return -9
        if timeout is None:
            self.clock.now = max(self.clock.now, self.ends_at)
        else:
            self.clock.now = max(self.clock.now, min(self.clock.now + timeout, self.ends_at))
        return self.code if self.clock.now >= self.ends_at else None

    def kill(self):
        self.killed = True


def starter(clock, ends_at, code=0, lines=()):
    jobs = []

    def start(on_line):
        for line in lines:
            on_line(line)
        jobs.append(FakeJob(clock, ends_at, code))
        return jobs[-1]

    start.jobs = jobs
    return start


def readings(*values):
    it = iter(values)
    last = [values[-1]]

    def read():
        try:
            last[0] = next(it)
        except StopIteration:
            pass
        return last[0]

    return read


class SuperviseTest(unittest.TestCase):
    def test_a_job_that_ends_by_itself(self):
        clock = Clock()
        a = sv.supervise(starter(clock, 5, 0), readings(1000, 1200, 1100), LIMIT, 100, clock)
        self.assertEqual((a.code, a.stopped, a.peak_mib), (0, None, 1200))

    def test_the_vram_watchdog_kills_at_once(self):
        clock = Clock()
        start = starter(clock, 1000, 0)
        a = sv.supervise(start, readings(1000, 1000, 16000), LIMIT, 9000, clock)
        self.assertEqual(a.stopped, lib.Stopped("vram", used_mib=16000, limit_mib=LIMIT))
        self.assertTrue(start.jobs[0].killed)
        self.assertEqual(a.code, -9)
        self.assertAlmostEqual(a.seconds, 4.0)
        self.assertEqual(a.peak_mib, 16000)

    def test_three_readings_without_a_number_kill(self):
        clock = Clock()
        a = sv.supervise(starter(clock, 1000), readings(None), LIMIT, 9000, clock)
        self.assertEqual(a.stopped, lib.Stopped("blind", polls=3))

    def test_a_reading_resets_the_blind_count_and_a_reader_that_raises_is_none(self):
        clock = Clock()
        a = sv.supervise(starter(clock, 20), readings(None, None, 1000, None, None, 1000), LIMIT, 9000, clock)
        self.assertIsNone(a.stopped)

        def broken():
            raise OSError("nvidia-smi crashed")

        clock = Clock()
        self.assertEqual(sv.supervise(starter(clock, 1000), broken, LIMIT, 9000, clock).stopped, lib.Stopped("blind", polls=3))

    def test_a_reading_that_hangs_counts_as_none(self):
        clock = Clock()
        gate = threading.Event()
        t0 = time.monotonic()
        a = sv.supervise(starter(clock, 1000), lambda: gate.wait(5) and 1000, LIMIT, 9000, clock, read_timeout_s=0.05)
        gate.set()
        self.assertEqual(a.stopped, lib.Stopped("blind", polls=3))
        self.assertLess(time.monotonic() - t0, 3)

    def test_the_time_limit(self):
        clock = Clock()
        a = sv.supervise(starter(clock, 1000), readings(1000), LIMIT, 10, clock)
        self.assertEqual(a.stopped, lib.Stopped("time"))
        self.assertAlmostEqual(a.seconds, 10.0)

    def test_what_the_output_said(self):
        clock = Clock()
        a = sv.supervise(starter(clock, 3, 1, ["Phase 1: Encoding", " 45%|####  | 9/20", "Upscaling batch 1/2", OOM]), readings(1000), LIMIT, 100, clock)
        self.assertEqual((a.code, a.out_of_memory, a.early_out_of_memory), (1, True, False))
        self.assertEqual(a.tail, ["Phase 1: Encoding", "Upscaling batch 1/2", OOM])
        clock = Clock()
        a = sv.supervise(starter(clock, 3, 1, ["CUDA error: out of memory"]), readings(1000), LIMIT, 100, clock)
        self.assertEqual((a.out_of_memory, a.early_out_of_memory), (False, True))
        clock = Clock()
        a = sv.supervise(starter(clock, 1, 10, ["[capped] refused: nothing left"]), readings(1000), LIMIT, 100, clock)
        self.assertEqual(a.refused, "[capped] refused: nothing left")

    def test_lines_reach_the_caller(self):
        clock = Clock()
        seen = []
        sv.supervise(starter(clock, 1, 0, ["a", "b"]), readings(1000), LIMIT, 100, clock, on_line=seen.append)
        self.assertEqual(seen, ["a", "b"])

    def test_an_error_in_the_loop_kills_the_job_first(self):
        clock = Clock()

        class Exploding(FakeJob):
            calls = 0

            def wait(self, timeout):
                Exploding.calls += 1
                if Exploding.calls == 2:
                    raise RuntimeError("boom")
                return super().wait(timeout)

        job = Exploding(clock, 1000)
        with self.assertRaises(RuntimeError):
            sv.supervise(lambda on_line: job, readings(1000), LIMIT, 100, clock)
        self.assertTrue(job.killed)


class LadderTest(unittest.TestCase):
    def ladder(self, plan, batch=21, overlap=3, max_seconds=9000, reading=1000):
        """plan: batch -> (seconds it runs, exit code, output lines), or an exception to raise at its start."""
        clock = Clock()
        said, started = [], []

        def start_attempt(b, on_line):
            started.append(b)
            step = plan[b]
            if isinstance(step, Exception):
                raise step
            seconds, code, lines = step
            for line in lines:
                on_line(line)
            return FakeJob(clock, clock.now + seconds, code)

        r = sv.run_ladder(batch, overlap, start_attempt, readings(reading), LIMIT, max_seconds, clock, say=said.append)
        return r, said, started

    def test_ok_at_once(self):
        r, said, started = self.ladder({21: (10, 0, [])})
        self.assertEqual((r.ok, r.reason, r.batch, r.tried, said), (True, None, 21, [21], []))

    def test_an_out_of_memory_steps_down(self):
        r, said, _ = self.ladder({21: (10, 1, ["Phase 1: Encoding", OOM]), 13: (10, 0, [])})
        self.assertEqual((r.ok, r.batch, r.tried), (True, 13, [21, 13]))
        self.assertEqual(said, ["out of memory at batch 21 (PyTorch's cap held, nothing spilled): trying batch 13"])

    def test_the_end_of_the_ladder(self):
        oom = (10, 1, ["Phase 1: Encoding", OOM])
        r, _, _ = self.ladder({21: oom, 13: oom, 9: oom})
        self.assertEqual((r.ok, r.reason, r.tried), (False, "oom", [21, 13, 9]))
        r, _, _ = self.ladder({13: oom}, batch=13, overlap=9)
        self.assertEqual((r.reason, r.tried), ("oom", [13]))

    def test_no_second_attempt_for_these(self):
        cases = {
            "startup": (10, 1, ["CUDA error: out of memory"]),
            "refused": (1, 10, ["[capped] refused: nothing left"]),
            "bad-env": (1, 11, ["[capped] UPSCALE_FREE_MIB='x' is not a number"]),
            "exit": (10, 1, ["Phase 1: Encoding", "KeyError: x"]),
        }
        for reason, step in cases.items():
            with self.subTest(reason=reason):
                r, _, started = self.ladder({21: step})
                self.assertEqual((r.ok, r.reason, started), (False, reason, [21]))
        r, _, _ = self.ladder({21: (1, 10, [])})
        self.assertEqual(r.reason, "refused")

    def test_a_busy_card_at_the_start_is_refused(self):
        r, _, _ = self.ladder({21: sv.CardBusy("15400 MiB of the card is already in use")})
        self.assertEqual((r.ok, r.reason, r.last.refused), (False, "refused", "15400 MiB of the card is already in use"))

    def test_a_broken_environment_is_not_caught(self):
        with self.assertRaises(sv.Broken):
            self.ladder({21: sv.Broken("nvidia-smi did not answer")})

    def test_the_time_limit_holds_for_every_attempt_together(self):
        r, _, _ = self.ladder({21: (60, 1, ["Phase 1: Encoding", OOM]), 13: (1000, 0, [])}, max_seconds=100)
        self.assertEqual((r.reason, r.tried, r.last.stopped), ("time", [21, 13], lib.Stopped("time")))
        r, _, started = self.ladder({21: (100, 1, ["Phase 1: Encoding", OOM])}, max_seconds=100)
        self.assertEqual((r.reason, started), ("time", [21]))

    def test_the_watchdog_ends_the_ladder(self):
        r, _, started = self.ladder({21: (1000, 0, [])}, reading=16000)
        self.assertEqual((r.reason, started), ("vram", [21]))


@unittest.skipIf(sys.executable is None, "no Python executable")
class ProcessJobTest(unittest.TestCase):
    def test_lines_and_the_exit_code(self):
        lines = []
        code = "import sys; sys.stdout.write('a' + chr(13) + 'b' + chr(10) + 'c'); sys.exit(3)"
        job = sv.ProcessJob([sys.executable, "-c", code], cwd=None, env=None, on_line=lines.append)
        self.assertEqual(job.wait(30), 3)
        self.assertEqual(lines, ["a", "b", "c"])

    def test_kill_ends_the_whole_tree(self):
        with tempfile.TemporaryDirectory() as tmp:
            beat = Path(tmp, "beat.txt")
            grandchild = chr(10).join(["import time", "while True:", f"    open({str(beat)!r}, 'a').write('.')", "    time.sleep(0.1)", ""])
            child = chr(10).join(["import subprocess, sys, time", f"subprocess.Popen([sys.executable, '-c', {grandchild!r}])", "time.sleep(60)", ""])
            job = sv.ProcessJob([sys.executable, "-c", child], cwd=None, env=None, on_line=lambda line: None)
            deadline = time.monotonic() + 30
            while not (beat.exists() and beat.stat().st_size > 2):
                self.assertLess(time.monotonic(), deadline)
                time.sleep(0.1)
            self.assertIsNone(job.wait(0))
            job.kill()
            self.assertIsNotNone(job.wait(20))
            time.sleep(0.5)
            size = beat.stat().st_size
            time.sleep(1.0)
            self.assertEqual(beat.stat().st_size, size, "the grandchild still runs")


class NvidiaSmiTest(unittest.TestCase):
    def setUp(self):
        self.saved = sv.NVIDIA_SMI

    def tearDown(self):
        sv.NVIDIA_SMI = self.saved

    def fake(self, text, code=0):
        sv.NVIDIA_SMI = [sys.executable, "-c", f"import sys; sys.stdout.write({text!r}); sys.exit({code})"]

    def test_read_gpu(self):
        self.fake("Fake GPU, 16311, 1100, 15211" + chr(10))
        self.assertEqual(sv.read_gpu(), lib.Gpu("Fake GPU", 16311, 1100, 15211))

    def test_two_gpus_and_no_answer_are_broken(self):
        self.fake("A, 8192, 0, 8192" + chr(10) + "B, 8192, 0, 8192" + chr(10))
        with self.assertRaisesRegex(sv.Broken, r"lists 2 GPUs: more than one GPU is not supported yet"):
            sv.read_gpu()
        self.fake("", 9)
        with self.assertRaisesRegex(sv.Broken, r"nvidia-smi did not answer"):
            sv.read_gpu()
        sv.NVIDIA_SMI = [os.path.join(tempfile.gettempdir(), "no-such-nvidia-smi-here")]
        with self.assertRaises(sv.Broken):
            sv.read_gpu()

    def test_read_used_mib(self):
        self.fake("1100" + chr(10))
        self.assertEqual(sv.read_used_mib(), 1100)
        self.fake("[N/A]")
        self.assertIsNone(sv.read_used_mib())
        self.fake("", 9)
        self.assertIsNone(sv.read_used_mib())


if __name__ == "__main__":
    unittest.main()
