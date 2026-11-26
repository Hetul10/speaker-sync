import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { pathToFileURL } from 'node:url';
import QRCode from 'qrcode';
import { WebSocketServer, WebSocket } from 'ws';
import { httpsOrigin } from './origin.js';
import { BackgroundStream } from './background-stream.js';
import { HOSTED_BUFFER_MS, MAX_PACKET_BYTES, MAX_TUNE_OFFSET_MS, PLAYBACK_BUFFERS, PLAYBACK_STATES, readPacket, ROOM_SOURCES, SPEAKER_MODES, TUNE_SEPARATION_MS } from './public/protocol.js';

const ROOM_ID = /^[a-f0-9]{32}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_LISTENERS = 8;
const MAX_HOSTED_ROOMS = 32;
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/audio.js', ['audio.js', 'text/javascript; charset=utf-8']],
  ['/capture.js', ['capture.js', 'text/javascript; charset=utf-8']],
  ['/protocol.js', ['protocol.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/tune.js', ['tune.js', 'text/javascript; charset=utf-8']],
  ['/tune-mic.js', ['tune-mic.js', 'text/javascript; charset=utf-8']],
]);

function lanAddresses() {
  return Object.entries(networkInterfaces())
    .sort(([a], [b]) => Number(/wi-?fi|wireless|wlan/i.test(b)) - Number(/wi-?fi|wireless|wlan/i.test(a)))
    .flatMap(([name, interfaces]) => interfaces
      .filter(({ family, internal }) => family === 'IPv4' && !internal)
      .map(({ address }) => ({ name, address })));
}

export function createRelay({ lanHost = process.env.LAN_HOST, frontendOrigin = process.env.FRONTEND_ORIGIN, dev = false } = {}) {
  const hostedOrigin = frontendOrigin === undefined ? '' : httpsOrigin(frontendOrigin, 'FRONTEND_ORIGIN');
  const devRevision = dev ? randomBytes(8).toString('hex') : null;
  const rooms = new Map();
  const roomCodes = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PACKET_BYTES, perMessageDeflate: false });
  const server = createServer(async (req, res) => {
    const [path, query] = req.url.split('?');
    const match = path.match(/^\/qr\/([a-f0-9]{32})\.png$/);
    const background = path.match(/^\/listen\/([a-f0-9]{32})\.mp3$/);
    if (req.method !== 'GET') return res.writeHead(405).end();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    try {
      if (path === '/healthz') {
        return res.writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ status: 'ok', mode: hostedOrigin ? 'hosted' : 'lan' }));
      }
      if (background) {
        const room = rooms.get(background[1]);
        if (!room) return res.writeHead(404).end();
        const count = room.background?.clients.size ?? 0;
        if (room.listeners.size + count >= MAX_LISTENERS) return res.writeHead(503).end();
        if (!room.background || room.background.closed) room.background = new BackgroundStream(() => reportListeners(room));
        room.background.add(res);
        return;
      }
      if (dev && path === '/dev/revision') {
        return res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(devRevision);
      }
      if (path === '/join') {
        const code = new URLSearchParams(query).get('code');
        if (code !== null) {
          const id = roomCodes.get(code.toUpperCase().replace(/[\s-]/g, ''));
          if (req.headers.accept === 'application/json') {
            if (hostedOrigin) {
              res.setHeader('Vary', 'Origin');
              if (req.headers.origin !== hostedOrigin) return res.writeHead(403).end();
              res.setHeader('Access-Control-Allow-Origin', hostedOrigin);
            }
            return res.writeHead(id ? 200 : 404, { 'Content-Type': 'application/json' })
              .end(JSON.stringify(id ? { id } : {}));
          }
          return res.writeHead(303, { Location: hostedOrigin + (id ? '/?room=' + id : '/?join=1&expired=1') }).end();
        }
      }
      if (match) {
        const room = rooms.get(match[1]);
        const index = Number(new URLSearchParams(query).get('network') ?? 0);
        const invite = room?.invites[index];
        if (!invite) return res.writeHead(404).end();
        const png = await QRCode.toBuffer(invite.url, { margin: 2, width: 320, errorCorrectionLevel: 'M' });
        return res.writeHead(200, { 'Content-Type': 'image/png' }).end(png);
      }
      if (hostedOrigin && path === '/') return res.writeHead(200).end('Speaker Sync relay');
      if (hostedOrigin) return res.writeHead(404).end('Page not found');
      const asset = assets.get(path === '/join' || path.startsWith('/room/') ? '/' : path);
      if (!asset) return res.writeHead(404).end('Page not found');
      const content = await readFile(new URL('./public/' + asset[0], import.meta.url));
      const body = dev && asset[0] === 'index.html'
        ? content.toString().replace('<html lang="en">', '<html lang="en" data-dev-revision="' + devRevision + '">')
        : content;
      res.writeHead(200, { 'Content-Type': asset[1] }).end(body);
    } catch {
      res.writeHead(500).end('Unable to load this page');
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const path = req.url;
    const isHost = path === '/live/host';
    const roomId = path.startsWith('/live/room/') ? path.slice('/live/room/'.length) : '';
    const room = ROOM_ID.test(roomId) ? rooms.get(roomId) : undefined;
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socket.remoteAddress);
    const localHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.host);
    const validOrigin = hostedOrigin
      ? req.headers.origin === hostedOrigin
      : req.headers.origin === 'http://' + req.headers.host && (!isHost || (loopback && localHost));
    if (!validOrigin || (!isHost && !room)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    if ((room && room.listeners.size + (room.background?.clients.size ?? 0) >= MAX_LISTENERS) ||
        (hostedOrigin && isHost && rooms.size >= MAX_HOSTED_ROOMS)) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.alive = true;
      ws.on('pong', () => { ws.alive = true; });
      ws.on('error', () => ws.terminate());
      if (isHost) {
        const id = randomBytes(16).toString('hex');
        let code;
        do {
          code = Array.from(randomBytes(8), byte => CODE_ALPHABET[byte & 31]).join('');
        } while (roomCodes.has(code));
        roomCodes.set(code, id);
        const networks = hostedOrigin ? [] : (lanHost ? [{ address: lanHost, name: 'Configured network' }] : lanAddresses());
        const invites = hostedOrigin
          ? [{ name: 'Online room', url: hostedOrigin + '/?room=' + id }]
          : networks.map(({ address, name }) => ({
            name, url: 'http://' + address + ':' + server.address().port + '/?room=' + id,
          }));
        const buffer = hostedOrigin ? HOSTED_BUFFER_MS : PLAYBACK_BUFFERS[0];
        const activeRoom = { host: ws, invites, listeners: new Set(), source: null, nextPhone: 1, tuning: null, buffer };
        rooms.set(id, activeRoom);
        send(ws, { type: 'room', id, code, invites });
        ws.on('message', (data, binary) => handleMessage(ws, activeRoom, data, binary));
        ws.on('close', () => {
          clearTimeout(activeRoom.tuning?.timer);
          rooms.delete(id);
          roomCodes.delete(code);
          activeRoom.background?.close();
          for (const listener of activeRoom.listeners) listener.close(4001, 'Host closed the room');
        });
      } else {
        ws.phoneId = room.nextPhone++;
        ws.tuneReady = false;
        ws.speaker = 'copy';
        room.listeners.add(ws);
        send(ws, { type: 'source', source: room.source });
        if (hostedOrigin || room.buffer !== PLAYBACK_BUFFERS[0]) send(ws, { type: 'buffer', ms: room.buffer });
        if (room.tuning) send(ws, { type: 'tune-state', active: true });
        reportListeners(room);
        ws.on('message', (data, binary) => handleMessage(ws, room, data, binary));
        ws.on('close', () => {
          room.listeners.delete(ws);
          if (room.tuning?.target === ws) endTuning(room, 'The selected phone disconnected. Try again after it rejoins.');
          if (ws.measurement !== undefined) sendTuneDelays(room);
          reportListeners(room);
        });
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }, 15000).unref();
  server.on('close', () => clearInterval(heartbeat));
  return server;
}

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

export function groupDelays(measurements) {
  const slowest = Math.max(0, ...measurements.filter(Number.isFinite));
  return {
    laptop: slowest,
    phones: measurements.map(value => Number.isFinite(value)
      ? Math.min(MAX_TUNE_OFFSET_MS, slowest - value) : 0),
  };
}

function reportListeners(room) {
  const phones = [...room.listeners].map(ws => ({
    id: ws.phoneId, ready: ws.tuneReady, measurement: ws.measurement, speaker: ws.speaker,
  }));
  const background = room.background?.clients.size ?? 0;
  send(room.host, { type: 'listeners', count: phones.length + background, phones, ...(background ? { background } : {}) });
}

function sendTuneDelays(room, resetManual = false) {
  const listeners = [...room.listeners];
  const delays = groupDelays(listeners.map(ws => ws.measurement));
  send(room.host, { type: 'tune-delay', delay: delays.laptop, resetManual });
  listeners.forEach((ws, index) => send(ws, {
    type: 'tune-delay', delay: delays.phones[index], resetManual: resetManual && Number.isFinite(ws.measurement),
  }));
}

function endTuning(room, error, resumeAt) {
  const attempt = room.tuning;
  if (!attempt) return;
  clearTimeout(attempt.timer);
  room.tuning = null;
  send(room.host, { type: 'tune-state', active: false, id: attempt.id, error, resumeAt });
  for (const listener of room.listeners) send(listener, { type: 'tune-state', active: false, resumeAt });
}

function handleTune(room, ws, message, now) {
  if (ws === room.host && message.type === 'tune-start') {
    const target = [...room.listeners].find(listener => listener.phoneId === message.phone);
    if (room.tuning || !target?.tuneReady || !Number.isSafeInteger(message.id) ||
        !Number.isFinite(message.at) || message.at < now + 250 || message.at > now + 2500) {
      send(ws, { type: 'tune-state', active: false, id: message.id, error: 'The phone is not ready to tune. Keep its room page open and try again.' });
      return;
    }
    room.tuning = { id: message.id, target, confirmed: false,
      timer: setTimeout(() => endTuning(room, 'Auto Tune timed out.'), 8000).unref() };
    send(ws, { type: 'tune-state', active: true, id: message.id });
    for (const listener of room.listeners) send(listener, { type: 'tune-state', active: true });
    send(target, { type: 'tune-tone', id: message.id, at: message.at + TUNE_SEPARATION_MS });
    return;
  }
  const attempt = room.tuning;
  if (!attempt || message.id !== attempt.id) return;
  if (message.type === 'tune-ready' && ws === attempt.target) {
    if (message.ok === true) attempt.confirmed = true;
    else endTuning(room, 'The phone could not schedule its test tone. Keep its room page open and try again.');
  }
  if (ws === room.host && message.type === 'tune-cancel') endTuning(room);
  if (ws === room.host && message.type === 'tune-finish') {
    if (!attempt.confirmed || !Number.isInteger(message.offset) || Math.abs(message.offset) > MAX_TUNE_OFFSET_MS) {
      endTuning(room, 'The phone tone could not be verified.');
      return;
    }
    const offsets = [...room.listeners].filter(listener => listener !== attempt.target)
      .map(listener => listener.measurement).filter(Number.isFinite);
    if (Math.max(0, message.offset, ...offsets) - Math.min(0, message.offset, ...offsets) > MAX_TUNE_OFFSET_MS) {
      endTuning(room, 'The delay between speakers is outside the Auto Tune range.');
      return;
    }
    attempt.target.measurement = message.offset;
    sendTuneDelays(room, true);
    reportListeners(room);
    endTuning(room, undefined, now + 1050);
  }
}

function handleMessage(ws, room, data, binary) {
  const received = performance.now();
  if (binary) {
    if (ws !== room.host || !room.source) return;
    const block = readPacket(new DataView(data.buffer, data.byteOffset, data.byteLength));
    if (!block || block.time <= received - 100 || block.time > received + 1500) return;
    room.background?.receive(data);
    for (const listener of room.listeners) {
      if (listener.readyState === WebSocket.OPEN && listener.bufferedAmount < MAX_PACKET_BYTES * 4) {
        listener.send(data, { binary: true });
      }
    }
    return;
  }
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (ws === room.host && message?.type === 'buffer' && PLAYBACK_BUFFERS.includes(message.ms)) {
    room.buffer = message.ms;
    for (const listener of room.listeners) send(listener, { type: 'buffer', ms: room.buffer });
    return;
  }
  if (ws === room.host && message?.type === 'speaker' && SPEAKER_MODES.includes(message.mode)) {
    const phone = [...room.listeners].find(listener => listener.phoneId === message.phone);
    if (phone && phone.speaker !== message.mode) {
      phone.speaker = message.mode;
      send(phone, { type: 'speaker', mode: phone.speaker });
      reportListeners(room);
    }
    return;
  }
  if (typeof message?.type === 'string' && message.type.startsWith('tune-')) {
    handleTune(room, ws, message, received);
    return;
  }
  if (message?.type === 'ping' && Number.isFinite(message.sent)) {
    send(ws, { type: 'pong', sent: message.sent, received, replied: performance.now() });
    if (ws !== room.host && ws.tuneReady !== (message.tuneReady === true)) {
      ws.tuneReady = message.tuneReady === true;
      reportListeners(room);
    }
    if (ws !== room.host && room.source && message.source === room.source && PLAYBACK_STATES.includes(message.playback)) {
      ws.playback = { status: message.playback, at: received };
      let status = 'waiting';
      for (const listener of room.listeners) {
        const report = listener.playback;
        if (report && received - report.at < 4500 &&
            PLAYBACK_STATES.indexOf(report.status) > PLAYBACK_STATES.indexOf(status)) status = report.status;
      }
      send(room.host, { type: 'phone-playback', source: room.source, status });
    }
  }
  if (ws === room.host && message?.type === 'source' && (message.source === null || ROOM_SOURCES.includes(message.source))) {
    if (room.tuning) endTuning(room, 'Audio sharing changed. Try Auto Tune again.');
    room.source = message.source;
    for (const listener of room.listeners) {
      listener.playback = null;
      send(listener, { type: 'source', source: room.source });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const server = createRelay({ dev: process.argv.includes('--dev') });
  server.listen(port, '0.0.0.0', () => {
    console.log(process.env.FRONTEND_ORIGIN
      ? 'Speaker Sync relay listening on port ' + server.address().port
      : 'Open Chrome on this Windows laptop: http://localhost:' + server.address().port);
    console.log('Phone links are generated when you create a room.');
  });
}
