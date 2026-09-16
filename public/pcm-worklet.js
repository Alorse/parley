// AudioWorkletProcessor: accumulates 128-sample input blocks (at whatever
// rate the AudioContext actually runs), resamples them to 16kHz mono via
// linear interpolation, and posts Int16Array chunks of 512 samples.
class PCMWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 16000;
    this.resampleRatio = sampleRate / this.targetSampleRate;
    this.outChunkSize = 512;
    this.carry = new Float32Array(0);
    this.pending = [];
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;
    const channelData = input[0];

    const combined = new Float32Array(this.carry.length + channelData.length);
    combined.set(this.carry, 0);
    combined.set(channelData, this.carry.length);

    const outLength = Math.max(0, Math.floor((combined.length - 1) / this.resampleRatio) + 1);
    const resampled = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const srcPos = i * this.resampleRatio;
      const i0 = Math.floor(srcPos);
      const i1 = Math.min(i0 + 1, combined.length - 1);
      const frac = srcPos - i0;
      resampled[i] = combined[i0] * (1 - frac) + combined[i1] * frac;
    }

    const consumedSrcLength = outLength * this.resampleRatio;
    this.carry = combined.slice(Math.floor(consumedSrcLength));

    for (let i = 0; i < resampled.length; i++) this.pending.push(resampled[i]);

    while (this.pending.length >= this.outChunkSize) {
      const chunk = this.pending.splice(0, this.outChunkSize);
      const int16 = new Int16Array(this.outChunkSize);
      for (let i = 0; i < this.outChunkSize; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        int16[i] = s < 0 ? s * 32768 : s * 32767;
      }
      this.port.postMessage(int16.buffer, [int16.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-worklet', PCMWorkletProcessor);
