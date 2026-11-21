"""Stand-ins for the tts pack's run.py tests: a fake synth module (a 440 Hz tone of 10 ms per character instead of
speech) and a pack folder with the real scripts; wrap_run.py runs run.py with the fake in place of synth."""
import json
import shutil
from pathlib import Path

PACK_SRC = Path(__file__).resolve().parent.parent
SECONDS_PER_CHAR = 0.01

# behavior.json next to it: mode ok | unavailable | load-error; fail_at (the n-th speak raises error).
FAKE_SYNTH = '''import array, json, math, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
B = json.load(open(os.path.join(HERE, "behavior.json"), encoding="utf-8"))


class Unavailable(Exception):
    pass


class OutOfMemoryError(RuntimeError):
    pass


class Engine:
    def __init__(self, model, voice):
        self.model, self.voice = model, voice
        self.sample_rate = 22050 if model == "piper" else 24000
        self.per_paragraph = model == "piper"
        self.calls = 0

    def speak(self, text, speed):
        self.calls += 1
        with open(os.path.join(HERE, "calls.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps({"model": self.model, "voice": self.voice, "text": text, "speed": speed}, ensure_ascii=False) + chr(10))
        if B.get("fail_at") == self.calls:
            raise OutOfMemoryError("CUDA out of memory. Tried to allocate 2.00 GiB")
        n = round(len(text) * 0.01 * self.sample_rate)
        a = array.array("f", (0.3 * math.sin(2 * math.pi * 440 * i / self.sample_rate) for i in range(n)))
        if sys.byteorder == "big":
            a.byteswap()
        return a.tobytes()

    def meta(self):
        return {"model_repo": "fake/" + self.model, "revision": "0" * 40}


def load(model, voice):
    mode = B.get("mode", "ok")
    if mode == "unavailable":
        raise Unavailable("model.safetensors is missing in env/models/omnivoice: run fornax types setup tts")
    if mode == "load-error":
        raise RuntimeError("the weights are broken")
    return Engine(model, voice)
'''

WRAPPER = '''import sys
sys.path.insert(0, {scripts!r})
sys.path.insert(0, {fakes!r})
import fake_synth
sys.modules["synth"] = fake_synth
import run
sys.exit(run.main(sys.argv[1:]))
'''


def make_pack(root, behavior=None):
    """The real scripts and voices under root/pack, the fake synth in root/fakes, root/wrap_run.py; made afresh on
    each call (a test may run several jobs)."""
    root = Path(root)
    pack = root / "pack"
    fakes = root / "fakes"
    shutil.rmtree(pack, ignore_errors=True)
    shutil.rmtree(fakes, ignore_errors=True)
    shutil.copytree(PACK_SRC / "scripts", pack / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(PACK_SRC / "voices", pack / "voices")
    fakes.mkdir()
    (fakes / "fake_synth.py").write_text(FAKE_SYNTH, encoding="utf-8")
    (fakes / "behavior.json").write_text(json.dumps(behavior or {}), encoding="utf-8")
    (root / "wrap_run.py").write_text(WRAPPER.format(scripts=str(pack / "scripts"), fakes=str(fakes)), encoding="utf-8")
    return pack


def calls(root):
    path = Path(root) / "fakes" / "calls.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []
