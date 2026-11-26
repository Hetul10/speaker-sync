import { parentPort } from 'node:worker_threads';
import { Mp3Encoder } from '@breezystack/lamejs';
import { boostSample, CHANNELS, HEADER_BYTES, PHONE_BOOST_DB, readPacket } from './public/protocol.js';

const rate = 48000;
const frameSize = 1152;
const encoder = new Mp3Encoder(CHANNELS, rate, 192);
const gain = 10 ** (PHONE_BOOST_DB / 20);
const left = new Int16Array(frameSize);
const right = new Int16Array(frameSize);
let size = 0;
let lastPacket = -Infinity;

function sample(l, r) {
  left[size] = boostSample(l / 32768, gain) * 32767;
  right[size++] = boostSample(r / 32768, gain) * 32767;
  if (size === frameSize) {
    const bytes = encoder.encodeBuffer(left, right);
    if (bytes.length) parentPort.postMessage({ audio: bytes }, [bytes.buffer]);
    size = 0;
  }
}

parentPort.on('message', bytes => {
  const packet = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const block = readPacket(packet);
  if (block) {
    lastPacket = performance.now();
    for (let i = 0, count = Math.round(block.frames * rate / block.rate); i < count; i++) {
      const position = i * block.rate / rate;
      const a = Math.floor(position);
      const b = Math.min(a + 1, block.frames - 1);
      const fraction = position - a;
      const low = HEADER_BYTES + a * 4;
      const high = HEADER_BYTES + b * 4;
      sample(packet.getInt16(low, true) * (1 - fraction) + packet.getInt16(high, true) * fraction,
        packet.getInt16(low + 2, true) * (1 - fraction) + packet.getInt16(high + 2, true) * fraction);
    }
  }
  parentPort.postMessage({ consumed: true });
});

// Keep the native player alive while the host picks a source or stops sharing.
setInterval(() => {
  if (performance.now() - lastPacket < 80) return;
  for (let i = 0; i < frameSize; i++) sample(0, 0);
}, frameSize * 1000 / rate);
