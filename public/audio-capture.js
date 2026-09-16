// Mic capture: getUserMedia -> AudioWorklet (16kHz PCM16 mono chunks) with an
// AnalyserNode branch for the real-time input level driving the orb.

function int16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export class AudioCapture {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.workletNode = null;
    this.analyser = null;
    this.onChunk = null;
  }

  async start(onChunk) {
    this.onChunk = onChunk;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 16000 },
    });

    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    await this.ctx.audioWorklet.addModule('/pcm-worklet.js');

    const source = this.ctx.createMediaStreamSource(this.stream);

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    source.connect(this.analyser);

    this.workletNode = new AudioWorkletNode(this.ctx, 'pcm-worklet');
    source.connect(this.workletNode);
    this.workletNode.port.onmessage = (event) => {
      const int16 = new Int16Array(event.data);
      if (this.onChunk) this.onChunk(int16ToBase64(int16));
    };
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

  getWaveformData() {
    if (!this.analyser) return null;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(data);
    return data;
  }

  stop() {
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
    }
    if (this.ctx) {
      this.ctx.close();
    }
    this.ctx = null;
    this.stream = null;
    this.workletNode = null;
    this.analyser = null;
  }
}
