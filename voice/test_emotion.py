"""Real-speech test for the emotion pipeline.

Uses macOS `say` to render one sentence in two deliveries — bright and flat —
converts to 16kHz mono WAV, and posts raw PCM through the node proxy at
localhost:8787. You should see the bright one read valence > 0 and the flat
one valence < 0 despite the identical words.

  voice/.venv/bin/python voice/test_emotion.py
  voice/.venv/bin/python voice/test_emotion.py "you decide the words"
"""

import json
import subprocess
import sys
import urllib.request
import wave
from pathlib import Path

import numpy as np

PROXY = "http://localhost:8787/api/voice-emotion"

sentence = " ".join(sys.argv[1:]) or "I am totally fine, everything is just great."
# Same words, two deliveries: (label, rate wpm, embedded pitch command)
DELIVERIES = [("bright", 200, "[[pbas 70]] "), ("flat", 125, "[[pbas 0]] ")]


def pick_voice() -> str:
    voices = subprocess.run(["say", "-v", "?"], capture_output=True, text=True).stdout
    en_us = [v.split()[0] for v in voices.splitlines() if "en_US" in v]
    assert en_us, "no en_US voice found for `say`"
    return en_us[0]


def synthesize(text: str, rate: int, out: Path) -> np.ndarray:
    subprocess.run(
        [
            "say", "-v", pick_voice(), "-r", str(rate),
            "--data-format=LEI16@16000",
            "-o", str(out), text,
        ],
        check=True,
    )
    with wave.open(str(out), "rb") as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
    out.unlink()
    return (pcm / 32768.0).astype("<f4")


def send(pcm: np.ndarray) -> dict:
    req = urllib.request.Request(
        PROXY + "?sample_rate=16000",
        data=pcm.tobytes(),
        headers={"Content-Type": "application/octet-stream"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())


for label, rate, prefix in DELIVERIES:
    pcm = synthesize(prefix + sentence, rate, Path(f"/tmp/room-test-{label}.wav"))
    print(f"{label:6s} -> {json.dumps(send(pcm))}")