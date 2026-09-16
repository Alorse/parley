// Gapless playback of 24kHz PCM16 mono audio from the tutor, with a small
// look-ahead queue and a GainNode -> AnalyserNode chain for the real-time
// playback level driving the orb while speaking.

const SOURCE_SAMPLE_RATE = 24000;
const LOOKAHEAD_SECONDS = 0.12;

function base64ToInt16(base64) {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

function resampleFloat(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    output[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return output;
}

export class AudioPlayer {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.analyser = null;
    this.nextStartTime = 0;
    this.activeSources = [];
  }

  async ensureContext() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    try {
      this.ctx = new Ctx({ sampleRate: SOURCE_SAMPLE_RATE });
    } catch {
      this.ctx = new Ctx();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.gain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.gain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.nextStartTime = this.ctx.currentTime + LOOKAHEAD_SECONDS;
  }

  getLevel() {
    if (!this.analyser) return 0;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / data.length);
  }

  async enqueuePcm16(base64Data) {
    await this.ensureContext();
    const int16 = base64ToInt16(base64Data);
    let floatData = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) floatData[i] = int16[i] / 32768;

    const ctxRate = this.ctx.sampleRate;
    if (ctxRate !== SOURCE_SAMPLE_RATE) {
      floatData = resampleFloat(floatData, SOURCE_SAMPLE_RATE, ctxRate);
    }
    if (floatData.length === 0) return;

    const buffer = this.ctx.createBuffer(1, floatData.length, ctxRate);
    buffer.copyToChannel(floatData, 0);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);

    const startAt = Math.max(this.nextStartTime, this.ctx.currentTime + LOOKAHEAD_SECONDS);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;

    this.activeSources.push(source);
    source.onended = () => {
      this.activeSources = this.activeSources.filter((s) => s !== source);
    };
  }

  flush() {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    this.activeSources = [];
    if (this.ctx) this.nextStartTime = this.ctx.currentTime;
    return Promise.resolve();
  }
}
