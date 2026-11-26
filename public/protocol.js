export const HEADER_BYTES = 28;
export const CHANNELS = 2;
export const SOUND_THRESHOLD = 0.001;
export const SIGNAL_WINDOW_MS = 2000;
export const PLAYBACK_STATES = ['waiting', 'receiving', 'silent', 'scheduled'];
export const ROOM_SOURCES = ['tab', 'window', 'desktop', 'click'];
export const SPEAKER_MODES = ['copy', 'left', 'right'];
export const HOSTED_BUFFER_MS = 350;
export const PLAYBACK_BUFFERS = [75, 125, 200, HOSTED_BUFFER_MS, 600];
export const PHONE_BOOST_DB = 3;

export function boostSample(sample, gain) {
  if (gain === 1) return sample;
  const value = sample * gain;
  const level = Math.abs(value);
  if (level <= 0.8) return value;
  return Math.sign(value) * (1 - 0.2 * Math.exp((0.8 - level) / 0.2));
}

export function sourceChannel(mode, outputChannel) {
  if (mode === 'left') return 0;
  if (mode === 'right') return 1;
  return outputChannel;
}
export const TUNE_SEPARATION_MS = 1150;
export const MAX_TUNE_OFFSET_MS = 600;
export const MAX_PACKET_BYTES = HEADER_BYTES + 4800 * CHANNELS * 2;

export function createPacket(sequence, frame, rate, frames) {
  const packet = new DataView(new ArrayBuffer(HEADER_BYTES + frames * CHANNELS * 2));
  packet.setUint32(0, sequence, true);
  packet.setFloat64(4, frame, true);
  packet.setUint32(20, rate, true);
  packet.setUint16(24, frames, true);
  packet.setUint16(26, 0x5353, true);
  return packet;
}

export function readPacket(packet) {
  if (packet.byteLength < HEADER_BYTES || packet.getUint16(26, true) !== 0x5353) return null;
  const sequence = packet.getUint32(0, true);
  const frame = packet.getFloat64(4, true);
  const time = packet.getFloat64(12, true);
  const rate = packet.getUint32(20, true);
  const frames = packet.getUint16(24, true);
  if (!Number.isSafeInteger(frame) || frame < 0 || !Number.isFinite(time)) return null;
  if (rate < 8000 || rate > 192000 || frames !== Math.round(rate / 100)) return null;
  if (packet.byteLength !== HEADER_BYTES + frames * CHANNELS * 2) return null;
  return { packet, sequence, frame, time, rate, frames };
}
