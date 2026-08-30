import "dotenv/config";
import { spawn } from "node:child_process";
import express from "express";
import {
  chatTurn,
  tagTopic,
  buildSystemPrompt,
  type MoodReading,
} from "./claude.js";
import { VOICES, hasVoiceKey, synthesize } from "./eleven.js";
import { getPerson, savePerson, recall, type PersonMemory } from "./remember.js";

const app = express();
app.use(express.json({ limit: "256kb" }));

// History, mood trail and time-of-last-goodbye live in the person memory
// (server/remember.ts) keyed by name, so the room keeps working across
// refreshes and restarts. The name the room opened for wins; later echoes
// can't hijack it.
const names = new Map<string, string>();

interface ChatBody {
  sessionId?: string;
  name?: string;
  message?: string;
  mood?: MoodReading | null;
}

/** A person key: stable across refreshes when a name is known. */
function personKey(sessionId: string, name: string | null): string {
  const n = name?.trim().toLowerCase();
  return n ? `person:${n}` : `session:${sessionId}`;
}

function recordMood(mem: PersonMemory, mood: MoodReading | null): void {
  if (!mood) return;
  const stamp = {
    t: Date.now(),
    valence: mood.valence,
    energy: mood.energy,
    label: mood.label,
  };
  mem.moods.push(stamp);
  mem.lastMood = stamp;
}

app.post("/api/chat", (req, res) => {
  const { sessionId = "default", name, message, mood = null } = req.body as ChatBody;
  if (typeof message !== "string" || message.trim().length === 0) {
    res.status(400).json({ error: "message required" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  const emit = (event: { type: string; [k: string]: unknown }) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // The name is given once at the gate and echoed by every later turn; the
  // first one heard for a session wins, so late arrivals can't hijack it.
  const key = personKey(sessionId, name ?? null);
  if (typeof name === "string" && name.trim() && !names.has(key)) {
    names.set(key, name.trim().slice(0, 40));
  }
  const displayName = names.get(key) ?? null;

  const mem = getPerson(key, displayName);
  if (displayName) mem.name = displayName;
  // A gap of 30+ minutes counts as a return visit.
  if (mem.lastSeen > 0 && Date.now() - mem.lastSeen > 30 * 60 * 1000) mem.visits += 1;
  mem.visits = Math.max(mem.visits, 1);

  const history = mem.history;
  const userMsg = message.slice(0, 4000);
  history.push({ role: "user", content: userMsg });
  // Visible test affordance: every turn shows what the room "sensed".
  console.log(
    `[mood] ${JSON.stringify(
      mood && {
        valence: mood.valence,
        energy: mood.energy,
        label: mood.label,
        conf: mood.confidence,
        voice: !!mood.fromVoice,
        divergent: mood.divergent ?? null,
      }
    )}`
  );

  chatTurn(history, mood, buildSystemPrompt(displayName), emit).then((updated) => {
    mem.history = updated.slice(-40);
    recordMood(mem, mood);
    savePerson(key, mem);
    res.end();
  });
});

app.post("/api/topic", async (req, res) => {
  const { sessionId, name, message } = req.body as ChatBody;
  if (typeof message !== "string" || message.trim().length === 0) {
    res.status(400).json({ topic: "conversation" });
    return;
  }
  const topic = await tagTopic(message.slice(0, 4000));
  // Keep the last topic on the person, so the welcome-back note can say it.
  if (topic && topic !== "conversation") {
    const key = personKey(sessionId ?? "default", name ?? null);
    const mem = getPerson(key, name ?? null);
    mem.topic = topic;
    savePerson(key, mem);
  }
  res.json({ topic });
});

// What the room remembers about someone approaching the door. The client
// calls it as the gate opens, to greet a returning visitor properly.
app.get("/api/remember", (req, res) => {
  const name = typeof req.query.name === "string" ? req.query.name : "";
  if (!name.trim()) {
    res.json({ known: false, visits: 0, lastSeen: 0, lastMood: null, topic: null });
    return;
  }
  res.json(recall(personKey("default", name)));
});

// The voices the gate offers, by name. Kept here so the client never sees
// ids or keys; renaming a voice in .env renames the button.
app.get("/api/voices", (_req, res) => {
  res.json({
    voices: Object.entries(VOICES).map(([key, v]) => ({ key, name: v.name })),
  });
});

// Text -> mood-bent ElevenLabs audio. Binary passthrough; failures fall back
// to browser speech on the client, so a dead key is silent, not broken.
app.post("/api/tts", async (req, res) => {
  const { text, voice, mood = null } = req.body as {
    text?: string;
    voice?: string;
    mood?: MoodReading | null;
  };
  if (typeof text !== "string" || text.trim().length === 0) {
    res.status(400).json({ error: "text required" });
    return;
  }
  if (!hasVoiceKey()) {
    res.status(503).json({ error: "no voice key" });
    return;
  }
  try {
    const upstream = await synthesize(text, voice ?? "uk", mood);
    if (!upstream.ok || !upstream.body) {
      console.error(
        `[tts] elevenlabs ${upstream.status}:`,
        (await upstream.text().catch(() => "")).slice(0, 300)
      );
      res.status(502).json({ error: "tts failed" });
      return;
    }
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (err: any) {
    console.error("[tts] unreachable:", err?.message ?? err);
    res.status(502).json({ error: "tts failed" });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Binary proxy to the Python speech-emotion sidecar. The frontend only ever
// talks to this origin; if the sidecar is down we report mood:null rather
// than failing — voice is an enhancement, not a dependency.
const VOICE_URL = process.env.VOICE_URL ?? "http://localhost:8788";

app.post(
  "/api/voice-emotion",
  express.raw({ type: "*/*", limit: "8mb" }),
  async (req, res) => {
    try {
      const sampleRate = req.query.sample_rate ?? "16000";
      const bytes = (req.body as Buffer).length;
      const upstream = await fetch(`${VOICE_URL}/emotion?sample_rate=${sampleRate}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(req.body as Buffer),
      });
      const payload = await upstream.json();
      console.log(`[voice] ${bytes} bytes -> ${upstream.status} ${JSON.stringify(payload).slice(0, 120)}`);
      res.status(upstream.status).json(payload);
    } catch (err: any) {
      console.error("[voice] sidecar unreachable:", err?.message ?? err);
      res.json({ mood: null });
    }
  }
);

/** ffmpeg-decode any MediaRecorder container (webm/opus, mp4/aac…) to mono
 *  16 kHz float32 — the browser path's fallback when decodeAudioData fails. */
function ffmpegTo16kF32(input: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const ff = spawn("ffmpeg", [
      "-loglevel", "error",
      "-i", "pipe:0",
      "-f", "f32le", "-ac", "1", "-ar", "16000",
      "pipe:1",
    ]);
    const out: Buffer[] = [];
    ff.stdout.on("data", (c: Buffer) => out.push(c));
    ff.on("error", () => resolve(null));
    ff.on("close", (code) => resolve(code === 0 ? Buffer.concat(out) : null));
    ff.stdin.end(input);
  });
}

// Same contract as /api/voice-emotion, but the body is the recording itself.
app.post(
  "/api/voice-emotion-file",
  express.raw({ type: "*/*", limit: "16mb" }),
  async (req, res) => {
    try {
      const input = req.body as Buffer;
      const pcm = await ffmpegTo16kF32(input);
      if (!pcm || pcm.length < 4) {
        console.warn(`[voice] ffmpeg decoded nothing from ${input.length} bytes`);
        res.json({ mood: null });
        return;
      }
      const upstream = await fetch(`${VOICE_URL}/emotion?sample_rate=16000`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(pcm),
      });
      const payload = await upstream.json();
      console.log(
        `[voice] file ${input.length} bytes -> ${pcm.length / 4} samples -> ${JSON.stringify(payload).slice(0, 120)}`
      );
      res.status(upstream.status).json(payload);
    } catch (err: any) {
      console.error("[voice] file proxy failed:", err?.message ?? err);
      res.json({ mood: null });
    }
  }
);

const PORT = process.env.PORT ?? 8787;
app.listen(PORT, () => {
  console.log(`[room] listening on http://localhost:${PORT}`);
  if (hasVoiceKey()) {
    console.log(
      `[tts] elevenlabs on — ${Object.values(VOICES)
        .map((v) => v.name)
        .join(", ")}`
    );
  } else {
    console.log("[tts] no ELEVENLABS_API_KEY — replies will use browser speech");
  }
});