import { Room } from "./room";
import { warmMood, readMood, type MoodReading } from "./mood";
import { addUserMessage, startAssistantMessage, addSystemNote, updateStatus } from "./chat";
import { startCapture, speak, speakEleven, stopSpeaking, type SpeechCapture } from "./voice";

const sessionId = crypto.randomUUID();

// Whether the room speaks its replies out loud. Toggled in the status strip.
let ttsOn = false; // flips on automatically after the first mic turn

// --- the name ---------------------------------------------------------
// The room can't be personal to a stranger. The gate asks once; afterwards
// the name rides along with every turn so the room knows who it's with.

let userName = "";
let userHue = 36; // amber by default

const gate = document.getElementById("gate") as HTMLDivElement;
const gateForm = document.getElementById("gate-form") as HTMLFormElement;
const nameInput = document.getElementById("name-input") as HTMLInputElement;

// --- the hue row: eight swatches, every family but none demanding blue ---
const SWATCHES: { hue: number; name: string }[] = [
  { hue: 18, name: "coral" },
  { hue: 36, name: "amber" },
  { hue: 60, name: "gold" },
  { hue: 95, name: "moss" },
  { hue: 170, name: "teal" },
  { hue: 205, name: "sky" },
  { hue: 265, name: "violet" },
  { hue: 330, name: "rose" },
];
let chosenHue = 36;

const hueRow = document.getElementById("hue-row") as HTMLDivElement;
for (const s of SWATCHES) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "swatch";
  b.dataset.hue = String(s.hue);
  b.title = s.name;
  b.setAttribute("aria-label", `${s.name} light`);
  b.style.setProperty("--sw", `hsl(${s.hue}, 72%, 60%)`);
  b.addEventListener("click", () => {
    chosenHue = s.hue;
    for (const el of hueRow.children) {
      el.classList.toggle("picked", (el as HTMLElement).dataset.hue === b.dataset.hue);
    }
  });
  hueRow.appendChild(b);
}

// Returning visitor: prefill their name and re-pick their nearest swatch.
try {
  const savedName = localStorage.getItem("room:name");
  if (savedName) nameInput.value = savedName;
  const savedHue = Number(localStorage.getItem("room:hue"));
  if (Number.isFinite(savedHue) && SWATCHES.some((s) => s.hue === savedHue)) {
    chosenHue = savedHue;
    const picked = hueRow.querySelector<HTMLButtonElement>(`[data-hue="${savedHue}"]`);
    picked?.classList.add("picked");
  }
} catch {
  /* localStorage unavailable — fresh visit */ }

// --- the voice row: the person the room answers in -----------------------
// Names come from the server, so renaming a voice in .env renames the
// button. Picking one speaks a short line in it — you choose by hearing.

let chosenVoice = "uk";
try {
  const savedVoice = localStorage.getItem("room:voice");
  if (savedVoice) chosenVoice = savedVoice;
} catch {
  /* fresh visit */ }

const voiceRow = document.getElementById("voice-row") as HTMLDivElement;
let voiceNames: Record<string, string> = { uk: "him", us: "her" };
let previewing = false;

function pickVoice(key: string): void {
  for (const el of voiceRow.children) {
    el.classList.toggle("picked", (el as HTMLElement).dataset.voice === key);
  }
}

fetch("/api/voices")
  .then((r) => r.json())
  .then(({ voices }: { voices: { key: string; name: string }[] }) => {
    voiceNames = { ...voiceNames, ...Object.fromEntries(voices.map((v) => [v.key, v.name])) };
    for (const [key, name] of Object.entries(voiceNames)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "voice-btn";
      b.dataset.voice = key;
      b.textContent = name;
      b.addEventListener("click", () => {
        chosenVoice = key;
        pickVoice(key);
        // A whisper of the voice itself — a few characters of credit.
        if (!previewing) {
          previewing = true;
          void speakEleven("well, hello there.", key, null)
            .catch(() => void 0)
            .finally(() => setTimeout(() => (previewing = false), 400));
        }
      });
      voiceRow.appendChild(b);
    }
    pickVoice(chosenVoice);
  })
  .catch(() => {
    /* no voice service — the gate simply doesn't offer a choice */
  });

gateForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim().replace(/\s+/g, " ").slice(0, 40);
  if (!name) {
    nameInput.focus();
    return;
  }
  userName = name;
  userHue = chosenHue;
  try {
    localStorage.setItem("room:name", name);
    localStorage.setItem("room:hue", String(userHue));
    localStorage.setItem("room:voice", chosenVoice);
  } catch {
    /* private mode — the room simply forgets faster */
  }
  room.setBaseHue(userHue);
  gate.classList.add("open");
  setTimeout(() => gate.remove(), 1100);

  const input = document.getElementById("input") as HTMLInputElement;
  input.disabled = false;
  input.focus();

  // The room notices you arrive — and turns to its color for the first time.
  room.pulse(1);
  void greet(name, userHue);
});

/** The room's hello: fresh, or a welcome-back that proves it remembers. */
async function greet(name: string, hue: number): Promise<void> {
  const lightName = SWATCHES.find((s) => s.hue === hue)?.name ?? "your";
  try {
    const res = await fetch(`/api/remember?name=${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error("remember failed");
    const mem = (await res.json()) as {
      known: boolean;
      lastSeen: number;
      lastMood: { label: string; valence: number } | null;
      topic: string | null;
    };
    if (!mem.known) throw new Error("stranger");

    const parts = [`welcome back, ${name.toLowerCase()}.`];
    const when = whenPhrase(mem.lastSeen);
    if (when) {
      parts.push(
        `${when} you left the room${moodPhrase(mem.lastMood ? mem.lastMood.valence : 0)}.`
      );
    }
    // Someone who left the room low gets a warmer light to come back to —
    // the promise in the note is a real change, not just words.
    if (when && mem.lastMood && mem.lastMood.valence < -0.05) {
      room.setBaseHue(hueToward(hue, 36, 0.3));
      parts.push("it kept the light a little warmer for you.");
    }
    if (mem.topic) parts.push(`last time, it was about ${mem.topic}.`);
    addSystemNote(parts.join(" "));
  } catch {
    addSystemNote(`hello, ${name.toLowerCase()}. the room is lit ${lightName} for you.`);
  }
}

/** How long the room has been without them. */
function whenPhrase(lastSeen: number): string | null {
  const mins = Math.round((Date.now() - lastSeen) / 60000);
  if (lastSeen === 0 || mins < 3) return null; // never really left
  if (mins < 60) return `${mins} minutes ago,`;
  const left = new Date(lastSeen);
  const now = new Date();
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(left)) / 86400000);
  if (days === 0) return "earlier today,";
  if (days === 1) return "yesterday,";
  if (days < 14) return `${days} days ago,`;
  return "a while ago,";
}

/** How they seemed when they left, in the room's small voice. */
function moodPhrase(valence: number): string {
  if (valence < -0.4) return "low";
  if (valence < -0.05) return "a little low";
  if (valence > 0.3) return "bright";
  return "quiet";
}

/** Nudge a hue `amount` of the way toward a target, around the short arc. */
function hueToward(hue: number, target: number, amount: number): number {
  const d = ((target - hue + 540) % 360) - 180;
  return (hue + d * amount + 360) % 360;
}

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
  room.pulse(0.5);
  addUserMessage(message);

  // Fire-and-forget topic tag; merges into the palette when it lands.
  void fetch("/api/topic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, name: userName, message }),
  })
    .then((r) => r.json())
    .then(({ topic }: { topic: string }) => {
      room.setTopic(topic);
    })
    .catch(() => {
      /* topic is decoration — silent failure is fine */
    });

  // Mood first: text classifier, merged with the voice reading if one
  // arrived. It drives both the request payload and the visuals.
  let mood = await readMood(message);
  mood = mergeMoods(voiceMood, mood);
  room.setMood(mood);
  updateStatus(mood?.label ?? null);

  // Subtext: when the words and the voice tell different stories, the room
  // gently says so — the one thing a default assistant never does.
  if (mood?.divergent === "words") {
    addSystemNote("your words say fine. your voice says otherwise.");
  } else if (mood?.divergent === "voice") {
    addSystemNote("your words sound low. your voice doesn't.");
  }

  const append = startAssistantMessage();
  let spoken = "";
  let firstToken = true;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, name: userName, message, mood }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`chat request failed (${res.status})`);
    }
    await consumeSSE(res.body, (event) => {
      if (event.type === "token") {
        spoken += event.text as string;
        // A small elastic tick when the room starts to speak.
        if (firstToken) {
          firstToken = false;
          room.pulse(0.35);
        }
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

  // The room speaks — in the voice chosen at the gate, with the mood of the
  // moment bent into it. If elevenlabs is quiet, browser speech answers.
  if (ttsOn && spoken) {
    speakEleven(spoken, chosenVoice, mood).catch((err) => {
      console.error("[voice] elevenlabs unavailable:", err.message);
      speak(spoken, room.voiceParams());
    });
  }

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

/**
 * Blend the voice reading with the text reading, weighted by confidence.
 * When the two channels disagree — "I'm fine" said flatly — mark it, instead
 * of letting the average wash the truth out of both.
 */
function mergeMoods(
  voice: MoodReading | null,
  text: MoodReading | null
): MoodReading | null {
  if (!voice) return text;
  if (!text) return voice;
  const wv = voice.confidence + text.confidence || 1;
  // Divergence only counts when both readings are sure enough, and the gap
  // between them is wide — a flat voice under positive words, or the reverse.
  const sure = text.confidence > 0.8 && voice.confidence > 0.5;
  const wordsBetter = sure && text.valence > 0.3 && text.valence - voice.valence > 0.45;
  const voiceBetter = sure && text.valence < -0.3 && voice.valence - text.valence > 0.45;
  return {
    valence: (voice.valence * voice.confidence + text.valence * text.confidence) / wv,
    energy: (voice.energy * voice.confidence + text.energy * text.confidence) / wv,
    // Tone wins ties for the label: it's the channel you can't fake.
    label: voice.confidence >= text.confidence ? voice.label : text.label,
    confidence: Math.max(voice.confidence, text.confidence),
    fromVoice: true,
    divergent: wordsBetter ? "words" : voiceBetter ? "voice" : null,
  };
}

// --- composer ---------------------------------------------------------

const form = document.getElementById("composer") as HTMLFormElement;
const input = document.getElementById("input") as HTMLInputElement;
const micBtn = document.getElementById("mic") as HTMLButtonElement;
const voiceToggle = document.getElementById("voice-toggle") as HTMLButtonElement;

// Voice's only visible control: the speaker switch in the composer. It also
// flips on by itself after the first mic turn — you spoke, it answers.
function renderVoiceToggle(): void {
  voiceToggle.textContent = ttsOn ? "🔊" : "🔇";
  voiceToggle.setAttribute("aria-label", ttsOn ? "voice on" : "voice off");
}
renderVoiceToggle();

voiceToggle.addEventListener("click", () => {
  ttsOn = !ttsOn;
  renderVoiceToggle();
  if (!ttsOn) stopSpeaking();
});

let recording: SpeechCapture | null = null;

micBtn.addEventListener("click", async () => {
  if (!userName) {
    addSystemNote("the door opens after a name");
    nameInput.focus();
    return;
  }
  if (recording) {
    micBtn.textContent = "…";
    micBtn.classList.remove("live");
    const { transcript, mood } = await recording.stop();
    recording = null;
    micBtn.textContent = "◉";
    input.placeholder = "message…";
    if (transcript.trim()) {
      ttsOn = true; // you spoke first — the room answers out loud
      renderVoiceToggle();
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