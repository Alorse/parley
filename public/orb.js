// The voice — Parley's hero visual (public/orb.js). An asymmetric, organic
// form (never a uniform circle, never orbited by anything) rendered as
// soft ink diffusing through water: a closed spline through unevenly
// spaced points, filled with a slowly turning multi-hue gradient, glowing
// brighter from within as real audio levels rise. See DESIGN.md.

const GOLD = '#F0B860';
const EMBER = '#E2637A';
const VIOLET = '#8571C4';
const CORE_LIGHT = '#FFEFD9';
const HALO_RGBA = (a) => `rgba(226,99,122,${a})`;

const STATE_PARAMS = {
  idle: { breatheAmp: 0.05, freqScale: 0.7, levelAmp: 0.02, coolMix: 0, coreBase: 0.22, haloBase: 0.12, swirl: 0.04, contract: 0 },
  listening: { breatheAmp: 0.03, freqScale: 1.3, levelAmp: 0.14, coolMix: 0, coreBase: 0.32, haloBase: 0.15, swirl: 0.08, contract: 0.05 },
  thinking: { breatheAmp: 0.06, freqScale: 0.5, levelAmp: 0, coolMix: 0.6, coreBase: 0.26, haloBase: 0.14, swirl: 0.4, contract: 0 },
  speaking: { breatheAmp: 0.045, freqScale: 1.9, levelAmp: 0.2, coolMix: 0, coreBase: 0.55, haloBase: 0.22, swirl: 0.16, contract: 0 },
};

// The seven base multipliers are deliberately uneven — this is what keeps
// the form asymmetric ("an ink blot, not a sun") even at rest with zero
// audio level. A small per-load jitter is added on top so every session
// has a subtly unique silhouette without losing the underlying character.
const BASE_LOBES = [1.0, 0.7, 1.16, 0.82, 1.05, 0.62, 0.93];

function mix(c1, c2, t) {
  const a = parseInt(c1.slice(1), 16);
  const b = parseInt(c2.slice(1), 16);
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const t2 = Math.max(0, Math.min(1, t));
  const r = Math.round(ar + (br - ar) * t2);
  const g = Math.round(ag + (bg - ag) * t2);
  const bl = Math.round(ab + (bb - ab) * t2);
  return `rgb(${r},${g},${bl})`;
}

function tracePath(ctx, points) {
  const n = points.length;
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const m0 = mid(points[n - 1], points[0]);
  ctx.beginPath();
  ctx.moveTo(m0.x, m0.y);
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const next = points[(i + 1) % n];
    const m = mid(p, next);
    ctx.quadraticCurveTo(p.x, p.y, m.x, m.y);
  }
  ctx.closePath();
}

export class Orb {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = 'idle';
    this.level = 0;
    this.rawLevel = 0;
    this.time = 0;
    this.running = false;
    this.raf = null;
    this.lastFrame = 0;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Per-load asymmetry: the fixed lobe shape plus a small unique jitter.
    this.lobes = BASE_LOBES.map((v) => v + (Math.random() - 0.5) * 0.1);
    this.phases = BASE_LOBES.map(() => Math.random() * Math.PI * 2);

    this._resize = this._resize.bind(this);
    this._resize();
    window.addEventListener('resize', this._resize);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pause();
      else this.resume();
    });
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.dpr = dpr;
  }

  setState(state) {
    if (STATE_PARAMS[state]) this.state = state;
  }

  setLevel(level) {
    this.rawLevel = Math.max(0, Math.min(1, level || 0));
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    const loop = (t) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (t - this.lastFrame) / 1000);
      this.lastFrame = t;
      this._tick(dt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  pause() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  resume() {
    if (!document.hidden) this.start();
  }

  _tick(dt) {
    this.time += dt;
    const rate = this.rawLevel > this.level ? 0.5 : 0.08;
    this.level += (this.rawLevel - this.level) * rate;
    this._render();
  }

  _blobPoints(cx, cy, baseRadius, time, level, params) {
    const n = this.lobes.length;
    const points = [];
    const contraction = 1 - params.contract * level;
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2;
      const freq1 = (0.5 + (i % 3) * 0.13) * params.freqScale;
      const freq2 = (1.1 + (i % 4) * 0.09) * params.freqScale;
      const wobble = Math.sin(time * freq1 + this.phases[i]) * 0.5 + Math.sin(time * freq2 + this.phases[i] * 0.6) * 0.3;
      const breathe = params.breatheAmp * wobble;
      const levelBump = params.levelAmp * level * (0.6 + 0.4 * Math.sin(angle * 2.3 + time * 2.1 + this.phases[i]));
      const lobe = this.lobes[i];
      const r = baseRadius * lobe * contraction * (1 + breathe + levelBump);
      points.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
    }
    return points;
  }

  _render() {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (w === 0 || h === 0) return;

    const cx = w / 2;
    const cy = h / 2;
    // Kept comfortably under 0.5 (half the canvas) at every state's max
    // extent so nothing is ever hard-clipped by the canvas edge.
    const baseRadius = Math.min(w, h) * 0.3;
    const params = STATE_PARAMS[this.state];
    const level = this.reducedMotion ? 0 : this.level;
    const time = this.reducedMotion ? this.time * 0.2 : this.time;
    const breatheAmp = this.reducedMotion ? 0.025 : params.breatheAmp;
    const levelAmp = this.reducedMotion ? 0 : params.levelAmp;
    const coolMix = this.reducedMotion ? 0 : params.coolMix;

    // The gradient centre slowly turns around the shape — visible "thinking"
    // as ink swirling, always present at a whisper even at rest.
    const swirlSpeed = this.reducedMotion ? 0.03 : 0.12 + params.swirl * 0.5;
    const swirlAngle = time * swirlSpeed;
    const gx = cx + Math.cos(swirlAngle) * baseRadius * 0.32;
    const gy = cy + Math.sin(swirlAngle * 0.85) * baseRadius * 0.32;

    // --- halo: a radial gradient fading to exact zero alpha well inside
    // the canvas, so nothing can bleed past it for the edge to clip -------
    const haloR = baseRadius * 1.42;
    const haloAlpha = params.haloBase + level * 0.18;
    const halo = ctx.createRadialGradient(cx, cy, baseRadius * 0.35, cx, cy, haloR);
    halo.addColorStop(0, HALO_RGBA(haloAlpha));
    halo.addColorStop(1, HALO_RGBA(0));
    ctx.save();
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // --- the voice: an asymmetric organic body, no rings, no satellites --
    const points = this._blobPoints(cx, cy, baseRadius, time, level, { ...params, breatheAmp, levelAmp });
    ctx.save();
    tracePath(ctx, points);
    ctx.clip();

    const grad = ctx.createRadialGradient(gx, gy, 0, cx, cy, baseRadius * 1.25);
    grad.addColorStop(0, mix(GOLD, VIOLET, coolMix * 0.45));
    grad.addColorStop(0.4, mix(GOLD, EMBER, 1 - coolMix * 0.6));
    grad.addColorStop(0.72, mix(EMBER, VIOLET, 0.35 + coolMix * 0.35));
    grad.addColorStop(1, VIOLET);
    ctx.fillStyle = grad;
    ctx.fillRect(cx - baseRadius * 1.3, cy - baseRadius * 1.3, baseRadius * 2.6, baseRadius * 2.6);

    // A brighter core near the highlight point, glowing more as the level
    // rises — the voice literally lighting up from within as it speaks.
    const coreAlpha = Math.min(1, params.coreBase + level * 0.5);
    const core = ctx.createRadialGradient(gx, gy, 0, gx, gy, baseRadius * 0.8);
    core.addColorStop(0, `${CORE_LIGHT}`);
    core.addColorStop(1, 'rgba(255,239,217,0)');
    ctx.save();
    ctx.globalAlpha = coreAlpha;
    ctx.fillStyle = core;
    ctx.fillRect(cx - baseRadius * 1.3, cy - baseRadius * 1.3, baseRadius * 2.6, baseRadius * 2.6);
    ctx.restore();

    ctx.restore();
  }
}

// Slim waveform of the learner's mic (bars from a real AnalyserNode).
export class MicWaveform {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.running = false;
    this.raf = null;
    this._resize = this._resize.bind(this);
    this._resize();
    window.addEventListener('resize', this._resize);
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }

  start(getData) {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this._draw(getData());
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  _draw(data) {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!data || !data.length) return;

    const barCount = 26;
    const step = Math.max(1, Math.floor(data.length / barCount));
    const gap = w / barCount;
    const barWidth = Math.max(2, gap * 0.45);
    ctx.fillStyle = 'rgba(226,99,122,0.4)';
    for (let i = 0; i < barCount; i++) {
      let sum = 0;
      for (let j = 0; j < step; j++) {
        const idx = i * step + j;
        sum += Math.abs((data[idx] || 128) - 128) / 128;
      }
      const amp = Math.min(1, (sum / step) * 3.2);
      const barH = Math.max(h * 0.08, amp * h);
      const x = i * gap + (gap - barWidth) / 2;
      ctx.fillRect(x, (h - barH) / 2, barWidth, barH);
    }
  }
}
