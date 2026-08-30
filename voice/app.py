"""Speech-emotion sidecar for the room.

POST /emotion?sample_rate=16000  body: raw little-endian float32 PCM (mono)

Returns {"mood": {valence, energy, label, confidence}} or {"mood": null}.
Runs superb/hubert-large-superb-er (HuBERT, IEMOCAP classes) locally.
First start downloads the weights (~1.2 GB) into the HF cache.
"""

import numpy as np
import torch
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from transformers import (
    AutoProcessor,
    Wav2Vec2Model,
    Wav2Vec2PreTrainedModel,
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Warm the model at boot so the first /emotion call isn't slow. The
    # weights are already cached in the image (see warm.py, run at build
    # time) — this just loads them into memory (~10s) before traffic hits.
    load_model()
    yield


app = FastAPI(lifespan=lifespan)

# superb/hubert-large-superb-er ignored prosody entirely (stamped "bright" on
# everything), so we use a continuous arousal/valence model trained on real
# podcast speech instead. Loads per the model card: a custom wrapper around
# Wav2Vec2Model + a regression head; outputs [arousal, dominance, valence],
# approximately 0..1.
MODEL_ID = "audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim"


class RegressionHead(torch.nn.Module):
    def __init__(self, config):
        super().__init__()
        self.dense = torch.nn.Linear(config.hidden_size, config.hidden_size)
        self.dropout = torch.nn.Dropout(config.final_dropout)
        self.out_proj = torch.nn.Linear(config.hidden_size, config.num_labels)

    def forward(self, features):
        x = features
        x = self.dropout(x)
        x = self.dense(x)
        x = torch.tanh(x)
        x = self.dropout(x)
        return self.out_proj(x)


class EmotionModel(Wav2Vec2PreTrainedModel):
    def __init__(self, config):
        super().__init__(config)
        self.config = config
        self.wav2vec2 = Wav2Vec2Model(config)
        self.classifier = RegressionHead(config)

    def forward(self, input_values):
        outputs = self.wav2vec2(input_values)
        hidden = torch.mean(outputs.last_hidden_state, dim=1)
        return self.classifier(hidden)


processor = None
model = None


def load_model():
    global processor, model
    if model is None:
        try:
            processor = AutoProcessor.from_pretrained(MODEL_ID)
            model = EmotionModel.from_pretrained(MODEL_ID)
            model.eval()
            print("[voice] model loaded")
        except Exception as e:  # pragma: no cover
            print(f"[voice] model load failed: {e}")
            return False
    return True


def label_for(valence: float, arousal: float) -> str:
    """Classic emotion names from the valence x arousal circumplex.

    Both inputs are raw model values ~0..1 (midpoint 0.5). happy/sad/angry
    are quadrants of those axes — not separate classifier outputs.

    The sad bar sits at raw 0.65 (normalized valence 0.3), not the classic
    0.45 midpoint: this regression model under-reads sadness, so soft,
    low-energy voices were landing at ~0.6 and getting stamped "content".
    User-tuned 2026-08-30 — anything below that reads sad unless it's loud,
    and loud+low reads angry.
    """
    if valence < 0.65:
        return "angry" if arousal > 0.55 else "sad"
    return "excited" if arousal > 0.55 else "content"


@app.post("/emotion")
async def emotion(request: Request):
    sample_rate = int(request.query_params.get("sample_rate", 16000))
    raw = await request.body()
    if not raw:
        return {"mood": None}

    pcm = np.frombuffer(raw, dtype="<f4")
    # Cap at ~20s: the model doesn't need more, and long clips burn CPU.
    pcm = pcm[: sample_rate * 20]

    if not load_model():
        return {"mood": None}

    inputs = processor(pcm, sampling_rate=sample_rate, return_tensors="pt")
    with torch.no_grad():
        logits = model(inputs.input_values)[0]
    arousal, _dominance, valence = (float(v) for v in logits)

    # Confidence: distance from neutral — a flat reading is a weak reading
    # and should lose the merge against the text classifier.
    confidence = min(1.0, max(0.35, abs(valence - 0.5) * 2 + abs(arousal - 0.5)))

    return {
        "mood": {
            "valence": round(float(valence * 2 - 1), 3),
            "energy": round(float(arousal), 3),
            "label": label_for(valence, arousal),
            "confidence": round(confidence, 3),
        }
    }


@app.get("/health")
async def health():
    return {"ok": True, "loaded": model is not None}