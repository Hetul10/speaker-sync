import { CHANNELS, createPacket, HEADER_BYTES } from './protocol.js';

class CaptureProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    this.test = processorOptions.test;
    this.blockFrames = Math.round(sampleRate / 100);
    this.sequence = 0;
    this.offset = 0;
    this.testFrame = 0;
  }

  process(inputs, outputs) {
    const [left, right = left] = inputs[0] ?? [];
    for (let i = 0; i < outputs[0][0].length; i++) {
      if (this.offset === 0) {
        this.packet = createPacket(this.sequence++, currentFrame + i, sampleRate, this.blockFrames);
        this.peak = 0;
      }
      const clickPhase = this.testFrame++ % sampleRate;
      const click = this.test && clickPhase < sampleRate * 0.022
        ? 0.48 * Math.sin(2 * Math.PI * 1250 * clickPhase / sampleRate) * Math.exp(-clickPhase / (sampleRate * 0.004))
        : 0;
      const values = [this.test ? click : (left?.[i] ?? 0), this.test ? click : (right?.[i] ?? 0)];
      for (let channel = 0; channel < CHANNELS; channel++) {
        const sample = Math.max(-1, Math.min(1, values[channel]));
        this.peak = Math.max(this.peak, Math.abs(sample));
        this.packet.setInt16(HEADER_BYTES + (this.offset * CHANNELS + channel) * 2, sample * 32767, true);
      }
      if (++this.offset === this.blockFrames) {
        const pcm = this.packet.buffer;
        this.port.postMessage({ pcm, peak: this.peak }, [pcm]);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-pcm', CaptureProcessor);
