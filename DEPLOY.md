# Deploying the room to Railway

Everything lives on Railway in **two services**. The node service serves the SPA
and the API (one origin, so no CORS), and proxies audio to the Python sidecar at
`$VOICE_URL` — the same shape as local dev.

```
Browser ──> room-node (Dockerfile.node)          room-voice (Dockerfile.voice)
            serves dist/ + /api/*                FastAPI :$PORT
            └─ /api/chat        -> Claude          audeering wav2vec2 mood
            └─ /api/tts         -> ElevenLabs      (weights baked into image)
            └─ /api/voice-emotion -> ───────────>  POST /emotion
```

The in-browser SST-2 word-sentiment classifier needs no hosting — it loads from
the HF CDN in the user's browser.

## Prereqs

- Repo pushed to GitHub (Railway deploys from the git repo; `.dockerignore`
  keeps `voice/.venv`, `node_modules`, `.env` out of the build context).
- Keys ready to paste: `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`.

## Steps (dashboard)

1. **Railway → New Project → Deploy with Dockerfile**, pick this repo.
   The first build is slow (~10–15 min): the node image builds the SPA, the
   voice image installs CPU torch and downloads the ~1.2 GB model. Later deploys
   reuse layers.

2. **Service `room-node`** (public):
   - Settings → Build → **Dockerfile path**: `Dockerfile.node` (builder:
     Dockerfile).
   - Variables: `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, and
     `VOICE_URL` = the `room-voice` service's URL (see step 3).
   - It gets a public domain automatically; that's the URL you demo from.
   - Optional: enable a **volume** and mount it so `server/.room-memory.json`
     survives redeploys (see Memory note below).

3. **Service `room-voice`** (internal is fine):
   - Settings → Build → **Dockerfile path**: `Dockerfile.voice`.
   - Settings → Scaling → Resources: **≥ 4 GiB memory** (the weights are
     ~1.3 GB; 512 MiB default will OOM).
   - Grab the generated URL (`.up.railway.app`) → paste into `VOICE_URL` on the
     node service. If it's set to a `*${{...}}*` private networking reference,
     fine — the node service and voice service must both be in this project.
   - Health check: `GET /health` returns `{"ok":true,"loaded":true}` once
     warm. It comes up in ~10–20 s (model load on boot).

4. **Check** `GET /api/health` on `room-node` → `{"ok":true}`, then open the
   public URL and talk to the orb.

## Memory note

`server/.room-memory.json` (welcome-backs, mood trail, history) is written to the
container filesystem, which Railway wipes on every redeploy/restart and doesn't
share between replicas. That's fine for the demo — the room still remembers you
across browser refreshes within one instance. For true persistence, mount a
Railway volume at `/app` or point `remember.ts` at a KV/db.

## Env vars summary

| Service | Vars |
|---|---|
| `room-node` | `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `VOICE_URL` |
| `room-voice` | *(none required)* |

## Local prod-mode smoke test (optional)

```bash
npm ci && npm run build
npm run start:prod                      # server only, serves dist/ at :8787
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN npm run start:prod
# + voice sidecar in another shell:
pip install -r voice/requirements-deploy.txt --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple  # torch cpu, rest from pypi
uvicorn voice.app:app --port 8788
```
