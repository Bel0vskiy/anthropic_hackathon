import type { MoodReading } from "./mood";

// ---------------------------------------------------------------------------
// The Room is one entity now: a white orb, lit from behind.
//
// The light behind it does the talking — its color is the room's voice, bent
// by mood, topic and weather, flexible across the whole hue wheel while the
// orb itself stays white. The orb's size is governed by a real damped spring
// (so it overshoots and settles, elastic rather than eased), and its contour
// wobbles proportionally to how fast the spring is moving — kicked on every
// message, breathing on its own.
//
// Nothing strobes: targets move smoothly, mood readings only shift the
// target when they clear a hysteresis threshold.
// ---------------------------------------------------------------------------

type RGB = [number, number, number];
type Weather = "clear" | "overcast" | "rain" | "storm" | "snow" | "fog" | null;
type Palette = "warm" | "cool" | "dim" | "vivid" | "stark";
type Drift = "still" | "breeze" | "gusts";
type Topic = string | null;

interface Target {
  // identity — the hue the room opened in, chosen at the gate
  baseHue: number; // 0..360
  // mood-driven
  moodValence: number; // -1..1
  moodEnergy: number; // 0..1
  // tool-driven
  weather: Weather;
  palette: Palette;
  intensity: number; // 0..1: how brightly the light behind burns
  dustEnergy: number; // 0..1: drift of the motes around the orb
  drift: Drift;
  // topic tint
  topicHue: number; // 0..360
  topicStrength: number; // how strongly the topic bends the light
}

const MOOD_HYSTERESIS = 0.15;
const SMOOTH = 0.035; // fraction closed per frame toward target
const COLOR_SMOOTH = 0.018; // the light changes about twice as slow as everything else
const SPRING_K = 0.085; // stiffness of the orb's radius spring
const SPRING_DAMP = 0.86; // velocity retained per frame — under 1, so it settles

// The color field: hue offsets from the mood's base hue, each parked at its
// own angle around the orb and drifting on a slow orbit. Offsets are chosen
// so a warm base yields pink / amber / cyan / violet — real range, not a
// one-hue cast. Whatever the mood, the light never lands on a single color.
const COLOR_SEEDS = [
  { hueOff: -40, angle: -2.3, dist: 1.15, size: 3.2, alpha: 0.34, speed: 0.11, phase: 0 },
  { hueOff: 30, angle: -0.6, dist: 1.35, size: 3.6, alpha: 0.3, speed: 0.08, phase: 1.7 },
  { hueOff: 150, angle: 0.8, dist: 1.25, size: 3.4, alpha: 0.26, speed: 0.06, phase: 3.1 },
  { hueOff: 230, angle: 2.6, dist: 1.5, size: 3.8, alpha: 0.24, speed: 0.09, phase: 4.4 },
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Signed hue delta from `from` toward `to`, shortest way around the wheel. */
function shortestHueDelta(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** Deterministic topic hue from the one-word tag. */
function hueFromString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function hslToRGB(hDeg: number, s: number, l: number): RGB {
  const h = ((hDeg % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

export class Room {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private target: Target;
  private state: Target;
  private t = 0; // frame-time accumulator
  private raf = 0;
  private lastFlash = 0;

  // The orb itself: a spring on its radius, never drawn from a target directly.
  private r = 110;
  private vr = 0;

  // And a spring on its position — the orb wanders, leans, and startles.
  private cxo = 0; // x offset from home
  private cyo = 0; // y offset from home
  private ovx = 0;
  private ovy = 0;

  // The light itself is a smoothed value, not derived: every color change —
  // mood, topic, even discrete weather/palette swaps — glides through here.
  private auraState = { hue: 36, sat: 0.5, light: 0.5 };
  // Curiosity, low-pass filtered — the orb sways after the cursor.
  private leanX = 0;
  private leanY = 0;
  // Where the orb is this frame — quirks outside the canvas aim from here.
  private cx = 0;
  private cy = 0;

  private mouse: { x: number; y: number; seen: number } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    window.addEventListener("mousemove", (e) => {
      this.mouse = { x: e.clientX, y: e.clientY, seen: this.t };
    });

    const start: Target = {
      baseHue: 36, // amber until the gate says otherwise
      moodValence: 0,
      moodEnergy: 0.4,
      weather: null,
      palette: "warm",
      intensity: 0.5,
      dustEnergy: 0.3,
      drift: "breeze",
      topicHue: 210,
      topicStrength: 0,
    };
    this.state = { ...start };
    this.target = { ...start };

    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio ?? 1, 2);
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---- external state ------------------------------------------------

  /** The hue the room opened in — chosen by the person, owned by the room. */
  setBaseHue(h: number): void {
    this.target.baseHue = ((h % 360) + 360) % 360;
  }

  /** Where the orb is right now, in screen px — for things orbiting outside the canvas. */
  orbPos(): { x: number; y: number } {
    return { x: this.cx, y: this.cy };
  }

  setMood(mood: MoodReading | null): void {
    if (!mood) return;
    // Hysteresis: ignore readings that barely move from the current target.
    if (
      Math.abs(mood.valence - this.target.moodValence) < MOOD_HYSTERESIS &&
      Math.abs(mood.energy - this.target.moodEnergy) < MOOD_HYSTERESIS
    ) {
      return;
    }
    this.target.moodValence = mood.valence;
    this.target.moodEnergy = mood.energy;
    this.target.intensity = 0.5 + mood.energy * 0.4;
  }

  setRoom(room: {
    palette?: string;
    intensity?: number;
    weather?: string;
    particleEnergy?: number;
    dustEnergy?: number;
    drift?: string;
  }): void {
    if (room.palette) this.target.palette = room.palette as Palette;
    if (typeof room.intensity === "number") this.target.intensity = room.intensity;
    if (room.weather) this.target.weather = room.weather as Weather;
    if (typeof room.particleEnergy === "number") {
      this.target.dustEnergy = room.particleEnergy;
    }
    if (typeof room.dustEnergy === "number") this.target.dustEnergy = room.dustEnergy;
    if (room.drift) this.target.drift = room.drift as Drift;
  }

  /** The room's voice: rate/pitch follow its current body state. */
  voiceParams(): { rate: number; pitch: number } {
    const s = this.state;
    const heavy = s.weather === "storm" || s.weather === "rain";
    const dim = s.intensity < 0.35;
    const rate = 0.82 + s.moodEnergy * 0.35 - (heavy ? 0.08 : 0);
    let pitch = 0.62 + s.intensity * 0.42;
    if (s.moodValence < -0.2 || dim || heavy) pitch -= 0.18;
    return {
      rate: Math.min(1.15, Math.max(0.72, rate)),
      pitch: Math.min(1.25, Math.max(0.5, pitch)),
    };
  }

  setTopic(topic: Topic): void {
    if (!topic) return;
    this.target.topicHue = hueFromString(topic);
    this.target.topicStrength = 0.35;
  }

  /** An elastic kick. Called when messages arrive; strength ~0..1.5. */
  pulse(strength = 1): void {
    this.vr += 16 * strength;
    // A mild startle: the orb eases off its perch, then drifts home.
    const a = Math.random() * Math.PI * 2;
    const k = 2.2 * strength;
    this.ovx += Math.cos(a) * k;
    this.ovy += Math.sin(a) * k * 0.5;
  }

  // ---- color ----------------------------------------------------------

  /** The hue of the light behind the orb: mood bends it, topic tints it. */
  private auraColor(): { hue: number; sat: number; light: number } {
    const s = this.state;
    const v = s.moodValence;
    const energy = s.moodEnergy;

    // The room keeps the color it opened in. Mood swings *around* it:
    // high valence warps the hue ~30° brighter along the wheel and lifts
    // the light; low valence cools the saturation and dims it — but the
    // room's hue is home, and the light always drifts back.
    let baseHue = s.baseHue + v * 30;
    let sat = lerp(0.45, 0.8, energy) * (v < 0 ? 0.85 : 1);
    let light = lerp(0.44, 0.66, v * 0.5 + 0.5);

    switch (s.palette) {
      case "warm":
        // Nudge halfway toward the warm pole, not an override — the room
        // keeps its own color underneath.
        baseHue += shortestHueDelta(baseHue, 36) * 0.5;
        break;
      case "cool":
        baseHue += shortestHueDelta(baseHue, 210) * 0.5;
        break;
      case "dim":
        light *= 0.55;
        break;
      case "vivid":
        sat = Math.min(0.9, sat * 1.7);
        break;
      case "stark":
        sat = 0.2;
        light = 0.2;
        break;
    }

    // Weather tints the substrate — it outweighs mood, softly.
    switch (s.weather) {
      case "overcast":
        sat = 0.18;
        light = 0.5;
        break;
      case "rain":
        sat = 0.42;
        light = 0.44;
        break;
      case "storm":
        sat = 0.55;
        light = 0.36;
        break;
      case "snow":
        sat = 0.2;
        light = 0.68;
        break;
      case "fog":
        sat = 0.16;
        light = 0.58;
        break;
      case "clear":
        sat = Math.max(sat, 0.55);
        light = Math.max(light, 0.56);
        break;
    }

    // Topic tint: a real shift of the light's hue, since the light IS the color.
    if (s.topicStrength > 0.01) {
      const tinted = lerp(baseHue, s.topicHue, s.topicStrength);
      return { hue: tinted, sat: sat * 0.9, light };
    }
    return { hue: baseHue, sat, light };
  }

  // ---- rendering ------------------------------------------------------

  private loop(now: number): void {
    this.t += 1 / 60;
    this.raf = requestAnimationFrame(this.loop);

    const w = window.innerWidth;
    const h = window.innerHeight;
    const ctx = this.ctx;

    // Smooth every state field toward its target.
    const s = this.state;
    const t = this.target;
    for (const k of Object.keys(t) as Array<keyof Target>) {
      if (typeof t[k] === "number") {
        (s[k] as number) = lerp(s[k] as number, t[k] as number, SMOOTH);
      } else {
        (s[k] as unknown) = t[k]; // enums/weather swap discretely
      }
    }

    // The aura's color chases its target on its own clock (COLOR_SMOOTH,
    // slower than SMOOTH) and around the short side of the hue wheel — so
    // even an instant palette/weather swap lands as a slow bloom.
    const colorTarget = this.auraColor();
    const dh = shortestHueDelta(this.auraState.hue, colorTarget.hue);
    this.auraState.hue = (this.auraState.hue + dh * COLOR_SMOOTH + 360) % 360;
    this.auraState.sat = lerp(this.auraState.sat, colorTarget.sat, COLOR_SMOOTH);
    this.auraState.light = lerp(this.auraState.light, colorTarget.light, COLOR_SMOOTH);
    const hue = this.auraState.hue;
    const sat = this.auraState.sat;
    const light = this.auraState.light;
    const [ar, ag, ab] = hslToRGB(hue, sat, light);

    const homeX = w / 2;
    const homeY = this.orbCenterY(h);

    // Spring: the orb is elastic in size. Capped so it stays inside the
    // space the layout reserves for it — messages must never collide.
    const base =
      Math.min(
        140,
        Math.min(w, h) * 0.11 * (0.55 + (this.state.intensity ?? 0.5) * 0.5) + 40
      );
    const breath = Math.sin(this.t * (0.9 + this.state.moodEnergy * 1.3)) * 4;
    const rt =
      base * (0.88 + this.state.moodEnergy * 0.28) +
      breath;
    this.vr += (rt - this.r) * SPRING_K;
    this.vr *= SPRING_DAMP;
    this.r += this.vr;

    // Position: a second damped spring. Left alone the orb wanders on a
    // Lissajous path sized by its energy; it leans toward the cursor like
    // something curious, and pulse() startles it off the perch.
    const energy = s.moodEnergy;
    const wanderX =
      Math.sin(this.t * 0.17 + 0.8) * (6 + energy * 30) +
      Math.sin(this.t * 0.41) * (1.5 + energy * 4);
    const wanderY =
      Math.cos(this.t * 0.13) * (4 + energy * 16) +
      Math.cos(this.t * 0.37) * (1 + energy * 3);

    // Curiosity is chased slowly, so glancing the mouse around never
    // snaps the orb — it sways after it and loses interest just as slow.
    if (this.mouse && this.t - this.mouse.seen < 4) {
      this.leanX = lerp(this.leanX, clamp((this.mouse.x - homeX) * 0.08, -34, 34), 0.016);
      this.leanY = lerp(this.leanY, clamp((this.mouse.y - homeY) * 0.05, -20, 20), 0.016);
    } else {
      this.leanX = lerp(this.leanX, 0, 0.012);
      this.leanY = lerp(this.leanY, 0, 0.012);
    }

    const POS_K = 0.018;
    const POS_DAMP = 0.93;
    this.ovx += (wanderX + this.leanX - this.cxo) * POS_K;
    this.ovx *= POS_DAMP;
    this.ovy += (wanderY + this.leanY - this.cyo) * POS_K;
    this.ovy *= POS_DAMP;
    this.cxo += this.ovx;
    this.cyo += this.ovy;

    const cx = homeX + this.cxo;
    const cy = homeY + this.cyo;
    this.cx = cx;
    this.cy = cy;

    // Squash & stretch along the direction of travel — fast moves elongate
    // the orb, like something with mass hurrying.
    const speed = Math.hypot(this.ovx, this.ovy);
    const moveAngle = Math.atan2(this.ovy, this.ovx);
    const stretch = Math.min(0.14, speed / 260);

    // Background: a bright silvery ground, as if the room itself is lit.
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#edeef3");
    bg.addColorStop(1, "#dfdfe7");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // --- the color field: several hues orbit the orb, mymind-style ---
    // Each seed is a hue offset from the mood's base hue, parked at its own
    // angle around the light source and drifting slowly. Together they give
    // the light its range — pink here, amber there, lavender behind.
    const glow = 0.5 + this.state.intensity * 0.5;
    for (const seed of COLOR_SEEDS) {
      const hue2 = (hue + seed.hueOff + 360) % 360;
      const [sr, sg, sb] = hslToRGB(hue2, sat, light);
      const drift = Math.sin(this.t * seed.speed + seed.phase) * 0.35;
      const ang = seed.angle + drift;
      const dist = this.r * seed.dist;
      const sx = cx + Math.cos(ang) * dist;
      const sy = cy + Math.sin(ang) * dist;
      halo(
        ctx,
        sx, sy,
        this.r * seed.size,
        `rgba(${sr},${sg},${sb},${seed.alpha * glow})`
      );
    }

    // --- the light behind: halo layers, brightest at the rim ---

    // Wide soft aura: the room's ambient cast.
    halo(ctx, cx, cy, this.r * 7, `rgba(${ar},${ag},${ab},${0.2 * glow})`);
    // Mid halo.
    halo(ctx, cx, cy, this.r * 2.6, `rgba(${ar},${ag},${ab},${0.26 + 0.1 * sat})`);
    // Backlight: a hot disc hugging the orb — the light source itself.
    if (this.state.weather === "storm") {
      halo(ctx, cx, cy, this.r * 1.5, `rgba(${ar},${ag},${ab},${flicker(this.t) * 0.5})`);
    } else {
      halo(ctx, cx, cy, this.r * 1.5, `rgba(${ar},${ag},${ab},0.5)`);
    }

    // Weather, kept quiet.
    if (s.weather === "rain" || s.weather === "storm") this.drawRain(ctx, w, h);
    if (s.weather === "snow") this.drawSnow(ctx, w, h);
    if (s.weather === "fog") this.drawFog(ctx, w, h);
    if (s.weather === "storm") this.maybeFlash(ctx, w, h, ar, ag, ab);

    // --- the orb, white, translucent enough to show it's lit from behind ---
    // Everything below draws through the squash-stretch transform.

    // Wobble amplitude follows spring speed — elasticity you can see.
    const wob = Math.min(0.09, Math.abs(this.vr) / 900) + Math.sin(this.t * 0.6) * 0.006;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(moveAngle);
    ctx.scale(1 + stretch, 1 - stretch * 0.6);
    ctx.translate(-cx, -cy);

    // Rim glow first: light bleeding out around the silhouette.
    ctx.save();
    ctx.shadowColor = `rgba(${ar},${ag},${ab},0.9)`;
    ctx.shadowBlur = 60;
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    this.orbPath(ctx, cx, cy, this.r, wob);
    ctx.fill();
    ctx.restore();

    // Body: a white sphere, slightly graded so it reads as volume.
    const body = ctx.createRadialGradient(
      cx - this.r * 0.18, cy - this.r * 0.18, this.r * 0.1,
      cx, cy, this.r * 1.02
    );
    body.addColorStop(0, "rgba(255,255,255,0.98)");
    body.addColorStop(0.62, "rgba(252,253,255,0.94)");
    body.addColorStop(0.94, "rgba(244,246,252,0.88)");
    body.addColorStop(1, "rgba(255,255,255,0.65)");
    ctx.fillStyle = body;
    this.orbPath(ctx, cx, cy, this.r, wob);
    ctx.fill();

    // A breath of the ambient light soaking into the near edge.
    const inner = ctx.createRadialGradient(
      cx, cy, this.r * 0.2,
      cx, cy, this.r
    );
    inner.addColorStop(0, `rgba(${ar},${ag},${ab},0)`);
    inner.addColorStop(1, `rgba(${ar},${ag},${ab},${0.1 + sat * 0.12})`);
    ctx.fillStyle = inner;
    this.orbPath(ctx, cx, cy, this.r, wob);
    ctx.fill();

    // Thin specular kiss at the top — the light source is behind and above.
    const spec = ctx.createRadialGradient(
      cx - this.r * 0.25, cy - this.r * 0.3, 0,
      cx - this.r * 0.25, cy - this.r * 0.3, this.r * 0.55
    );
    spec.addColorStop(0, "rgba(255,255,255,0.5)");
    spec.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = spec;
    this.orbPath(ctx, cx, cy, this.r, wob);
    ctx.fill();

    ctx.restore(); // squash-stretch
  }

  /** Orb sits centered above the conversation, in the gap left by CSS. */
  private orbCenterY(h: number): number {
    const anchor = document.getElementById("orb-anchor");
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      if (rect.height > 0) return rect.top + rect.height / 2;
    }
    return h * 0.2;
  }

  private orbPath(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    wob: number
  ): void {
    const N = 72;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const w =
        1 +
        wob * Math.sin(a * 3 + this.t * 2.3) +
        wob * 0.5 * Math.sin(a * 5 - this.t * 1.4);
      const px = cx + Math.cos(a) * r * w;
      const py = cy + Math.sin(a) * r * w;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  private rainDrops: { x: number; y: number; len: number }[] = [];
  private snowFlakes: { x: number; y: number; s: number; drift: number }[] = [];

  private drawRain(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const count = this.state.weather === "storm" ? 80 : 44;
    while (this.rainDrops.length < count) {
      this.rainDrops.push({ x: Math.random() * w, y: Math.random() * h, len: 10 + Math.random() * 16 });
    }
    if (this.rainDrops.length > count) this.rainDrops.length = count;
    ctx.strokeStyle = "rgba(90, 100, 135, 0.14)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const d of this.rainDrops) {
      d.y += 12 + d.len * 0.35;
      d.x += 1.2;
      if (d.y > h + 30) {
        d.y = -30;
        d.x = Math.random() * w;
      }
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - 2, d.y + d.len);
    }
    ctx.stroke();
  }

  private drawSnow(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    while (this.snowFlakes.length < 60) {
      this.snowFlakes.push({ x: Math.random() * w, y: Math.random() * h, s: 0.8 + Math.random() * 1.8, drift: Math.random() * Math.PI * 2 });
    }
    if (this.snowFlakes.length > 70) this.snowFlakes.length = 70;
    ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
    for (const f of this.snowFlakes) {
      f.y += 0.35 + f.s * 0.22;
      f.x += Math.sin(this.t * 0.8 + f.drift) * 0.4;
      if (f.y > h + 5) {
        f.y = -5;
        f.x = Math.random() * w;
      }
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.s, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawFog(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    for (let i = 0; i < 3; i++) {
      const y = h * (0.2 + i * 0.3) + Math.sin(this.t * 0.1 + i * 2) * 30;
      const g = ctx.createLinearGradient(0, y - 80, 0, y + 80);
      g.addColorStop(0, "rgba(210, 214, 226, 0)");
      g.addColorStop(0.5, `rgba(210, 210, 220, ${0.05 + i * 0.015})`);
      g.addColorStop(1, "rgba(210, 210, 220, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, y - 80, w, 160);
    }
  }

  private maybeFlash(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    ar: number,
    ag: number,
    ab: number
  ): void {
    if (this.t - this.lastFlash > 5 + Math.random() * 7) {
      this.lastFlash = this.t;
      // A soft swell of the room's own light, not a strobe.
      const [lr, lg, lb] = lighten([ar, ag, ab]);
      ctx.fillStyle = `rgba(${lr},${lg},${lb},0.05)`;
      ctx.fillRect(0, 0, w, h);
    }
  }
}

// ---- small numeric helpers -------------------------------------------

function halo(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string
): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, transparent(color));
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

/** Same rgb, alpha 0. */
function transparent(color: string): string {
  const m = color.match(/rgba\((\d+),(\d+),(\d+),([\d.]+)\)/);
  if (!m) return "rgba(0,0,0,0)";
  return `rgba(${m[1]},${m[2]},${m[3]},0)`;
}

/** Flicker factor for storm light: layered sines, 0.5..1.1, no strobe. */
function flicker(t: number): number {
  return 0.62 + 0.14 * Math.sin(t * 6.7) * Math.sin(t * 2.3) + 0.1 * Math.sin(t * 11.1);
}

function lighten(c: RGB): RGB {
  return [
    Math.min(255, c[0] + 80),
    Math.min(255, c[1] + 80),
    Math.min(255, c[2] + 80),
  ];
}