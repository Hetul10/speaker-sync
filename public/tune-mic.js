class TuneMicrophone extends AudioWorkletProcessor {
  constructor() {
    super();
    this.stride = Math.max(1, Math.floor(sampleRate / 8000));
    this.port.onmessage = ({ data }) => {
      this.frame = data.frame;
      this.samples = new Float32Array(Math.ceil(data.seconds * sampleRate / this.stride));
      this.count = 0;
    };
  }

  process(inputs, outputs) {
    if (!this.samples) return true;
    const input = inputs[0]?.[0];
    const end = currentFrame + outputs[0][0].length;
    while (this.frame < end && this.count < this.samples.length) {
      this.samples[this.count++] = input?.[this.frame - currentFrame] ?? 0;
      this.frame += this.stride;
    }
    if (this.count === this.samples.length) {
      const samples = this.samples;
      this.samples = null;
      this.port.postMessage({ samples, rate: sampleRate / this.stride }, [samples.buffer]);
    }
    return true;
  }
}

registerProcessor('tune-mic', TuneMicrophone);
