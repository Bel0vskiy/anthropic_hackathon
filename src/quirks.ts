// ---------------------------------------------------------------------------
// Two quirks — the room's sense of humor, fired only under very specific
// conditions and on cooldowns, so they read as personality, not confetti.
//
//   1. Hearts: the user says something genuinely affectionate (or the mood
//      reading is overwhelmingly warm) and the orb lets some hearts go.
//   2. The angry dog: the user is angry (label or a hard valence/energy
//      combination) and the orb does the only thing it can think of —
//      shows an angry dog and attempts a joke.
// ---------------------------------------------------------------------------

import type { MoodReading } from "./mood";

const COOLDOWN_MS = 40_000; // per quirk; neither should fire twice in a demo beat
let lastHearts = 0;
let lastDog = 0;

const LOVE_RE = /\b(love|adore|miss)\s+(you|u)\b|\blove (this|it|that|here)\b|❤|💗|🥰/i;
const ANGRY_RE = /\b(angry|furious|fuming|pissed|raging|hate)\b/i;

const HEARTS = ["💗", "💛", "💜", "🩷", "🤍"];
const DOG_JOKES = [
  "what do you call an angry dog? a cross-breed.",
  "why don't angry dogs ever win arguments? they always paws.",
  "that dog gets you. genuinely furious. magnificent.",
  "why was the dog upset? too much ruff weather in this room.",
];

let layer: HTMLDivElement | null = null;

function quirksLayer(): HTMLDivElement {
  if (!layer) {
    layer = document.createElement("div");
    layer.id = "quirks";
    document.body.appendChild(layer);
  }
  return layer;
}

/**
 * Called once per user turn, after the mood reading lands.
 * `orbPos` gives the orb's live screen position; `startle` lets the
 * orb physically react to its own joke.
 */
export function orbQuirks(
  message: string,
  mood: MoodReading | null,
  orbPos: () => { x: number; y: number },
  startle: () => void
): void {
  const now = Date.now();

  // --- hearts ---
  const lovesYou = LOVE_RE.test(message);
  const overjoyed = !!mood && mood.valence > 0.8 && mood.confidence > 0.4;
  if ((lovesYou || overjoyed) && now - lastHearts > COOLDOWN_MS) {
    lastHearts = now;
    releaseHearts(orbPos());
  }

  // --- the angry dog ---
  const angry =
    !!mood && (mood.label === "angry" || (mood.valence < -0.55 && mood.energy > 0.5));
  if ((angry || ANGRY_RE.test(message)) && now - lastDog > COOLDOWN_MS) {
    lastDog = now;
    showDog(orbPos(), startle);
  }
}

/** Hearts lift off the orb and fade into the light. */
function releaseHearts(pos: { x: number; y: number }): void {
  const host = quirksLayer();
  const count = 7;
  for (let i = 0; i < count; i++) {
    window.setTimeout(() => {
      const h = document.createElement("span");
      h.className = "heart-emote";
      h.textContent = HEARTS[Math.floor(Math.random() * HEARTS.length)];
      const spread = (Math.random() - 0.5) * 90;
      const rise = 70 + Math.random() * 70;
      h.style.left = `${pos.x + spread}px`;
      h.style.top = `${pos.y - 20}px`;
      h.style.fontSize = `${16 + Math.random() * 14}px`;
      h.style.setProperty("--rise", `${rise}px`);
      h.style.animationDelay = `${Math.random() * 0.4}s`;
      h.addEventListener("animationend", () => h.remove());
      host.appendChild(h);
    }, i * 120);
  }
}

/** A picture of an angry dog, and an attempted joke. */
function showDog(pos: { x: number; y: number }, startle: () => void): void {
  const host = quirksLayer();
  const card = document.createElement("div");
  card.className = "dog-quirk";
  card.style.left = `${pos.x}px`;
  card.style.top = `${pos.y + 60}px`;

  const dog = document.createElement("div");
  dog.className = "dog-quirk-pic";
  dog.textContent = "🐕";
  const rage = document.createElement("span");
  rage.className = "dog-quirk-rage";
  rage.textContent = "💢";
  dog.appendChild(rage);

  const joke = document.createElement("div");
  joke.className = "dog-quirk-line";
  joke.textContent = DOG_JOKES[Math.floor(Math.random() * DOG_JOKES.length)];

  card.append(dog, joke);
  card.addEventListener("animationend", () => card.remove());
  host.appendChild(card);

  // The orb startles at its own joke.
  window.setTimeout(startle, 350);
}