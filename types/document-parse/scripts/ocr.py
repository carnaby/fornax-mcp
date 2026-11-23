"""PaddleOCR-VL 1.6 through transformers (spec 11 § 4.3, § 4.4); the only module that imports torch and transformers,
and only when an engine is made."""
import common

PROMPT = "OCR:"


def generate_kwargs(max_new_tokens, penalty=1.0):
    """Greedy decoding with the cache on. use_cache=True is required: the model's config turns the cache off, and
    without it a page takes 56 s instead of 8.5 s with the same output (spec § 9)."""
    kwargs = {"max_new_tokens": max_new_tokens, "do_sample": False, "use_cache": True}
    if penalty != 1.0:
        kwargs["repetition_penalty"] = penalty
    return kwargs


class PaddleOcr:
    """The model in bfloat16 on the card, loaded once per job from env/models/paddleocr-vl (no network)."""

    def __init__(self):
        problems = common.model_problems("paddleocr-vl/")
        if problems:
            raise common.Unavailable("; ".join(problems) + ": run fornax types setup document-parse")
        import torch

        if not torch.cuda.is_available():
            raise common.Unavailable("PyTorch sees no CUDA device: install or update the NVIDIA driver")
        from transformers import AutoProcessor, PaddleOCRVLForConditionalGeneration

        folder = str(common.MODELS_DIR / "paddleocr-vl")
        self.torch = torch
        self.model = PaddleOCRVLForConditionalGeneration.from_pretrained(folder, dtype=torch.bfloat16).to("cuda").eval()
        self.processor = AutoProcessor.from_pretrained(folder)

    def read(self, image, max_new_tokens, penalty=1.0):
        """The text of a page or a crop (a PIL image), stripped."""
        messages = [{"role": "user", "content": [{"type": "image", "image": image}, {"type": "text", "text": PROMPT}]}]
        inputs = self.processor.apply_chat_template(messages, tokenize=True, add_generation_prompt=True, return_dict=True,
                                                    return_tensors="pt").to("cuda")
        with self.torch.inference_mode():
            ids = self.model.generate(**inputs, **generate_kwargs(max_new_tokens, penalty))
        new = ids[:, inputs["input_ids"].shape[1]:]
        return self.processor.batch_decode(new, skip_special_tokens=True)[0].strip()

    def peak_vram_mib(self):
        return round(self.torch.cuda.max_memory_allocated() / 2**20)
