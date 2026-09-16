// The animated orb (public/orb.js): a canvas blob whose silhouette and
// colour react to real audio levels, per the design notes §8.5.

const HILIGHT = '#FFE3BE';
const PEACH = '#FF9E5E';
const ACCENT = '#E8793D';
const ACCENT_DEEP = '#D9662F';
const LAVENDER = '#C9A7E0';
const COOL = '#B9C6E6';
const RING_RGBA = (a) => `rgba(232,121,61,${a})`;

const STATE_PARAMS = {
  idle: { breatheAmp: 0.03, freqScale: 1, levelAmp: 0.02, opacity: 0.9, ringScale: 1, satSpeed: 0.12, coolMix: 0 },
  listening: { breatheAmp: 0.02, freqScale: 1.6, levelAmp: 0.16, opacity: 1, ringScale: 0.94, satSpeed: 0.3, coolMix: 0 },
  thinking: { breatheAmp: 0.05, freqScale: 0.5, levelAmp: 0.0, opacity: 0.92, ringScale: 1.05, satSpeed: 0.18, coolMix: 0.4 },
  speaking: { breatheAmp: 0.035, freqScale: 2.2, levelAmp: 0.24, opacity: 1, ringScale: 1.14, satSpeed: 0.55, coolMix: 0 },
};

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

function blobPoints(cx, cy, baseRadius, time, level, params) {
  const N = 8;
  const points = [];
  for (let i = 0; i < N; i++) {
    const angle = (i / N) * Math.PI * 2;
    const freq1 = (0.6 + (i % 3) * 0.15) * params.freqScale;
    const freq2 = (1.3 + (i % 4) * 0.1) * params.freqScale;
    const phase = i * 1.7;
    const wobble = Math.sin(time * freq1 + phase) * 0.5 + Math.sin(time * freq2 + phase * 0.5) * 0.3;
    const breathe = params.breatheAmp * wobble;
    const levelBump = params.levelAmp * level * (0.6 + 0.4 * Math.sin(angle * 3 + time * 2.4));
    const r = baseRadius * (1 + breathe + levelBump);
    points.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
  }
  return points;
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
    this.dot1Angle = -0.9;
    this.dot2Angle = 2.6;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
    this._render(dt);
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
    // ring/halo multiplier so nothing ever gets hard-clipped by the canvas
    // edge — that clipping is what previously showed up as a visible
    // rectangular seam around the orb.
    const baseRadius = Math.min(w, h) * 0.32;
    const params = STATE_PARAMS[this.state];
    const level = this.reducedMotion ? 0 : this.level;
    const time = this.reducedMotion ? this.time * 0.25 : this.time;
    const breatheAmp = this.reducedMotion ? 0.02 : params.breatheAmp;
    const levelAmp = this.reducedMotion ? 0 : params.levelAmp;

    // --- halo -----------------------------------------------------------
    // A radial gradient fading to exactly zero alpha at haloR, entirely
    // inside the canvas — unlike a blurred fill, nothing ever bleeds past
    // haloR for the canvas edge to hard-clip.
    const haloR = baseRadius * 1.4;
    const halo = ctx.createRadialGradient(cx, cy, baseRadius * 0.4, cx, cy, haloR);
    halo.addColorStop(0, RING_RGBA(0.18));
    halo.addColorStop(1, RING_RGBA(0));
    ctx.save();
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // --- rings + satellites --------------------------------------------
    const ringMult = this.reducedMotion ? 1 : params.ringScale;
    const ring1r = baseRadius * 1.14 * ringMult;
    const ring2r = baseRadius * 1.28 * ringMult;
    ctx.save();
    ctx.lineWidth = Math.max(1, this.dpr);
    ctx.strokeStyle = RING_RGBA(0.28);
    ctx.beginPath();
    ctx.arc(cx, cy, ring1r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, ring2r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    if (this.state === 'thinking' && !this.reducedMotion) {
      const cyclePhase = (this.time % 0.9) / 0.9;
      ctx.save();
      ctx.strokeStyle = RING_RGBA(0.35 * (1 - cyclePhase));
      ctx.lineWidth = Math.max(1, this.dpr);
      ctx.beginPath();
      ctx.arc(cx, cy, baseRadius * (1 + 0.35 * cyclePhase), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    const satSpeed = this.reducedMotion ? 0.08 : params.satSpeed;
    this.dot1Angle += satSpeed * 0.033;
    this.dot2Angle -= satSpeed * 0.021;
    const dotR1 = Math.max(2, baseRadius * 0.045);
    const dotR2 = Math.max(1.5, baseRadius * 0.03);
    ctx.save();
    ctx.fillStyle = RING_RGBA(0.9);
    ctx.beginPath();
    ctx.arc(cx + Math.cos(this.dot1Angle) * ring1r, cy + Math.sin(this.dot1Angle) * ring1r, dotR1, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,200,158,0.9)';
    ctx.beginPath();
    ctx.arc(cx + Math.cos(this.dot2Angle) * ring2r, cy + Math.sin(this.dot2Angle) * ring2r, dotR2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // --- the blob body --------------------------------------------------
    const points = blobPoints(cx, cy, baseRadius, time, level, { ...params, breatheAmp, levelAmp });
    ctx.save();
    tracePath(ctx, points);
    ctx.clip();
    ctx.globalAlpha = params.opacity;

    const hx = cx - baseRadius * 0.32 + Math.cos(time * 0.7) * baseRadius * 0.04;
    const hy = cy - baseRadius * 0.38 + Math.sin(time * 0.9) * baseRadius * 0.04;
    const grad = ctx.createRadialGradient(hx, hy, 0, cx, cy, baseRadius * 1.2);
    const coolMix = this.reducedMotion ? 0 : params.coolMix;
    grad.addColorStop(0, mix(HILIGHT, COOL, coolMix * 0.5));
    grad.addColorStop(0.42, mix(PEACH, COOL, coolMix * 0.35));
    grad.addColorStop(0.78, mix(ACCENT, COOL, coolMix * 0.2));
    grad.addColorStop(1, mix(ACCENT_DEEP, COOL, coolMix * 0.15));
    ctx.fillStyle = grad;
    ctx.fillRect(cx - baseRadius * 1.3, cy - baseRadius * 1.3, baseRadius * 2.6, baseRadius * 2.6);

    const lavAlpha = this.state === 'speaking' ? 0.5 + level * 0.3 : 0.2 + level * 0.15;
    const lgrad = ctx.createRadialGradient(
      cx + baseRadius * 0.55, cy, 0,
      cx + baseRadius * 0.55, cy, baseRadius * 1.05,
    );
    lgrad.addColorStop(0, `rgba(201,167,224,${lavAlpha})`);
    lgrad.addColorStop(1, 'rgba(201,167,224,0)');
    ctx.fillStyle = lgrad;
    ctx.fillRect(cx - baseRadius * 1.3, cy - baseRadius * 1.3, baseRadius * 2.6, baseRadius * 2.6);

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

    const barCount = 28;
    const step = Math.max(1, Math.floor(data.length / barCount));
    const gap = w / barCount;
    const barWidth = Math.max(2, gap * 0.45);
    ctx.fillStyle = '#F6DECB';
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
