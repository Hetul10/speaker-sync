import { outputClock } from './audio.js';
import { MAX_TUNE_OFFSET_MS, TUNE_SEPARATION_MS } from './protocol.js';

const TONE_SECONDS = 0.055;

export function chirp(t) {
  const phase = 1050 * t + ((2750 - 1050) / (2 * TONE_SECONDS)) * t * t;
  return 0.42 * Math.sin(2 * Math.PI * phase) * Math.sin(Math.PI * t / TONE_SECONDS) ** 2;
}

export function audioTime(context, clock, relayTime) {
  const stamp = outputClock(context);
  return stamp.contextTime + (relayTime - clock.offset - stamp.performanceTime) / 1000;
}

export function playTone(context, clock, relayTime) {
  const start = audioTime(context, clock, relayTime);
  if (context.state !== 'running' || start < context.currentTime + 0.025) throw new Error('The speaker could not schedule its test tone.');
  const buffer = context.createBuffer(1, Math.round(context.sampleRate * TONE_SECONDS), context.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let index = 0; index < samples.length; index++) samples[index] = chirp(index / context.sampleRate);
  const node = context.createBufferSource();
  node.buffer = buffer;
  node.connect(context.destination);
  node.onended = () => node.disconnect();
  node.start(start);
  return { node, start };
}

function findTone(samples, template, expected, rate) {
  const first = Math.max(0, Math.floor(expected - rate * 0.14));
  const last = Math.min(samples.length - template.length, Math.ceil(expected + rate * 0.75));
  const templateEnergy = template.reduce((sum, sample) => sum + sample * sample, 0);
  let best = 0;
  let found = -1;
  for (let position = first; position <= last; position++) {
    let similarity = 0;
    let energy = 0;
    for (let index = 0; index < template.length; index++) {
      const sample = samples[position + index];
      similarity += sample * template[index];
      energy += sample * sample;
    }
    if (energy < template.length * 0.000001) continue;
    const score = Math.abs(similarity) / Math.sqrt(energy * templateEnergy);
    if (score > best) {
      best = score;
      found = position;
    }
  }
  return best >= 0.32 ? found : -1;
}

export function measureOffset(samples, rate, expectedLaptopSample) {
  const template = Float32Array.from({ length: Math.round(rate * TONE_SECONDS) }, (_, i) => chirp(i / rate));
  const gap = TUNE_SEPARATION_MS * rate / 1000;
  const laptop = findTone(samples, template, expectedLaptopSample, rate);
  const phone = findTone(samples, template, expectedLaptopSample + gap, rate);
  if (laptop < 0 || phone < 0) return null;
  const offset = Math.round((phone - laptop - gap) * 1000 / rate);
  return Math.abs(offset) <= MAX_TUNE_OFFSET_MS ? offset : null;
}

export async function captureTones(context, microphone, signal) {
  await context.audioWorklet.addModule('/tune-mic.js');
  signal.throwIfAborted();
  const input = context.createMediaStreamSource(microphone);
  const worklet = new AudioWorkletNode(context, 'tune-mic', { outputChannelCount: [1] });
  input.connect(worklet);
  worklet.connect(context.destination); // The microphone is never audible or sent to the relay.
  let finish;
  let closed = false;
  const recording = new Promise(resolve => {
    finish = resolve;
    worklet.port.onmessage = ({ data }) => resolve(data);
    worklet.onprocessorerror = () => resolve(null);
  });
  return {
    recording,
    start(frame, seconds) { worklet.port.postMessage({ frame, seconds }); },
    close() {
      if (closed) return;
      closed = true;
      finish(null);
      worklet.port.close();
      input.disconnect();
      worklet.disconnect();
    },
  };
}
