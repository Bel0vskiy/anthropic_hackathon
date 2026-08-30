import type { MoodReading } from "./claude.js";

// ---------------------------------------------------------------------------
// ElevenLabs: the room's real voice. The browser's speechSynthesis is only
// its shadow, used when the key is missing or the call fails.
// The API key never leaves the server; the client just names a voice and
// hands over the mood, and the tone of the audio bends to it.
// ---------------------------------------------------------------------------

const API_KEY = process.env.ELEVENLABS_API_KEY ?? "";
// eleven_flash_v2_5: half a credit a character, fast enough to feel spoken
// rather than rendered. Swap here (or per-call) if the tier changes.
const MODEL_ID = process.env.ELEVENLABS_MODEL ?? "eleven_flash_v2_5";
// Base speaking pace; ELEVENLABS_SPEED in .env tunes it (lower = slower).
const BASE_SPEED = Number(process.env.ELEVENLABS_SPEED ?? 0.8);

export function hasVoiceKey(): boolean {
  return API_KEY.length > 0;
}

/** The two people the room can answer in — a deep male and a warm female,
 *  chosen at the gate. Premade ElevenLabs voices, usable on the free plan. */
export const VOICES: Record<string, { id: string; name: string }> = {
  uk: {
    id: process.env.ELEVENLABS_VOICE_UK ?? "pNInz6obpgDQGcFmaJgB", // adam — deep male
    name: process.env.ELEVENLABS_VOICE_UK_NAME ?? "him",
  },
  us: {
    id: process.env.ELEVENLABS_VOICE_US ?? "EXAVITQu4vr4xnSDxMaL", // bella — soft female
    name: process.env.ELEVENLABS_VOICE_US_NAME ?? "her",
  },
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Emotion -> ElevenLabs voice settings.
 *  stability: a moved voice wavers, an even one doesn't.
 *  style:     the room's energy becomes exaggeration.
 *  speed:     energy speaks faster; sadness drags a little. */
export function buildVoiceSettings(
  mood: MoodReading | null
): Record<string, number | boolean> {
  const valence = mood?.valence ?? 0;
  const energy = mood?.energy ?? 0.4;
  const stability = clamp(0.62 - Math.abs(valence) * 0.32 - energy * 0.12, 0.15, 0.85);
  const style = clamp(energy * 0.55 - 0.08, 0, 0.6);
  const speed = clamp(
    BASE_SPEED + energy * 0.18 + (valence < -0.3 ? -0.05 : 0),
    0.7,
    1.1
  );
  return {
    stability: Number(stability.toFixed(2)),
    similarity_boost: 0.78,
    style: Number(style.toFixed(2)),
    speed: Number(speed.toFixed(2)),
    use_speaker_boost: true,
  };
}

export async function synthesize(
  text: string,
  voiceKey: string,
  mood: MoodReading | null
): Promise<Response> {
  const voice = VOICES[voiceKey] ?? VOICES.uk;
  return fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice.id}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: text.slice(0, 600), // credits are finite; a reply never needs more
        model_id: MODEL_ID,
        voice_settings: buildVoiceSettings(mood),
      }),
    }
  );
}