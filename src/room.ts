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

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
}

interface Target {
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
const SPRING_K = 0.085; // stiffness of the orb's radius spring
const SPRING_DAMP = 0.86; // velocity retained per frame — under 1, so it settles

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function lerpRGB(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
  ];
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
  private motes: Mote[] = [];
  private target: Target;
  private state: Target;
  private t = 0; // frame-time accumulator
  private raf = 0;
  private lastFlash = 0;

  // The orb itself: a spring on its radius, never drawn from a target directly.
  private r = 110;
  private vr = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;

    const start: Target = {
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
    for (let i = 0; i < 90; i++) this.motes.push(this.spawn());
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
  }

  // ---- color ----------------------------------------------------------

  /** The hue of the light behind the orb: mood bends it, topic tints it. */
  private auraColor(): { rgb: RGB; sat: number; light: number } {
    const s = this.state;
    const v = s.moodValence;
    const energy = s.moodEnergy;

    // Warm amber when valence is high, indigo when low — the light carries
    // the whole spectrum, so any hue is on the table.
    let baseHue = v > 0 ? lerp(210, 36, Math.min(1, v * 1.4)) : lerp(210, 262, Math.min(1, -v));
    let sat = lerp(0.3, 0.62, energy);
    let light = lerp(0.32, 0.6, v * 0.5 + 0.5);

    switch (s.palette) {
      case "warm":
        baseHue = baseHue > 90 ? baseHue : 36;
        break;
      case "cool":
        baseHue = baseHue < 180 ? 210 : baseHue;
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
        sat = 0.12;
        light = 0.34;
        break;
      case "rain":
        sat = 0.34;
        light = 0.26;
        break;
      case "storm":
        sat = 0.5;
        light = 0.18;
        break;
      case "snow":
        sat = 0.12;
        light = 0.52;
        break;
      case "fog":
        sat = 0.1;
        light = 0.44;
        break;
      case "clear":
        sat = Math.max(sat, 0.42);
        light = Math.max(light, 0.42);
        break;
    }

    // Topic tint: a real shift of the light's hue, since the light IS the color.
    if (s.topicStrength > 0.01) {
      const tinted = lerp(baseHue, s.topicHue, s.topicStrength);
      // Take the shorter path around the wheel toward the topic hue.
      const tint = hslToRGB(tinted, sat, light);
      return { rgb: tint, sat: sat * 0.9, light };
    }
    return { rgb: hslToRGB(baseHue, sat, light), sat, light };
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

    const { rgb: aura, sat, light } = this.auraColor();
    const [ar, ag, ab] = auraRGB(aura);

    const cx = w / 2;
    const cy = this.orbCenterY(h);

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

    // Background.
    ctx.fillStyle = "#09090e";
    ctx.fillRect(0, 0, w, h);

    // --- the light behind: three halo layers, brightest at the rim ---

    // Wide soft aura: the room's ambient cast.
    halo(ctx, cx, cy, this.r * 7, `rgba(${ar},${ag},${ab},${0.16 * (0.5 + sat + this.state.intensity)})`);
    // Mid halo.
    halo(ctx, cx, cy, this.r * 2.6, `rgba(${ar},${ag},${ab},${0.22 + 0.1 * sat})`);
    // Backlight: a hot disc hugging the orb — the light source itself.
    if (this.state.weather === "storm") {
      halo(ctx, cx, cy, this.r * 1.5, `rgba(${ar},${ag},${ab},${flicker(this.t) * 0.5})`);
    } else {
      halo(ctx, cx, cy, this.r * 1.5, `rgba(${ar},${ag},${ab},0.44)`);
    }

    // Dust motes, drawn behind the orb so they catch the light.
    this.updateAndDrawMotes(ctx, w, h, ar, ag, ab);

    // Weather, kept quiet.
    if (s.weather === "rain" || s.weather === "storm") this.drawRain(ctx, w, h);
    if (s.weather === "snow") this.drawSnow(ctx, w, h);
    if (s.weather === "fog") this.drawFog(ctx, w, h);
    if (s.weather === "storm") this.maybeFlash(ctx, w, h, ar, ag, ab);

    // --- the orb, white, translucent enough to show it's lit from behind ---

    // Wobble amplitude follows spring speed — elasticity you can see.
    const wob = Math.min(0.09, Math.abs(this.vr) / 900) + Math.sin(this.t * 0.6) * 0.006;

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

  private spawn(): Mote {
    const w = window.innerWidth;
    const h = window.innerHeight;
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      vx: 0,
      vy: 0,
      size: 0.5 + Math.random() * 1.4,
      alpha: 0.08 + Math.random() * 0.25,
    };
  }

  private updateAndDrawMotes(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    ar: number,
    ag: number,
    ab: number
  ): void {
    const s = this.state;
    const speed = 0.15 + s.dustEnergy * 1.4;
    const turbulence = s.drift === "gusts" ? 1.6 : s.drift === "breeze" ? 0.7 : 0.15;

    for (const p of this.motes) {
      const angle =
        Math.sin(p.x * 0.002 + this.t * 0.3) * turbulence +
        Math.cos(p.y * 0.0023 - this.t * 0.22) * turbulence;
      p.vx = p.vx * 0.9 + Math.cos(angle) * speed;
      p.vy = p.vy * 0.9 + Math.sin(angle) * speed - 0.03; // slow rise
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < -10) p.x = w + 10;
      if (p.x > w + 10) p.x = -10;
      if (p.y < -10) p.y = h + 10;
      if (p.y > h + 10) p.y = -10;

      // Motes brighten as they pass near the light.
      const dx = p.x - w / 2;
      const dy = p.y - this.orbCenterY(h);
      const near = Math.max(0, 1 - Math.hypot(dx, dy) / (this.r * 3.5));

      ctx.fillStyle = `rgba(${ar},${ag},${ab},${p.alpha * (0.5 + s.dustEnergy * 0.4) + near * 0.08})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private rainDrops: { x: number; y: number; len: number }[] = [];
  private snowFlakes: { x: number; y: number; s: number; drift: number }[] = [];

  private drawRain(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const count = this.state.weather === "storm" ? 80 : 44;
    while (this.rainDrops.length < count) {
      this.rainDrops.push({ x: Math.random() * w, y: Math.random() * h, len: 10 + Math.random() * 16 });
    }
    if (this.rainDrops.length > count) this.rainDrops.length = count;
    ctx.strokeStyle = "rgba(200, 210, 235, 0.16)";
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
    ctx.fillStyle = "rgba(235, 240, 250, 0.35)";
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

function auraRGB(c: RGB): RGB {
  return c;
}

function lighten(c: RGB): RGB {
  return [
    Math.min(255, c[0] + 80),
    Math.min(255, c[1] + 80),
    Math.min(255, c[2] + 80),
  ];
}