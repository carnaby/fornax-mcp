"""The tts pack's two engines (spec 10 § 4.4); the only module that imports Piper, PyTorch and OmniVoice, and only
when an engine is made. Each engine speaks one text at a time and yields it as blocks of float32 little-endian mono
PCM, so that a long text is never held whole in memory."""
from pathlib import Path

import common


class Unavailable(Exception):
    """A model file, a voice or CUDA is missing (run.py exits 3)."""


def pcm(samples):
    """A numpy float array as float32 little-endian bytes."""
    return samples.astype("<f4").tobytes()


def require_files(folder, files):
    problems = common.file_problems(folder, files)
    if problems:
        raise Unavailable("; ".join(problems) + ": run fornax types setup tts")


class PiperEngine:
    """Piper on the CPU: whole paragraphs (it cuts sentences itself and each sentence is a block), speed scales the
    voice's own length_scale."""

    per_paragraph = True

    def __init__(self):
        require_files(common.PIPER_DIR, common.PIPER_FILES)
        from piper import PiperVoice, SynthesisConfig

        self._config = SynthesisConfig
        self.voice = PiperVoice.load(str(Path(common.PIPER_DIR) / f"{common.PIPER_VOICE}.onnx"))
        self.sample_rate = self.voice.config.sample_rate
        self.length_scale = self.voice.config.length_scale

    def speak(self, text, speed):
        config = self._config(length_scale=self.length_scale / speed)
        for chunk in self.voice.synthesize(text, syn_config=config):
            yield pcm(chunk.audio_float_array)

    def meta(self):
        return {"model_repo": common.PIPER_REPO, "revision": common.PIPER_REVISION, "piper_voice": common.PIPER_VOICE}


def voice_reference(name):
    """The clip and sentence of an OmniVoice voice from voices.json."""
    problems = common.voice_problems(names=[name])
    if problems:
        raise Unavailable("; ".join(problems))
    voices = common.load_voices()
    if name not in voices:
        raise Unavailable(f"there is no voice {name} in {common.VOICES_DIR}")
    return Path(common.VOICES_DIR) / voices[name]["file"], voices[name]["text"]


class OmniVoiceEngine:
    """OmniVoice on the GPU (fp16): the voice is prepared once from its clip, every chunk is spoken after seed 42."""

    per_paragraph = False

    def __init__(self, voice):
        require_files(common.OMNIVOICE_DIR, common.OMNIVOICE_FILES)
        wav, text = voice_reference(voice)
        import torch

        if not torch.cuda.is_available():
            raise Unavailable("PyTorch sees no CUDA device: install or update the NVIDIA driver")
        from omnivoice import OmniVoice

        self.torch = torch
        self.model = OmniVoice.from_pretrained(str(common.OMNIVOICE_DIR), device_map="cuda:0", dtype=torch.float16)
        self.sample_rate = self.model.sampling_rate
        self.prompt = self.model.create_voice_clone_prompt(ref_audio=str(wav), ref_text=text)

    def speak(self, text, speed):
        self.torch.manual_seed(common.SEED)
        yield pcm(self.model.generate(text=text, language="sk", voice_clone_prompt=self.prompt, speed=speed)[0])

    def meta(self):
        return {
            "model_repo": common.OMNIVOICE_REPO,
            "revision": common.OMNIVOICE_REVISION,
            "seed": common.SEED,
            "peak_vram_mib": round(self.torch.cuda.max_memory_allocated() / 2**20),
        }


def load(model, voice):
    """The engine of `model` with `voice` (already checked against tts_lib.VOICES)."""
    if model == "piper":
        return PiperEngine()
    return OmniVoiceEngine(voice)
