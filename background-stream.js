import { Worker } from 'node:worker_threads';

const MAX_PENDING_PACKETS = 40;
const MAX_RESPONSE_BACKLOG = 48 * 1024;

export class BackgroundStream {
  clients = new Set();
  pending = 0;
  closed = false;

  constructor(onChange) {
    this.onChange = onChange;
    this.worker = new Worker(new URL('./background-encoder.js', import.meta.url));
    this.worker.on('message', ({ audio, consumed }) => {
      if (consumed) this.pending--;
      if (!audio) return;
      const frame = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
      for (const response of this.clients) {
        if (response.writableLength > MAX_RESPONSE_BACKLOG) response.destroy();
        else response.write(frame);
      }
    });
    this.worker.on('error', () => this.close());
    this.worker.on('exit', () => this.close());
  }

  add(response) {
    this.clients.add(response);
    response.on('close', () => {
      if (!this.clients.delete(response)) return;
      if (this.clients.size === 0) this.close();
      else this.onChange();
    });
    response.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      'Accept-Ranges': 'none',
    }).flushHeaders();
    this.onChange();
  }

  receive(packet) {
    if (this.closed || this.pending >= MAX_PENDING_PACKETS) return;
    this.pending++;
    this.worker.postMessage(packet);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const clients = [...this.clients];
    this.clients.clear();
    for (const response of clients) response.end();
    void this.worker.terminate();
    this.onChange();
  }
}
