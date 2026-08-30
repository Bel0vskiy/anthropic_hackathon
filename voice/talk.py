"""Terminal mic loop: talk, see the mood the model detects.

  voice/.venv/bin/python voice/talk.py

Press Enter to start recording, Enter again to stop and get a reading on the
same proxy the app uses (node :8787 -> sidecar :8788). Ctrl+C to quit.

  voice/.venv/bin/python voice/talk.py --direct   # hit the sidecar directly
"""

import json
import sys
import urllib.request

import numpy as np
import sounddevice as sd

SR = 16000
URL_PROXY = "http://localhost:8787/api/voice-emotion?sample_rate=16000"
URL_DIRECT = "http://localhost:8788/emotion?sample_rate=16000"


def record() -> np.ndarray:
    chunks: list[np.ndarray] = []
    with sd.InputStream(samplerate=SR, channels=1, dtype="float32",
                        callback=lambda indata, *_: chunks.append(indata.copy())):
        try:
            input("")
        except EOFError:
            pass  # piped stdin (smoke tests) — return whatever was captured
    return np.concatenate(chunks).reshape(-1) if chunks else np.zeros(0, np.float32)


def trim(pcm: np.ndarray, floor: float = 0.01) -> np.ndarray:
    """Cut leading/trailing silence so clacks between keys don't dominate."""
    above = np.where(np.abs(pcm) > floor)[0]
    if len(above) == 0:
        return pcm
    pad = int(0.2 * SR)
    lo, hi = max(0, above[0] - pad), min(len(pcm), above[-1] + pad)
    return pcm[lo:hi]


def send(pcm: np.ndarray, url: str) -> dict | None:
    req = urllib.request.Request(
        url, data=pcm.astype("<f4").tobytes(),
        headers={"Content-Type": "application/octet-stream"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())["mood"]


def bar(v: float, width: int = 24) -> str:
    filled = round(max(0.0, min(1.0, abs(v))) * width)
    return "[" + "#" * filled + "." * (width - filled) + "]"


def main() -> None:
    url = URL_DIRECT if "--direct" in sys.argv else URL_PROXY
    print("enter = talk, enter again = stop, ctrl+c = quit\n")
    try:
        while True:
            sys.stdout.write("listening… ")
            sys.stdout.flush()
            pcm = record()
            if len(pcm) < 10:
                print("nothing captured")
                continue
            pcm = trim(pcm)
            dur = len(pcm) / SR
            print(f"\r{dur:5.1f}s {bar(max(pcm.max(), 0), 16)} peak   ", end="\n  ")
            try:
                mood = send(pcm, url)
            except (urllib.error.URLError, ConnectionError) as e:
                print(f"server unreachable: {e}")
                continue
            if not mood:
                print("no reading")
                continue
            sign = "+" if mood["valence"] >= 0 else "-"
            print(
                f"valence {sign}{abs(mood['valence']):.2f} {bar(mood['valence'])}"
                f"   energy {mood['energy']:.2f} {bar(mood['energy'])}"
                f"   -> {mood['label']}  (conf {mood['confidence']:.2f})"
            )
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()