import type { MoodReading } from "./mood";

// ---------------------------------------------------------------------------
// Voice for the room: mic capture -> 16kHz PCM -> /api/voice-emotion,
// Web Speech STT into the composer, and TTS whose pitch/rate follow the
// room's state — the room's voice is part of its body.
// Everything degrades silently: no mic, no STT, no sidecar => text-only.
// ---------------------------------------------------------------------------

const TARGET_RATE = 16000;

/** Breadcrumbs from the last voice-mood attempt — the room can show this
 *  directly, so a failure is visible without opening devtools. */
let lastTrace = "no attempt";
export function moodTrace(): string {
  return lastTrace;
}

export interface SpeechCapture {
  stop(): Promise<{ transcript: string; mood: MoodReading | null }>;
  /** Live mic loudness, 0..1 — for the orb leaning in. */
  level(): number;
}

/** Start mic capture + STT. Returns a handle to finish the turn. */
export function startCapture(onInterim: (text: string) => void): SpeechCapture {
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let stopped = false;

  // The orb listens here: an analyser on the live stream turns your voice
  // into a single number the room can lean with.
  let analyser: AnalyserNode | null = null;
  let analyserCtx: AudioContext | null = null;
  let samples: Uint8Array | null = null;

  const stt = Promise.resolve(startSTT(onInterim)).catch((err) => {
    console.error("[voice] STT unavailable:", err.message);
    return null;
  });

  return {
    async stop(): Promise<{ transcript: string; mood: MoodReading | null }> {
      const blob = await new Promise<Blob | null>((resolve) => {
        if (!recorder || stopped) {
          lastTrace = "no recording captured (mic not ready?)";
          return resolve(null);
        }
        stopped = true;
        recorder.onstop = () => resolve(new Blob(chunks));
        recorder.stop();
      });

      const [transcript, mood] = await Promise.all([
        finalTranscript(stt),
        blob ? audioBlobToMood(blob).catch((err: any) => {
          console.error("[voice] emotion failed:", err);
          lastTrace += " | crashed: " + (err?.message ?? err);
          return null;
        }) : Promise.resolve(null),
      ]);
      void analyserCtx?.close();
      analyser = null;
      analyserCtx = null;
      return { transcript, mood };
    },

    level(): number {
      if (!analyser || !samples) return 0;
      analyser.getByteTimeDomainData(samples as Uint8Array<ArrayBuffer>);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = (samples[i] - 128) / 128;
        sum += v * v;
      }
      // Speech RMS sits ~0.02–0.25; scale into a usable 0..1.
      return Math.min(1, Math.sqrt(sum / samples.length) * 4);
    },
  };

  void (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    window.addEventListener("beforeunload", () => stream.getTracks().forEach((t) => t.stop()));
    recorder.start();

    analyserCtx = new AudioContext();
    const source = analyserCtx.createMediaStreamSource(stream);
    analyser = analyserCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    samples = new Uint8Array(analyser.fftSize);
  })().catch((err) => {
    console.error("[voice] mic denied:", err);
    throw new Error("microphone unavailable");
  });
}

/** Recording -> MoodReading. Decode in the browser when it can; if it can't,
 * ship the recording itself to the server, where ffmpeg decodes it. */
async function audioBlobToMood(blob: Blob): Promise<MoodReading | null> {
  console.log("[voice] clip:", blob.type || "unknown container", blob.size, "bytes");
  lastTrace = `clip ${blob.size}B ${blob.type || "?"}`;
  try {
    const arr = await blob.arrayBuffer();
    const ctx = new AudioContext();
    const decoded = await ctx.decodeAudioData(arr);
    void ctx.close();

    const rendered = await resampleMono(decoded, TARGET_RATE);
    const pcm = rendered.getChannelData(0).slice(0, TARGET_RATE * 20);
    const mood = await pcmToMood(pcm);
    if (mood) return mood;
  } catch (err: any) {
    console.warn("[voice] local decode failed, trying the server:", err?.message ?? err);
    lastTrace += " | local decode failed";
  }
  return blobToMood(blob);
}

/** Decoded float32 PCM -> sidecar. */
async function pcmToMood(pcm: Float32Array): Promise<MoodReading | null> {
  // A byte view of the same samples: fresh buffer sidesteps ArrayBufferLike.
  const bytes = new Uint8Array(pcm.length * 4);
  new Float32Array(bytes.buffer).set(pcm);
  const res = await fetch(`/api/voice-emotion?sample_rate=${TARGET_RATE}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  if (!res.ok) {
    console.error("[voice] emotion proxy failed:", res.status);
    lastTrace += ` | server said ${res.status}`;
    return null;
  }
  return unwrapMood(await res.json());
}

/** The recording itself -> server-side ffmpeg -> sidecar. */
async function blobToMood(blob: Blob): Promise<MoodReading | null> {
  try {
    const res = await fetch(`/api/voice-emotion-file?sample_rate=${TARGET_RATE}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: blob,
    });
    if (!res.ok) {
      console.error("[voice] emotion (file) proxy failed:", res.status);
      lastTrace += ` | file server said ${res.status}`;
      return null;
    }
    return unwrapMood(await res.json());
  } catch (err: any) {
    console.error("[voice] emotion (file) unreachable:", err?.message ?? err);
    lastTrace += " | file server unreachable";
    return null;
  }
}

function unwrapMood(payload: { mood: MoodReading | null }): MoodReading | null {
  const { mood } = payload;
  if (mood) {
    mood.fromVoice = true;
    console.log(
      "[voice] prosody read:", mood.label,
      `valence ${mood.valence}, energy ${mood.energy}, conf ${mood.confidence}`
    );
    lastTrace += ` | sidecar read ${mood.label} (${mood.confidence})`;
  } else {
    console.warn("[voice] prosody: sidecar read nothing from that clip");
    lastTrace += " | sidecar read nothing";
  }
  return mood;
}

async function resampleMono(buffer: AudioBuffer, rate: number): Promise<AudioBuffer> {
  const length = Math.max(1, Math.ceil(buffer.duration * rate));
  const offline = new OfflineAudioContext(1, length, rate);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start();
  return offline.startRendering();
}

// ---- STT (Web Speech API; Chrome/Edge/Safari, not Firefox) ---------------

interface RecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: any) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: any) => void) | null;
  start(): void;
  stop(): void;
}

interface STTHandle {
  rec: RecognitionLike;
  getFinal: () => string;
  ended: () => boolean;
}

/** Returns an STTHandle; getFinal is populated by onresult events. */
function startSTT(onInterim: (text: string) => void): STTHandle {
  const AnyWin = window as any;
  const Ctor = AnyWin.SpeechRecognition ?? AnyWin.webkitSpeechRecognition;
  if (!Ctor) throw new Error("STT unavailable");

  const rec: RecognitionLike = new Ctor();
  rec.continuous = false;
  rec.interimResults = true;

  let finalText = "";
  let ended = false;
  rec.onresult = (e: any) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    onInterim(finalText || interim);
  };
  rec.onend = () => {
    ended = true;
  };
  rec.onerror = (e: any) => console.error("[voice] STT error:", e?.error);

  rec.start();
  return { rec, getFinal: () => finalText.trim(), ended: () => ended };
}

async function finalTranscript(
  stt: Promise<STTHandle | null>
): Promise<string> {
  const handle = await stt;
  if (!handle) return "";
  handle.rec.stop();
  // Wait for the recognition session to end (the engine flushes its final
  // result just before onend), capped at 3s.
  const t0 = Date.now();
  while (!handle.ended() && Date.now() - t0 < 3000) {
    await new Promise((r) => setTimeout(r, 150));
  }
  await new Promise((r) => setTimeout(r, 200));
  return handle.getFinal();
}

// ---- TTS -------------------------------------------------------------------
// The real voice comes from elevenlabs, proxied through /api/tts with the
// mood folded in server-side; the tone of the audio bends to how the room
// feels. When that fails — no key, dead network — browser speech answers so
// the room is never mute.

let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

/** ElevenLabs playback. Throws if the room's real voice is unavailable.
 *  Resolves with the playing audio element so text can be revealed in step. */
export async function speakEleven(
  text: string,
  voice: string,
  mood: MoodReading | null
): Promise<HTMLAudioElement> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice, mood }),
  });
  if (!res.ok) throw new Error(`tts failed (${res.status})`);

  stopSpeaking();
  const url = URL.createObjectURL(await res.blob());
  const audio = new Audio(url);
  currentAudio = audio;
  currentUrl = url;
  audio.onended = () => {
    if (currentUrl === url) URL.revokeObjectURL(url);
    if (currentAudio === audio) {
      currentAudio = null;
      currentUrl = null;
    }
  };
  await audio.play();
  return audio;
}

export function speak(text: string, params: { rate: number; pitch: number }): void {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = params.rate;
  u.pitch = params.pitch;
  u.volume = 0.9;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
    currentUrl = null;
  }
  window.speechSynthesis?.cancel();
}