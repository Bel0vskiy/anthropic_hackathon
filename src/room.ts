import type { MoodReading } from "./mood";

// ---------------------------------------------------------------------------
// The Room: layered radial gradients + drifting particles on a 2D canvas.
// Nothing strobes: every visual property chases its target with exponential
// smoothing, and new mood readings only move the target if they clear a
// hysteresis threshold.
// ---------------------------------------------------------------------------

type RGB = [number, number, number];
type Weather = "clear" | "overcast" | "rain" | "storm" | "snow" | "fog" | null;
type Palette = "warm" | "cool" | "dim" | "vivid" | "stark";
type Drift = "still" | "breeze" | "gusts";
type Topic = string | null;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
}

interface Blob {
  x: number; // 0..1 anchor, slowly orbited over time
  y: number;
  r: number; // 0..1.5 relative radius
  color: RGB;
  huePhase: number;
}

interface Target {
  // mood-driven
  moodValence: number;
  moodEnergy: number;
  // tool-driven
  weather: Weather;
  palette: Palette;
  intensity: number;
  particleEnergy: number;
  drift: Drift;
  // topic tint
  topicHue: number; // 0..360
  topicStrength: number; // how strongly the topic tints the room
}

const MOOD_HYSTERESIS = 0.15;
const SMOOTH = 0.035; // fraction closed per frame toward target

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
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
  private particles: Particle[] = [];
  private blobs: Blob[] = [];
  private target: Target;
  private state: Target;
  private t = 0; // frame-time accumulator
  private raf = 0;
  private lastFlash = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;

    const start: Target = {
      moodValence: 0,
      moodEnergy: 0.4,
      weather: null,
      palette: "warm",
      intensity: 0.5,
      particleEnergy: 0.3,
      drift: "breeze",
      topicHue: 210,
      topicStrength: 0,
    };
    this.state = { ...start };
    this.target = { ...start };

    // Three soft gradient blobs: the room's light sources.
    this.blobs = [
      { x: 0.25, y: 0.3, r: 0.75, color: [30, 34, 60], huePhase: 0 },
      { x: 0.8, y: 0.6, r: 0.7, color: [40, 28, 48], huePhase: 2.1 },
      { x: 0.5, y: 1.0, r: 0.8, color: [16, 20, 34], huePhase: 4.2 },
    ];

    this.resize();
    window.addEventListener("resize", () => this.resize());
    for (let i = 0; i < 120; i++) this.particles.push(this.spawn());
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
  }

  setRoom(room: {
    palette?: string;
    intensity?: number;
    weather?: string;
    particleEnergy?: number;
    drift?: string;
  }): void {
    if (room.palette) {
      this.target.palette = room.palette as Palette;
      this.target.particleEnergy = this.target.particleEnergy; // unchanged
    }
    if (typeof room.intensity === "number") {
      this.target.intensity = room.intensity;
    }
    if (room.weather) {
      this.target.weather = room.weather as Weather;
    }
    if (typeof room.particleEnergy === "number") {
      this.target.particleEnergy = room.particleEnergy;
    }
    if (room.drift) {
      this.target.drift = room.drift as Drift;
    }
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
    this.target.topicStrength = 0.22;
  }

  // ---- rendering ------------------------------------------------------

  /** The palette mood+weather+light together imply, per frame. */
  private roomColors(): RGB[] {
    const s = this.state;
    const v = s.moodValence;
    const energy = s.moodEnergy;

    // Base hue: warm range when valence is high, indigo/blue when low.
    let baseHue = v > 0 ? lerp(210, 38, Math.min(1, v * 1.4)) : lerp(210, 255, Math.min(1, -v));
    let sat = lerp(0.25, 0.55, energy);
    let light = lerp(0.28, 0.55, v * 0.5 + 0.5);
    let contrast = 1; // intensity multiplier from the light tool

    // The light tool bends the base scheme before weather applies its weight.
    switch (s.palette) {
      case "warm":
        baseHue = baseHue > 90 ? baseHue : 38;
        break;
      case "cool":
        baseHue = baseHue < 180 ? 210 : baseHue;
        break;
      case "dim":
        light *= 0.5;
        contrast = 0.6;
        break;
      case "vivid":
        sat = Math.min(0.85, sat * 1.7);
        break;
      case "stark":
        sat = 0.18;
        light = 0.18;
        contrast = 1.4;
        break;
    }

    // Weather overrides the scheme entirely — substrate beats mood.
    switch (s.weather) {
      case "overcast":
        sat = 0.12;
        light = 0.3;
        break;
      case "rain":
        sat = 0.3;
        light = 0.24;
        break;
      case "storm":
        sat = 0.45;
        light = 0.16;
        break;
      case "snow":
        sat = 0.1;
        light = 0.5;
        break;
      case "fog":
        sat = 0.08;
        light = 0.42;
        break;
      case "clear":
        sat = Math.max(sat, 0.4);
        light = Math.max(light, 0.4);
        break;
    }

    const intensity = (0.4 + s.intensity * 1.2) * contrast;
    const cs = (mul: number) => Math.min(1, sat * mul);

    const c1 = hslToRGB(baseHue, cs(1), Math.min(0.8, light * intensity));
    const c2 = hslToRGB(baseHue + 40, cs(0.8), Math.min(0.7, light * intensity * 0.8));
    const c3 = hslToRGB(baseHue - 30, cs(0.7), Math.min(0.6, light * intensity * 0.55));

    // Topic tint: blend a low-strength hue shift into the light colors.
    if (s.topicStrength > 0.01) {
      const tint = hslToRGB(s.topicHue, 0.5, light * intensity * 0.7);
      return [
        lerpRGB(c1, tint, s.topicStrength * 0.35),
        lerpRGB(c2, tint, s.topicStrength * 0.2),
        lerpRGB(c3, tint, s.topicStrength * 0.1),
      ];
    }
    return [c1, c2, c3];
  }

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

    const colors = this.roomColors();

    // Dark base.
    ctx.fillStyle = "#0a0b10";
    ctx.fillRect(0, 0, w, h);

    // Blob anchors drift on slow orbits.
    const lightScale = 0.5 + s.intensity * 0.5;
    this.blobs.forEach((blob, i) => {
      const ox = blob.x + Math.sin(this.t * 0.05 + blob.huePhase) * 0.06;
      const oy = blob.y + Math.cos(this.t * 0.04 + blob.huePhase) * 0.05;
      const r = blob.r * Math.max(w, h) * lightScale;
      const [cr, cg, cb] = colors[i];
      const g = ctx.createRadialGradient(
        ox * w, oy * h, 0,
        ox * w, oy * h, r
      );
      const alpha = s.weather === "fog" || s.weather === "overcast" ? 0.75 : 0.55;
      g.addColorStop(0, `rgba(${cr},${cg},${cb},${alpha})`);
      g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    });

    // Particles.
    this.updateAndDrawParticles(ctx, w, h, colors);

    // Weather overlays.
    if (s.weather === "rain" || s.weather === "storm") this.drawRain(ctx, w, h);
    if (s.weather === "snow") this.drawSnow(ctx, w, h);
    if (s.weather === "fog") this.drawFog(ctx, w, h);
    if (s.weather === "storm") this.maybeFlash(ctx, w, h);
  }

  private spawn(): Particle {
    const w = window.innerWidth;
    const h = window.innerHeight;
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      vx: 0,
      vy: 0,
      size: 0.6 + Math.random() * 1.8,
      alpha: 0.15 + Math.random() * 0.35,
    };
  }

  private updateAndDrawParticles(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    colors: RGB[]
  ): void {
    const s = this.state;
    const speed = 0.2 + s.particleEnergy * 1.8;
    const turbulence = s.drift === "gusts" ? 1.6 : s.drift === "breeze" ? 0.7 : 0.15;

    ctx.save();
    for (const p of this.particles) {
      // Cheap flow field: angle from layered sines — smooth, deterministic.
      const angle =
        Math.sin(p.x * 0.002 + this.t * 0.3) * turbulence +
        Math.cos(p.y * 0.0023 - this.t * 0.22) * turbulence;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed + (s.weather === "rain" ? 2.5 : 0);

      p.x += p.vx;
      p.y += p.vy;
      if (p.x < -10) p.x = w + 10;
      if (p.x > w + 10) p.x = -10;
      if (p.y < -10) p.y = h + 10;
      if (p.y > h + 10) p.y = -10;

      const [cr, cg, cb] = colors[0];
      ctx.fillStyle = `rgba(${Math.min(255, cr + 90)},${Math.min(255, cg + 90)},${Math.min(255, cb + 100)},${p.alpha * (0.5 + s.moodEnergy * 0.5)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private rainDrops: { x: number; y: number; len: number }[] = [];
  private snowFlakes: { x: number; y: number; s: number; drift: number }[] = [];

  private drawRain(ctx: CanvasRenderingContext2D, w: number, _h: number): void {
    const count = this.state.weather === "storm" ? 90 : 50;
    while (this.rainDrops.length < count) {
      this.rainDrops.push({ x: Math.random() * w, y: Math.random() * _h, len: 12 + Math.random() * 18 });
    }
    if (this.rainDrops.length > count) this.rainDrops.length = count;
    ctx.strokeStyle = "rgba(180, 200, 230, 0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const d of this.rainDrops) {
      d.y += 14 + d.len * 0.4;
      d.x += 1.5;
      if (d.y > _h + 30) {
        d.y = -30;
        d.x = Math.random() * w;
      }
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - 2, d.y + d.len);
    }
    ctx.stroke();
  }

  private drawSnow(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    while (this.snowFlakes.length < 70) {
      this.snowFlakes.push({ x: Math.random() * w, y: Math.random() * h, s: 1 + Math.random() * 2.2, drift: Math.random() * Math.PI * 2 });
    }
    if (this.snowFlakes.length > 70) this.snowFlakes.length = 70;
    ctx.fillStyle = "rgba(235, 240, 250, 0.5)";
    for (const f of this.snowFlakes) {
      f.y += 0.4 + f.s * 0.25;
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
      g.addColorStop(0, "rgba(200, 205, 215, 0)");
      g.addColorStop(0.5, `rgba(200, 205, 215, ${0.06 + i * 0.02})`);
      g.addColorStop(1, "rgba(200, 205, 215, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, y - 80, w, 160);
    }
  }

  private maybeFlash(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (this.t - this.lastFlash > 4 + Math.random() * 6) {
      this.lastFlash = this.t;
      ctx.fillStyle = "rgba(220, 225, 255, 0.14)";
      ctx.fillRect(0, 0, w, h);
    }
  }
}