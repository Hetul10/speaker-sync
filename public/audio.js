import { boostSample, CHANNELS, HEADER_BYTES, PLAYBACK_BUFFERS, readPacket, SIGNAL_WINDOW_MS, SOUND_THRESHOLD, sourceChannel } from './protocol.js';

export const BUFFER_MS = PLAYBACK_BUFFERS[0];
const SCHEDULE_AHEAD_S = 0.085;
const MIN_LEAD_S = 0.008;
const MAX_RATE_ADJUSTMENT = 0.008;
const MAX_QUEUED_BLOCKS = 150;

export class RelayClock {
  samples = [];
  offset = 0;
  rtt = null;

  get ready() {
    return this.samples.length >= 3;
  }

  observe({ sent, received, replied }, now = performance.now()) {
    const rtt = now - sent - (replied - received);
    if (!Number.isFinite(rtt) || rtt < -1 || rtt > 1000) return;
    const offset = ((received - sent) + (replied - now)) / 2;
    this.samples.push({ rtt, offset, now });
    this.samples = this.samples.filter(sample => sample.now >= now - 16000).slice(-24);
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
    const target = best.map(sample => sample.offset).sort((a, b) => a - b)[Math.floor(best.length / 2)];
    this.offset = this.samples.length <= 3 ? target : this.offset + (target - this.offset) * 0.25;
    this.rtt = Math.round(Math.max(0, best[0].rtt));
  }
}

export function outputClock(context) {
  const stamp = context.getOutputTimestamp?.();
  if (stamp && stamp.performanceTime > 0 && Math.abs(performance.now() - stamp.performanceTime) < 500) {
    return stamp;
  }
  return {
    contextTime: context.currentTime,
    performanceTime: performance.now() + ((context.baseLatency ?? 0) + (context.outputLatency ?? 0)) * 1000,
  };
}

export function correctedDuration(duration, phaseError) {
  const adjust = Math.max(-MAX_RATE_ADJUSTMENT, Math.min(MAX_RATE_ADJUSTMENT, phaseError * 5));
  return duration * (1 + adjust);
}

export class Playback {
  lastReceived = -Infinity;
  lastScheduled = -Infinity;
  lastSound = -Infinity;

  constructor(context, clock) {
    this.context = context;
    this.clock = clock;
    this.gain = context.createGain();
    this.gain.connect(context.destination);
    this.queue = [];
    this.nodes = new Set();
    this.delay = 0;
    this.speaker = 'copy';
    this.volume = 1;
    this.late = 0;
    this.timer = setInterval(() => this.pump(), 15);
  }

  receive(data) {
    const block = readPacket(new DataView(data));
    if (!block) return;
    this.lastReceived = performance.now();
    if (!this.clock.ready || this.context.state !== 'running') return;
    if (this.queue.length >= MAX_QUEUED_BLOCKS) this.queue.shift();
    this.queue.push(block);
    this.pump();
  }

  status(now = performance.now()) {
    if (now - this.lastReceived >= SIGNAL_WINDOW_MS) return 'waiting';
    if (now - this.lastScheduled >= SIGNAL_WINDOW_MS) return 'receiving';
    return now - this.lastSound < SIGNAL_WINDOW_MS ? 'scheduled' : 'silent';
  }

  pump() {
    const { context } = this;
    if (context.state !== 'running' || !this.queue.length) return;
    const stamp = outputClock(context);
    const minStart = context.currentTime + MIN_LEAD_S;
    const horizon = context.currentTime + SCHEDULE_AHEAD_S;
    while (this.queue.length) {
      const block = this.queue[0];
      const target = stamp.contextTime + (block.time - this.clock.offset + this.delay - stamp.performanceTime) / 1000;
      if (target < minStart - 0.025) {
        this.queue.shift();
        this.late++;
        continue;
      }
      const contiguous = this.nextFrame === block.frame && this.nextSequence === block.sequence;
      // Keep adjacent buffers sample-contiguous. Re-anchor after gaps or large timing changes.
      const start = contiguous && this.nextTime >= minStart && Math.abs(target - this.nextTime) < 0.025
        ? this.nextTime : Math.max(target, this.nextTime ?? target);
      if (start > horizon) break;
      this.queue.shift();
      if (start < minStart) {
        this.late++;
        continue;
      }
      const duration = correctedDuration(block.frames / block.rate, target - start);
      const buffer = context.createBuffer(CHANNELS, block.frames, block.rate);
      let peak = 0;
      for (let channel = 0; channel < CHANNELS; channel++) {
        const samples = buffer.getChannelData(channel);
        const inputChannel = sourceChannel(this.speaker, channel);
        for (let i = 0; i < block.frames; i++) {
          const sample = block.packet.getInt16(HEADER_BYTES + (i * CHANNELS + inputChannel) * 2, true) / 32768;
          samples[i] = boostSample(sample, this.volume);
          peak = Math.max(peak, Math.abs(samples[i]));
        }
      }
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.playbackRate.value = buffer.duration / duration;
      node.connect(this.gain);
      this.nodes.add(node);
      node.onended = () => {
        this.nodes.delete(node);
        node.disconnect();
      };
      node.start(start);
      this.lastScheduled = performance.now();
      if (peak >= SOUND_THRESHOLD) this.lastSound = this.lastScheduled;
      this.nextTime = start + duration;
      this.nextFrame = block.frame + block.frames;
      this.nextSequence = (block.sequence + 1) >>> 0;
    }
  }

  reset() {
    for (const node of this.nodes) node.stop();
    this.queue.length = 0;
    this.nextTime = this.nextFrame = this.nextSequence = undefined;
    this.lastReceived = this.lastScheduled = this.lastSound = -Infinity;
    this.late = 0;
  }

  close() {
    this.reset();
    clearInterval(this.timer);
    this.gain.disconnect();
  }
}
