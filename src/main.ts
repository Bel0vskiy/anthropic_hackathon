import { Room } from "./room";
import { warmMood, readMood, type MoodReading } from "./mood";
import { addUserMessage, startAssistantMessage, addSystemNote, updateStatus } from "./chat";
import { startCapture, speak, stopSpeaking, type SpeechCapture } from "./voice";

const sessionId = crypto.randomUUID();

// Whether the room speaks its replies out loud. Toggled in the status strip.
let ttsOn = false; // flips on automatically after the first mic turn

// --- the room ---------------------------------------------------------

const room = new Room(document.getElementById("room") as HTMLCanvasElement);
warmMood();

// Test affordances for the browser console:
//   __mood("i am furious")        -> raw text-classifier reading
//   __room.setRoom({weather:"storm"}) -> drive the room by hand
(room as any).warm = warmMood;
(window as any).__mood = readMood;
(window as any).__room = room;

// --- chat over SSE ----------------------------------------------------

async function send(message: string, voiceMood: MoodReading | null = null): Promise<void> {
  addUserMessage(message);

  // Fire-and-forget topic tag; merges into the palette when it lands.
  void fetch("/api/topic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  })
    .then((r) => r.json())
    .then(({ topic }: { topic: string }) => {
      room.setTopic(topic);
      updateStatus(null, topic);
    })
    .catch(() => {
      /* topic is decoration — silent failure is fine */
    });

  // Mood first: text classifier, merged with the voice reading if one
  // arrived. It drives both the request payload and the visuals.
  let mood = await readMood(message);
  mood = mergeMoods(voiceMood, mood);
  room.setMood(mood);
  updateStatus(mood?.label ?? null, null);

  const append = startAssistantMessage();
  let spoken = "";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message, mood }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`chat request failed (${res.status})`);
    }
    await consumeSSE(res.body, (event) => {
      if (event.type === "token") {
        spoken += event.text as string;
        append(event.text as string);
      } else if (event.type === "room") {
        const { type: _t, tool: _tool, ...roomState } = event;
        room.setRoom(roomState);
      } else if (event.type === "error") {
        addSystemNote(String(event.message));
      }
    });
  } catch (err) {
    console.error(err);
    addSystemNote("connection failed — try again");
  }

  // The room speaks — only after a conversation that started with voice.
  if (ttsOn && spoken) speak(spoken, room.voiceParams());

  const input = document.getElementById("input") as HTMLInputElement;
  input.disabled = false;
  input.focus();
}

/** Minimal SSE parser over fetch streams (multiple data: lines per event). */
async function consumeSSE(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: { type: string; [k: string]: unknown }) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data));
      } catch {
        /* ignore malformed frames */
      }
    }
  }
}

/** Blend the voice reading with the text reading, weighted by confidence. */
function mergeMoods(
  voice: MoodReading | null,
  text: MoodReading | null
): MoodReading | null {
  if (!voice) return text;
  if (!text) return voice;
  const wv = voice.confidence + text.confidence || 1;
  return {
    valence: (voice.valence * voice.confidence + text.valence * text.confidence) / wv,
    energy: (voice.energy * voice.confidence + text.energy * text.confidence) / wv,
    // Tone wins ties for the label: it's the channel you can't fake.
    label: voice.confidence >= text.confidence ? voice.label : text.label,
    confidence: Math.max(voice.confidence, text.confidence),
    fromVoice: true,
  };
}

// --- composer ---------------------------------------------------------

const form = document.getElementById("composer") as HTMLFormElement;
const input = document.getElementById("input") as HTMLInputElement;
const micBtn = document.getElementById("mic") as HTMLButtonElement;
const voiceToggle = document.getElementById("voice-toggle") as HTMLButtonElement;

voiceToggle.textContent = ttsOn ? "voice on" : "voice off";
voiceToggle.addEventListener("click", () => {
  ttsOn = !ttsOn;
  voiceToggle.textContent = ttsOn ? "voice on" : "voice off";
  if (!ttsOn) stopSpeaking();
});

let recording: SpeechCapture | null = null;

micBtn.addEventListener("click", async () => {
  if (recording) {
    micBtn.textContent = "…";
    micBtn.classList.remove("live");
    const { transcript, mood } = await recording.stop();
    recording = null;
    micBtn.textContent = "◉";
    input.placeholder = "message…";
    if (transcript.trim()) {
      ttsOn = true; // you spoke first — the room answers out loud
      voiceToggle.textContent = "voice on";
      input.value = "";
      void send(transcript.trim(), mood);
    } else {
      addSystemNote("I didn't catch that — hold the mic a little longer");
    }
    return;
  }
  try {
    input.value = "";
    input.placeholder = "listening… (click again to stop)";
    micBtn.classList.add("live");
    recording = startCapture((text) => {
      input.value = text;
    });
    micBtn.textContent = "■";
  } catch (err: any) {
    micBtn.classList.remove("live");
    micBtn.textContent = "◉";
    addSystemNote(err?.message ?? "microphone unavailable");
  }
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message || input.disabled) return;
  input.value = "";
  input.disabled = true;
  void send(message);
});