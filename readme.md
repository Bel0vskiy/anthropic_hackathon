# the room

*Anthropic hackathon — "personify AI."*

A normal chatbot that pays attention. You can type or speak; either way the
app reads your mood — words via an in-browser sentiment classifier, tone of
voice via a HuBERT valence/arousal model — and the environment around the
conversation quietly changes to match: light, weather, drifting particles.
The bot can also reshape the environment itself through tool calls when the
conversation genuinely turns.

```
message ──┬── sentiment classifier (DistilBERT, in-browser, transformers.js)
          └── speech-emotion model (audeering MSP-dim, Python sidecar)
              └── merged, confidence-weighted mood reading
                    ├──► palette + particle energy of the canvas
                    └──► passed to Claude (Haiku 4.5) as background context
                          └── streams a normal reply; may call set_light /
                              set_weather / set_ambience on a real shift
```

The mood reading is framed as context ("never mention it") so the bot doesn't
become a mood mirror — it just talks to you a bit differently, in a room that
bit: say "I'm fine" flatly and it won't congratulate you.

## Run

```bash
npm install
# put your Anthropic API key in .env  (see .env.example)
npm start          # server on :8787, vite on :5173 — open http://localhost:5173

# voice sidecar (optional — text mood still works without it)
python3 -m venv --system-site-packages voice/.venv
voice/.venv/bin/pip install -r voice/requirements.txt "transformers<5"
voice/.venv/bin/uvicorn app:app --app-dir voice --port 8788
```

Note: the sidecar downloads ~1.2 GB of weights on first start, and needs
`transformers<5` (the model's wrapper class predates the 5.x loader).

## Testing the emotion pipeline

```bash
# One sentence, two deliveries — bright/fast vs flat/slow.
# Expect the energy axis (0..1) to separate clearly between the two.
voice/.venv/bin/python voice/test_emotion.py
```

In the browser (Chrome) console: `__mood("some text")` prints the raw text
classifier reading; `__room.setRoom({weather: "storm"})` drives the room by
hand. Every chat turn prints the merged reading to the server log as
`[mood] …` — that's ground truth for what Claude saw.

Talk straight from the terminal and watch the reading (both servers running):

```bash
voice/.venv/bin/python voice/talk.py
# enter = talk, enter again = stop; valence/energy bars + label each turn
```

## How it works

- `server/` — Express. `/api/chat` streams SSE events (`token`, `room`,
  `error`); `/api/topic` tags the message via a forced tool call; the API key
  never leaves the server.
- `src/room.ts` — canvas 2D: three slowly-orbiting gradient blobs, a
  120-particle flow field, rain/snow/fog/storm overlays. Exponential
  smoothing + hysteresis, so it never strobes.
- `src/mood.ts` — transformers.js sentiment, in-browser.
- `src/voice.ts` — mic capture, decode + resample to 16 kHz, STT (Web
  Speech) and TTS that follows the environment's current state.
- `voice/app.py` — FastAPI sidecar wrapping
  `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim` (arousal/dominance/
  valence on ~0..1). Load exactly as the model card prescribes — an
  `AutoModelForAudioClassification` load silently randomizes the head.

What the audio model actually does (honest read from testing): the *energy*
axis tracks delivery/tone well; the *valence* axis mostly tracks the words.
So "tone over words" shows up as restlessness and pace first — don't pitch
the demo as "it hears the lie, it hears the truth".

## Notes

- History lives in server memory (last 40 turns per session); a restart
  resets it. Fine for a demo, on purpose.
- Backlog: Open-Meteo weather substrate, time-of-day light, sarcasm flag via
  text/audio disagreement.