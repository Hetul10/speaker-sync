import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { createRelay, groupDelays } from '../server.js';
import { correctedDuration, Playback, RelayClock } from '../public/audio.js';
import { boostSample, createPacket, readPacket } from '../public/protocol.js';
import { chirp, measureOffset } from '../public/tune.js';

test('clock estimates offset from low-RTT replies and corrects drift in either direction', () => {
  const clock = new RelayClock();
  for (const sent of [10, 120, 220]) {
    clock.observe({ sent, received: sent + 251, replied: sent + 252 }, sent + 3);
  }
  assert.equal(clock.ready, true);
  assert.equal(clock.offset, 250);
  assert.equal(clock.rtt, 2);
  clock.observe({ sent: 250, received: 570, replied: 571 }, 321);
  assert.equal(clock.offset, 250);
  assert.ok(correctedDuration(0.01, 0.020) > 0.01);
  assert.ok(correctedDuration(0.01, -0.020) < 0.01);
  assert.ok(Math.abs(correctedDuration(0.01, 1) / 0.01 - 1) <= 0.008001);
});

test('phone volume boost raises quiet audio and limits peaks', () => {
  assert.equal(boostSample(0.25, 2), 0.5);
  assert.equal(boostSample(-0.25, 2), -0.5);
  assert.equal(boostSample(0.94, 1), 0.94);
  assert.ok(boostSample(0.94, 2) < 1);
});

test('capture worklet packages test clicks and stereo tab input into PCM blocks', async () => {
  const packets = [];
  let Processor;
  globalThis.sampleRate = 48000;
  globalThis.AudioWorkletProcessor = class {
    port = { postMessage: ({ pcm, peak }) => packets.push({ ...readPacket(new DataView(pcm)), peak }) };
  };
  globalThis.registerProcessor = (_, implementation) => { Processor = implementation; };
  try {
    await import('../public/capture.js');
    const worklet = new Processor({ processorOptions: { test: true } });
    for (let frame = 0; frame <= 1024; frame += 128) {
      globalThis.currentFrame = frame;
      worklet.process([], [[new Float32Array(128)]]);
    }
    assert.deepEqual(packets.map(({ sequence, frame, frames }) => [sequence, frame, frames]),
      [[0, 0, 480], [1, 480, 480]]);
    assert.notEqual(packets[0].packet.getInt16(32, true), 0);
    assert.equal(packets[0].packet.getInt16(32, true), packets[0].packet.getInt16(34, true));
    assert.ok(packets[0].peak > 0.1);

    packets.length = 0;
    const tab = new Processor({ processorOptions: { test: false } });
    const left = new Float32Array(128).fill(0.25);
    const right = new Float32Array(128).fill(-0.5);
    const output = new Float32Array(128);
    for (let frame = 0; frame < 480; frame += 128) {
      globalThis.currentFrame = frame;
      tab.process([[left, right]], [[output]]);
    }
    assert.equal(packets[0].packet.getInt16(28, true), 8191);
    assert.equal(packets[0].packet.getInt16(30, true), -16383);
    assert.equal(packets[0].peak, 0.5);
    assert.ok(output.every(value => value === 0));
  } finally {
    for (const key of ['currentFrame', 'sampleRate', 'AudioWorkletProcessor', 'registerProcessor']) delete globalThis[key];
  }
});

test('playback diagnostics distinguish incoming, silent, and scheduled sound', () => {
  const stamp = { contextTime: 10, performanceTime: performance.now() };
  const rendered = [];
  const context = {
    currentTime: stamp.contextTime,
    state: 'running',
    getOutputTimestamp: () => stamp,
    createGain: () => ({ connect() {}, disconnect() {} }),
    createBuffer(channels, frames, rate) {
      const samples = Array.from({ length: channels }, () => new Float32Array(frames));
      rendered.push(samples);
      return { getChannelData: channel => samples[channel], duration: frames / rate };
    },
    createBufferSource: () => ({ playbackRate: {}, connect() {}, start() {}, stop() {} }),
  };
  const clock = { ready: false, offset: 0 };
  const playback = new Playback(context, clock);
  try {
    assert.equal(playback.status(), 'waiting');
    const silent = createPacket(0, 0, 48000, 480);
    silent.setFloat64(12, stamp.performanceTime + 30, true);
    playback.receive(silent.buffer);
    assert.equal(playback.status(), 'receiving');
    clock.ready = true;
    playback.receive(silent.buffer);
    assert.equal(playback.status(), 'silent');
    const sound = createPacket(1, 480, 48000, 480);
    sound.setFloat64(12, stamp.performanceTime + 40, true);
    sound.setInt16(28, 16000, true);
    sound.setInt16(30, -8000, true);
    playback.receive(sound.buffer);
    assert.equal(playback.status(), 'scheduled');
    assert.deepEqual(rendered.at(-1).map(samples => samples[0]), [16000 / 32768, -8000 / 32768]);
    for (const [index, mode, value] of [[2, 'left', 16000], [3, 'right', -8000]]) {
      playback.speaker = mode;
      const block = createPacket(index, index * 480, 48000, 480);
      block.setFloat64(12, stamp.performanceTime + 45 + index, true);
      block.setInt16(28, 16000, true);
      block.setInt16(30, -8000, true);
      playback.reset();
      playback.receive(block.buffer);
      assert.deepEqual(rendered.at(-1).map(samples => samples[0]), [value / 32768, value / 32768]);
    }
    assert.equal(playback.status(performance.now() + 2100), 'waiting');
  } finally {
    playback.close();
  }
});

test('hosted rooms accept the frontend origin and return public invitations', { timeout: 5000 }, async () => {
  const frontendOrigin = 'https://speaker-sync.example.com';
  const server = createRelay({ frontendOrigin });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const sockets = [];
  function connect(path, clientOrigin) {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + path, { origin: clientOrigin });
    sockets.push(socket);
    return socket;
  }
  try {
    const health = await fetch(origin + '/healthz');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', mode: 'hosted' });
    const rejected = connect('/live/host', origin);
    const [rejection] = await once(rejected, 'error');
    assert.match(rejection.message, /403/);

    const host = connect('/live/host', frontendOrigin);
    const [welcome] = await once(host, 'message');
    const { id, code, invites } = JSON.parse(welcome);
    const roomUrl = frontendOrigin + '/?room=' + id;
    assert.deepEqual(invites, [{ name: 'Online room', url: roomUrl }]);

    const join = await fetch(origin + '/join?code=' + code, { redirect: 'manual' });
    assert.equal(join.status, 303);
    assert.equal(join.headers.get('location'), roomUrl);
    const lookup = await fetch(origin + '/join?code=' + code, {
      headers: { Accept: 'application/json', Origin: frontendOrigin },
    });
    assert.equal(lookup.headers.get('access-control-allow-origin'), frontendOrigin);
    assert.deepEqual(await lookup.json(), { id });
    const blocked = await fetch(origin + '/join?code=' + code, {
      headers: { Accept: 'application/json', Origin: 'https://other.example.com' },
    });
    assert.equal(blocked.status, 403);
    const expired = await fetch(origin + '/join?code=invalid', { redirect: 'manual' });
    assert.equal(expired.headers.get('location'), frontendOrigin + '/?join=1&expired=1');
    const qr = await fetch(origin + '/qr/' + id + '.png');
    assert.equal(qr.headers.get('content-type'), 'image/png');
    await qr.arrayBuffer();

    const listener = connect('/live/room/' + id, frontendOrigin);
    const messages = [];
    await new Promise(resolve => listener.on('message', data => {
      messages.push(JSON.parse(data));
      if (messages.length === 2) resolve();
    }));
    assert.deepEqual(messages, [{ type: 'source', source: null }, { type: 'buffer', ms: 350 }]);
    const changedBuffer = once(listener, 'message');
    host.send(JSON.stringify({ type: 'buffer', ms: 600 }));
    assert.deepEqual(JSON.parse((await changedBuffer)[0]), { type: 'buffer', ms: 600 });
  } finally {
    for (const socket of sockets) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});

test('room serves a QR, relays PCM and phone diagnostics, and closes its listeners', { timeout: 5000 }, async () => {
  const server = createRelay({ lanHost: '127.0.0.1', dev: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const sockets = [];
  function connect(path, clientOrigin = origin) {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + path, { origin: clientOrigin });
    sockets.push(socket);
    return socket;
  }
  try {
    const hostPage = await fetch(origin);
    assert.equal(hostPage.status, 200);
    assert.deepEqual(await (await fetch(origin + '/healthz')).json(), { status: 'ok', mode: 'lan' });
    const markup = await hostPage.text();
    assert.match(markup, /Speaker Sync/);
    const version = await fetch(origin + '/dev/revision');
    assert.equal(version.status, 200);
    const revision = await version.text();
    assert.equal(markup.match(/data-dev-revision="([a-f0-9]{16})"/)?.[1], revision);
    const rejected = connect('/live/host', 'http://example.test');
    const [rejection] = await once(rejected, 'error');
    assert.match(rejection.message, /403/);
    const host = connect('/live/host');
    const [welcome] = await once(host, 'message');
    const room = JSON.parse(welcome);
    assert.match(room.id, /^[a-f0-9]{32}$/);
    assert.match(room.code, /^[A-HJ-NP-Z2-9]{8}$/);
    const formattedCode = room.code.slice(0, 4).toLowerCase() + '-' + room.code.slice(4);
    const joinUrl = origin + '/join?code=' + formattedCode;
    const join = await fetch(joinUrl, { redirect: 'manual' });
    assert.equal(join.status, 303);
    assert.equal(join.headers.get('location'), '/?room=' + room.id);
    const lookup = await fetch(joinUrl, { headers: { Accept: 'application/json' } });
    assert.deepEqual(await lookup.json(), { id: room.id });
    assert.match(await (await fetch(origin + '/join')).text(), /name="code"/);
    assert.equal(room.invites[0].url, origin + '/?room=' + room.id);
    const qr = await fetch(origin + '/qr/' + room.id + '.png?network=0');
    assert.equal(qr.status, 200);
    const image = Buffer.from(await qr.arrayBuffer());
    assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(image.readUInt32BE(16), 320);
    assert.equal((await fetch(room.invites[0].url)).status, 200);

    const listener = connect('/live/room/' + room.id);
    const newListener = once(host, 'message');
    const [idle] = await once(listener, 'message');
    assert.deepEqual(JSON.parse(idle), { type: 'source', source: null });
    assert.deepEqual(JSON.parse((await newListener)[0]), { type: 'listeners', count: 1, phones: [{ id: 1, ready: false, speaker: 'copy' }] });
    const bufferMode = once(listener, 'message');
    host.send(JSON.stringify({ type: 'buffer', ms: 125 }));
    assert.deepEqual(JSON.parse((await bufferMode)[0]), { type: 'buffer', ms: 125 });
    const pong = once(listener, 'message');
    listener.send(JSON.stringify({ type: 'ping', sent: 123 }));
    const reply = JSON.parse((await pong)[0]);
    assert.equal(reply.sent, 123);
    assert.ok(reply.replied >= reply.received);

    const channel = once(listener, 'message');
    const assigned = once(host, 'message');
    host.send(JSON.stringify({ type: 'speaker', phone: 1, mode: 'left' }));
    assert.deepEqual(JSON.parse((await channel)[0]), { type: 'speaker', mode: 'left' });
    assert.equal(JSON.parse((await assigned)[0]).phones[0].speaker, 'left');

    const live = once(listener, 'message');
    host.send(JSON.stringify({ type: 'source', source: 'click' }));
    assert.deepEqual(JSON.parse((await live)[0]), { type: 'source', source: 'click' });
    const packet = createPacket(45, 21600, 48000, 480);
    packet.setFloat64(12, performance.now() + 150, true);
    const incoming = once(listener, 'message');
    const unsolicited = new Uint8Array(packet.buffer.slice(0));
    unsolicited[0] = 99;
    listener.send(unsolicited); // The listener cannot send audio back to the room.
    host.send(new Uint8Array(64)); // Invalid PCM is skipped.
    host.send(new Uint8Array(packet.buffer));
    const [bytes, binary] = await incoming;
    assert.equal(binary, true);
    assert.deepEqual(bytes, Buffer.from(packet.buffer));

    const diagnostics = once(host, 'message');
    listener.send(JSON.stringify({ type: 'ping', sent: 150, source: 'click', playback: 'scheduled' }));
    assert.deepEqual(JSON.parse((await diagnostics)[0]), { type: 'phone-playback', source: 'click', status: 'scheduled' });

    for (const source of ['window', 'desktop', 'tab', null]) {
      const changed = once(listener, 'message');
      host.send(JSON.stringify({ type: 'source', source }));
      assert.deepEqual(JSON.parse((await changed)[0]), { type: 'source', source });
    }

    const ended = once(listener, 'close');
    host.close();
    assert.equal((await ended)[0], 4001);
    assert.equal((await fetch(origin + '/qr/' + room.id + '.png')).status, 404);
    const expired = await fetch(joinUrl, { redirect: 'manual' });
    assert.equal(expired.headers.get('location'), '/?join=1&expired=1');
    assert.equal((await fetch(joinUrl, { headers: { Accept: 'application/json' } })).status, 404);
  } finally {
    for (const socket of sockets) socket.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});

test('Auto Tune detects delayed chirps and keeps prior measurements in the delay calculation', () => {
  const rate = 8000;
  const expected = 1680;
  const recording = Float32Array.from({ length: rate * 2.3 }, (_, index) => Math.sin(index * 1.78) * 0.002);
  const putTone = (start, volume) => {
    for (let index = 0; index < rate * 0.055; index++) recording[start + index] += volume * chirp(index / rate);
  };
  putTone(expected + 240, 0.6);
  assert.equal(measureOffset(recording, rate, expected), null);
  putTone(expected + 9200 + 240 + 960, 0.3);
  assert.equal(measureOffset(recording, rate, expected), 120);
  assert.deepEqual(groupDelays([120, undefined]), { laptop: 120, phones: [0, 0] });
  assert.deepEqual(groupDelays([120, 235]), { laptop: 235, phones: [115, 0] });
  assert.deepEqual(groupDelays([-25, 120]), { laptop: 120, phones: [145, 0] });
});

test('Auto Tune targets one phone and reapplies room delays after a slower phone is measured', { timeout: 5000 }, async () => {
  const relay = createRelay();
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  const origin = 'http://127.0.0.1:' + relay.address().port;
  const sockets = [];
  const connect = path => {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + path, { origin });
    sockets.push(ws);
    return ws;
  };
  const next = (ws, type, predicate = () => true) => new Promise(resolve => {
    const listener = (data, binary) => {
      if (binary) return;
      const message = JSON.parse(data);
      if (message.type !== type || !predicate(message)) return;
      ws.off('message', listener);
      resolve(message);
    };
    ws.on('message', listener);
  });
  const send = (ws, data) => ws.send(JSON.stringify(data));
  try {
    const host = connect('/live/host');
    const { id } = await next(host, 'room');
    const listener = async phoneId => {
      const ws = connect('/live/room/' + id);
      await next(ws, 'source');
      const ready = next(host, 'listeners', message => message.phones.some(phone => phone.id === phoneId && phone.ready));
      send(ws, { type: 'ping', sent: 1, tuneReady: true });
      await ready;
      return ws;
    };
    const first = await listener(1);
    const second = await listener(2);
    async function tune(target, phone, offset, expected) {
      const tone = next(target, 'tune-tone');
      const mute = Promise.all([next(first, 'tune-state'), next(second, 'tune-state')]);
      const relayTime = performance.now() + 850;
      send(host, { type: 'tune-start', id: phone, phone, at: relayTime });
      assert.equal((await tone).at, relayTime + 1150);
      assert.ok((await mute).every(event => event.active));
      // A ping on the same socket confirms the relay received the phone's acknowledgement.
      send(target, { type: 'tune-ready', id: phone, ok: true });
      const pong = next(target, 'pong');
      send(target, { type: 'ping', sent: 2, tuneReady: true });
      await pong;
      const delays = Promise.all([host, first, second].map(ws => next(ws, 'tune-delay')));
      const done = next(host, 'tune-state', message => !message.active);
      send(host, { type: 'tune-finish', id: phone, offset });
      const applied = await delays;
      assert.deepEqual(applied.map(message => message.delay), expected);
      assert.deepEqual(applied.map(message => message.resetManual), phone === 1 ? [true, true, false] : [true, true, true]);
      assert.ok((await done).resumeAt > performance.now());
    }
    await tune(first, 1, 60, [60, 0, 0]);
    await tune(second, 2, 170, [170, 110, 0]);

    const retry = next(first, 'tune-tone');
    send(host, { type: 'tune-start', id: 3, phone: 1, at: performance.now() + 800 });
    await retry;
    const failed = next(host, 'tune-state', message => !message.active);
    send(host, { type: 'tune-finish', id: 3, offset: 20 });
    assert.match((await failed).error, /could not be verified/);
    const roster = next(host, 'listeners');
    send(first, { type: 'ping', sent: 4, tuneReady: false });
    assert.deepEqual((await roster).phones.map(phone => phone.measurement), [60, 170]);
  } finally {
    for (const ws of sockets) ws.terminate();
    await new Promise(resolve => relay.close(resolve));
  }
});

test('screen-off player gets a live stereo MP3 stream and closes with its room', { timeout: 6000 }, async () => {
  const relay = createRelay();
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  const origin = 'http://127.0.0.1:' + relay.address().port;
  const host = new WebSocket(origin.replace('http:', 'ws:') + '/live/host', { origin });
  const stream = new AbortController();
  try {
    const [welcome] = await once(host, 'message');
    const { id } = JSON.parse(welcome);
    const listeners = once(host, 'message');
    const url = origin + '/listen/' + id + '.mp3';
    const response = await fetch(url, { signal: stream.signal });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.deepEqual(JSON.parse((await listeners)[0]), { type: 'listeners', count: 1, phones: [], background: 1 });
    const reader = response.body.getReader();
    const { value } = await reader.read();
    assert.equal(value[0], 255);
    assert.equal(value[1] & 224, 224);
    assert.equal(value[2] >> 4, 11); // 192 kbps in the MPEG-1 Layer III bitrate table.
    host.close();
    while (!(await reader.read()).done) { /* Drain frames already buffered by the response. */ }
    assert.equal((await fetch(url)).status, 404);
  } finally {
    stream.abort();
    host.terminate();
    await new Promise(resolve => relay.close(resolve));
  }
});
