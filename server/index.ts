import "dotenv/config";
import express from "express";
import { chatTurn, tagTopic, type ChatTurn, type MoodReading } from "./claude.js";

const app = express();
app.use(express.json({ limit: "256kb" }));

// Per-session history kept in memory, keyed by client-generated session id.
// A hackathon demo doesn't need persistence; a server restart resets the room.
const sessions = new Map<string, ChatTurn[]>();

interface ChatBody {
  sessionId?: string;
  message?: string;
  mood?: MoodReading | null;
}

app.post("/api/chat", (req, res) => {
  const { sessionId = "default", message, mood = null } = req.body as ChatBody;
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

  chatTurn(history, mood, emit).then((updated) => {
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
});