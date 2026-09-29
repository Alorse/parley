// Mic capture: getUserMedia -> AudioWorklet (16kHz PCM16 mono chunks) with an
// AnalyserNode branch for the real-time input level driving the orb.
//
// At most one pipeline exists at a time (#18): a start() while one is already
// running or still opening joins it instead of opening a second mic, and a
// stop() that lands while the mic is still opening releases whatever that
// start() acquires, so "off" is really off.

function releaseMic(stream, ctx) {
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
  }
  if (ctx) ctx.close();
}

export class AudioCapture {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.workletNode = null;
    this.analyser = null;
    this.onChunk = null;
    /** @type {Promise<boolean> | null} */
    this._opening = null;
    // Bumped by every stop(), so an open still in flight knows it was
    // cancelled.
    this._generation = 0;
  }

  /**
   * Opens the mic, or joins the pipeline that is already open or opening.
   * @returns {Promise<boolean>} true if the mic is open, false if stop() was
   *   called before it finished opening.
   */
  start(onChunk) {
    this.onChunk = onChunk;
    if (this.stream) return Promise.resolve(true);
    if (!this._opening) {
      const generation = this._generation;
      this._opening = this._open(generation).finally(() => {
        if (generation === this._generation) this._opening = null;
      });
    }
    return this._opening;
  }

  async _open(generation) {
    let stream = null;
    let ctx = null;
    const cancelled = () => {
      if (generation === this._generation) return false;
      releaseMic(stream, ctx);
      return true;
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 16000 },
      });
      if (cancelled()) return false;

      const Ctx = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
      ctx = new Ctx();
      if (ctx.state === 'suspended') await ctx.resume();
      await ctx.audioWorklet.addModule('/pcm-worklet.js');
      if (cancelled()) return false;
    } catch (err) {
      releaseMic(stream, ctx);
      throw err;
    }

    const source = ctx.createMediaStreamSource(stream);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const workletNode = new AudioWorkletNode(ctx, 'pcm-worklet');
    source.connect(workletNode);
    // Each chunk is the worklet's PCM16 ArrayBuffer, sent to the server as
    // it is (#24).
    workletNode.port.onmessage = (event) => {
      if (this.onChunk) this.onChunk(event.data);
    };

    this.stream = stream;
    this.ctx = ctx;
    this.analyser = analyser;
    this.workletNode = workletNode;
    return true;
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
    this._generation += 1;
    this._opening = null;
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
    }
    releaseMic(this.stream, this.ctx);
    this.ctx = null;
    this.stream = null;
    this.workletNode = null;
    this.analyser = null;
  }
}
