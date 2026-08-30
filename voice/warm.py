"""Download/cache the emotion-model weights into the image at build time.

Runs during `docker build` (see voice/Dockerfile.voice), so cold starts load
weights from the local HF cache instead of pulling ~1.2GB from the hub.
"""

import app

if not app.load_model():
    print("[warm] model load FAILED at build time")
    raise SystemExit(1)
print("[warm] weights cached")
