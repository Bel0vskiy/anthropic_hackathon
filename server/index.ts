import "dotenv/config";
import express from "express";
import {
  chatTurn,
  tagTopic,
  buildSystemPrompt,
  type ChatTurn,
  type MoodReading,
} from "./claude.js";
import { VOICES, hasVoiceKey, synthesize } from "./eleven.js";

const app = express();
app.use(express.json({ limit: "256kb" }));

// Per-session history kept in memory, keyed by client-generated session id.
// A hackathon demo doesn't need persistence; a server restart resets the room.
const sessions = new Map<string, ChatTurn[]>();
// The name the room opened for, one per session. Set on first contact.
const names = new Map<string, string>();

interface ChatBody {
  sessionId?: string;
  name?: string;
  message?: string;
  mood?: MoodReading | null;
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

  const history = sessions.get(sessionId) ?? [];
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
      }
    )}`
  );

  // The name is given once at the gate and echoed by every later turn; the
  // first one heard for a session wins, so late arrivals can't hijack it.
  if (typeof name === "string" && name.trim() && !names.has(sessionId)) {
    names.set(sessionId, name.trim().slice(0, 40));
  }
  const displayName = names.get(sessionId) ?? null;

  chatTurn(history, mood, buildSystemPrompt(displayName), emit).then((updated) => {
    sessions.set(sessionId, updated.slice(-40));
    res.end();
  });
});

app.post("/api/topic", async (req, res) => {
  const { message } = req.body as ChatBody;
  if (typeof message !== "string" || message.trim().length === 0) {
    res.status(400).json({ topic: "conversation" });
    return;
  }
  const topic = await tagTopic(message.slice(0, 4000));
  res.json({ topic });
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
      const upstream = await fetch(`${VOICE_URL}/emotion?sample_rate=${sampleRate}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(req.body as Buffer),
      });
      res.status(upstream.status).json(await upstream.json());
    } catch (err: any) {
      console.error("[voice] sidecar unreachable:", err?.message ?? err);
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