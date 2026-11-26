import { BUFFER_MS, outputClock, Playback, RelayClock } from './audio.js';
import { MAX_PACKET_BYTES, PHONE_BOOST_DB, PLAYBACK_BUFFERS, SIGNAL_WINDOW_MS, SOUND_THRESHOLD, SPEAKER_MODES, TUNE_SEPARATION_MS } from './protocol.js';
import { audioTime, captureTones, measureOffset, playTone } from './tune.js';

const $ = id => document.getElementById(id);
const roomPath = /^\/room\/([a-f0-9]{32})\/?$/;
const params = new URLSearchParams(location.search);
const roomPattern = /^[a-f0-9]{32}$/;
const roomParam = params.get('room');
let roomId = roomPattern.test(roomParam ?? '') ? roomParam : location.pathname.match(roomPath)?.[1];
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const hostedRelay = document.querySelector('meta[name="speaker-sync-relay"]')?.content;
const relayOrigin = hostedRelay || location.origin;
const isHostPage = isLocal || Boolean(hostedRelay && location.protocol === 'https:');
let joinOnly = params.has('join') || location.pathname === '/join' || !isHostPage;
const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
const canHost = isHostPage && Boolean(AudioContextClass && 'audioWorklet' in AudioContextClass.prototype);
const mediaDevices = navigator.mediaDevices;
const canShareTab = canHost && Boolean(mediaDevices?.getDisplayMedia) &&
  document.featurePolicy?.allowsFeature('display-capture') !== false;
const hostAddress = hostedRelay ? location.origin : 'http://localhost' + (location.port ? ':' + location.port : '');
let host = null;
let phone = null;
let hostDelay = 0;
let phoneDelay = 0;
let phoneBoost = PHONE_BOOST_DB;
let backgroundAttempt = 0;
let tuneNumber = 0;
let joining = false;
const speakerLabels = { copy: 'Copy', left: 'Left', right: 'Right' };

const playbackLabels = {
  waiting: 'Waiting for audio data',
  receiving: 'Receiving data · buffering or late',
  silent: 'Receiving a silent stream',
  scheduled: 'Sound scheduled',
};
const captureModes = {
  tab: { surface: 'browser', status: 'Sharing tab audio', help: 'In Chrome’s picker, choose a tab and turn on tab audio.' },
  window: { surface: 'window', status: 'Sharing app audio', help: 'In Chrome’s picker, choose a window and turn on app audio.' },
  desktop: { surface: 'monitor', status: 'Sharing PC audio', help: 'In Chrome’s picker, choose Entire Screen and turn on system audio.' },
};

function updateStatus(id, message, active) {
  const element = $(id);
  if (element.textContent !== message) element.textContent = message;
  if (active !== undefined) element.dataset.active = active;
}

function notice(message = '') {
  $('feedback').textContent = message;
  $('feedback').hidden = !message;
}

function captureNotice(message = '') {
  $('capture-feedback').textContent = message;
  $('capture-feedback').hidden = !message;
}

function pairNotice(message = '') {
  updateStatus('pair-feedback', message);
  $('pair-feedback').hidden = !message;
}

function socketFor(path, handlers) {
  const url = new URL(path, relayOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);
  const clock = new RelayClock();
  let timer;
  socket.binaryType = 'arraybuffer';
  const ping = () => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'ping', sent: performance.now(), ...handlers.playback?.() }));
    }
  };
  socket.addEventListener('open', () => {
    ping();
    timer = setInterval(() => {
      ping();
      if (clock.ready && timer) {
        clearInterval(timer);
        timer = setInterval(ping, 1500);
      }
    }, 90);
  });
  socket.addEventListener('message', ({ data }) => {
    if (typeof data !== 'string') {
      handlers.audio?.(data);
      return;
    }
    const message = JSON.parse(data);
    if (message.type === 'pong') {
      clock.observe(message);
      handlers.clock?.();
      return;
    }
    handlers.message?.(message);
  });
  socket.addEventListener('close', event => {
    clearInterval(timer);
    handlers.close(event);
  });
  return { socket, clock };
}

function setupSync(panelId, apply) {
  const panel = $(panelId);
  panel.append($('sync-template').content.cloneNode(true));
  const slider = panel.querySelector('input');
  const output = panel.querySelector('output');
  slider.id = panelId + '-range';
  output.htmlFor = slider.id;
  const show = () => {
    output.value = Number(slider.value) ? '+' + slider.value + ' ms' : '0 ms';
    slider.setAttribute('aria-valuetext', slider.value + ' milliseconds');
  };
  slider.addEventListener('input', show);
  slider.addEventListener('change', () => apply(Number(slider.value)));
  panel.querySelector('button').addEventListener('click', () => {
    slider.value = 0;
    show();
    apply(0);
  });
  show();
}

function applyDelay(playback, value) {
  if (playback && playback.delay !== value) {
    playback.reset();
    playback.delay = value;
  }
}

function showAutoDelay(panelId, value) {
  const label = $(panelId).querySelector('.auto-delay');
  label.textContent = 'Auto Tune delay · +' + value + ' ms';
  label.hidden = !value;
}

function resetManualDelay(panelId) {
  const slider = $(panelId).querySelector('input');
  slider.value = 0;
  slider.dispatchEvent(new Event('input'));
}

async function resumeAudio(context) {
  let timer;
  try {
    await Promise.race([
      context.resume(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('The laptop browser did not start audio. Open the room in desktop Chrome and try again.')), 3500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function setTuneMute(session, playback, muted, resumeAt) {
  if (!playback) return;
  const now = playback.context.currentTime;
  const time = resumeAt ? Math.max(now, audioTime(playback.context, session.clock, resumeAt)) : now;
  const gain = playback.gain.gain;
  gain.cancelScheduledValues(now);
  gain.setValueAtTime(muted ? 0 : 1, time);
}

function addSpeakerOptions(select) {
  select.replaceChildren(...SPEAKER_MODES.map(mode => new Option(speakerLabels[mode], mode)));
}

function updatePhoneRows(listId, phones, createRow, updateRow) {
  const list = $(listId);
  const byId = new Map([...list.children].map(row => [Number(row.dataset.phone), row]));
  for (const phone of phones) {
    let row = byId.get(phone.id);
    if (!row) {
      row = document.createElement('li');
      row.dataset.phone = phone.id;
      const label = document.createElement('strong');
      label.textContent = 'Phone ' + phone.id;
      row.append(label);
      createRow(row, phone.id);
      list.append(row);
    }
    byId.delete(phone.id);
    updateRow(row, phone);
  }
  for (const row of byId.values()) row.remove();
}

function showSpeakerLayout() {
  const windowsPlayback = Boolean(host?.source && !host.audio.playback);
  const positions = { copy: [], left: [], right: [] };
  $('laptop-speaker-row').hidden = !host?.id;
  const laptop = $('laptop-speaker');
  laptop.disabled = windowsPlayback || Boolean(host?.tuning);
  laptop.value = host?.speaker ?? 'copy';
  if (host?.id && !windowsPlayback) positions[laptop.value].push('Laptop');
  updatePhoneRows('speaker-phones', host?.phones ?? [],
    (row, phoneId) => {
      row.className = 'speaker-row';
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Speaker channel for Phone ' + phoneId);
      addSpeakerOptions(select);
      select.addEventListener('change', () => {
        host.socket.send(JSON.stringify({ type: 'speaker', phone: phoneId, mode: select.value }));
      });
      row.append(select);
    },
    (row, phone) => {
      const select = row.querySelector('select');
      select.value = phone.speaker ?? 'copy';
      select.disabled = Boolean(host.tuning);
      positions[select.value].push('Phone ' + phone.id);
    });
  for (const mode of SPEAKER_MODES) updateStatus('layout-' + mode, positions[mode].join(', ') || '—');
}

function showTunePhones() {
  const available = canHost && Boolean(mediaDevices?.getUserMedia);
  const windowsPlayback = Boolean(host?.source && !host.audio.playback);
  const phones = host?.phones ?? [];
  updatePhoneRows('tune-phones', phones,
    (row, phoneId) => {
      row.className = 'tune-row';
      const measurement = document.createElement('span');
      const button = document.createElement('button');
      button.className = 'primary';
      button.textContent = 'Tune';
      button.setAttribute('aria-label', 'Tune Phone ' + phoneId);
      button.addEventListener('click', () => tunePhone(phoneId));
      row.append(measurement, button);
    },
    (row, phone) => {
      row.querySelector('span').textContent = Number.isFinite(phone.measurement)
        ? 'Measured · ' + (phone.measurement > 0 ? '+' : '') + phone.measurement + ' ms'
        : phone.ready ? 'Ready' : 'Preparing audio';
      row.querySelector('button').disabled = !available || windowsPlayback || !phone.ready || !host.clock.ready ||
        Boolean(host.tuning || host.pending);
    });
  updateStatus('tune-status', !phones.length ? 'Connect a phone and tap Listen to start.' :
    windowsPlayback ? 'Stop Windows audio sharing or switch to synchronized Chrome tab playback to tune.' :
    !available ? 'Open in desktop Chrome to use the laptop microphone.' :
    host.tuneMessage || (host.autoDelay ? 'Laptop Auto Tune delay · ' + host.autoDelay + ' ms' : ''));
  $('tune-status').hidden = !$('tune-status').textContent;
}

async function tunePhone(phoneId) {
  const session = host;
  if (!session || session.tuning || session.pending || (session.source && !session.audio?.playback)) return;
  const attempt = { id: ++tuneNumber, controller: new AbortController() };
  const { signal } = attempt.controller;
  session.tuning = attempt;
  session.tuneMessage = 'Allow the laptop microphone to measure Phone ' + phoneId + '.';
  showHost();
  let context;
  let ownsContext = false;
  let microphone;
  let recorder;
  let timer;
  let laptopTone;
  let sent = false;
  try {
    ownsContext = !session.audio;
    context = session.audio?.context ?? new AudioContextClass({ latencyHint: 'interactive' });
    const resume = resumeAudio(context).then(() => null, error => error);
    microphone = await mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    signal.throwIfAborted();
    const audioError = await resume;
    if (audioError) throw audioError;
    recorder = await captureTones(context, microphone, signal);
    session.tuneMessage = 'Measuring the laptop and Phone ' + phoneId + '…';
    showTunePhones();
    const at = performance.now() + session.clock.offset + 850;
    laptopTone = playTone(context, session.clock, at);
    const preRoll = 0.21;
    recorder.start(Math.round((laptopTone.start - preRoll) * context.sampleRate), 2.3);
    session.socket.send(JSON.stringify({ type: 'tune-start', id: attempt.id, phone: phoneId, at }));
    sent = true;
    signal.addEventListener('abort', () => recorder.close(), { once: true });
    timer = setTimeout(() => recorder.close(), 4500);
    const recording = await recorder.recording;
    signal.throwIfAborted();
    const offset = recording && measureOffset(recording.samples, recording.rate, preRoll * recording.rate);
    if (offset == null) throw new Error('The laptop microphone could not identify both tones. Check speaker volumes and try again.');
    session.socket.send(JSON.stringify({ type: 'tune-finish', id: attempt.id, offset }));
    session.tuneMessage = 'Measured Phone ' + phoneId + '. Updating the group…';
  } catch (error) {
    if (!signal.aborted) {
      session.tuneMessage = error.name === 'NotAllowedError' ? 'Allow microphone access in Chrome to use Auto Tune.' : error.message;
      if (sent) session.socket.send(JSON.stringify({ type: 'tune-cancel', id: attempt.id }));
      else session.tuning = null;
    }
  } finally {
    clearTimeout(timer);
    recorder?.close();
    laptopTone?.node.stop();
    microphone?.getTracks().forEach(track => track.stop());
    if (ownsContext && context?.state !== 'closed') void context?.close().catch(() => {});
    if (host === session) showHost();
  }
}

function showHost() {
  const ready = Boolean(host?.id);
  const source = host?.source;
  updateStatus('room-status', ready ? host.count + (host.count === 1 ? ' listener' : ' listeners') +
    (host.background ? ' · ' + host.background + ' screen-off' : '') : host ? 'Creating room' : 'Ready to host');
  document.body.classList.toggle('paired', ready);
  document.body.classList.toggle('entry-layout', !ready);
  document.body.classList.toggle('playing', Boolean(source));
  $('create').hidden = ready;
  $('create').disabled = !canHost || Boolean(host) || joining;
  $('join-room').hidden = ready;
  $('end').hidden = !ready;
  updateStatus('headline', ready ? 'Room controls' : 'Connect your speakers');
  updateStatus('pair-title', ready ? 'Invite phones' : 'Host a room');
  $('intro-copy').hidden = ready;
  for (const panel of ['share-panel', 'speakers-panel', 'auto-tune', 'advanced']) $(panel).hidden = !ready;
  $('pair-actions').hidden = !ready;
  $('copy').disabled = !host?.invites?.length;
  updateStatus('source-status', captureModes[host?.pending] ? 'Choose a source' : host?.pending ? 'Starting' :
    captureModes[source]?.status ?? (source === 'click' ? 'Test click running' :
    ready && !host.clock.ready ? 'Syncing with relay' : 'Idle'));
  const busy = !ready || !host?.clock.ready || Boolean(host?.pending || host?.tuning);
  const windowsPlayback = Boolean(source && !host.audio.playback);
  $('capture').disabled = busy || !canShareTab;
  $('test').disabled = busy;
  $('capture').textContent = captureModes[source] ? 'Stop sharing' : 'Share audio';
  $('capture-source').disabled = Boolean(host?.pending || captureModes[source]);
  $('keep-local').disabled = $('capture-source').disabled;
  $('playback-buffer').disabled = Boolean(host?.tuning);
  $('playback-buffer').value = host?.buffer ?? BUFFER_MS;
  $('test').textContent = source === 'click' ? 'Stop test click' : 'Play test click';
  $('host-sync').querySelector('input').disabled = windowsPlayback || Boolean(host?.tuning);
  $('host-sync').querySelector('button').disabled = windowsPlayback || Boolean(host?.tuning);
  $('host-sync').querySelector('p').textContent = windowsPlayback
    ? 'Windows controls laptop playback for this source.'
    : 'Use the test click. Add delay on the speaker you hear first.';
  showHostDiagnostics();
  showAutoDelay('host-sync', windowsPlayback ? 0 : host?.autoDelay ?? 0);
  showSpeakerLayout();
  showTunePhones();
}

function showCaptureMode() {
  const kind = $('capture-source').value;
  const keepLocal = $('keep-local').checked;
  $('local-audio-option').hidden = kind !== 'tab';
  $('capture-help').textContent = captureModes[kind].help + (kind !== 'tab' || keepLocal
    ? ' Windows plays the original audio, which may reach the laptop first.' : '');
}

function showHostDiagnostics() {
  const now = performance.now();
  const audio = host?.audio;
  const live = Boolean(host?.source);
  const hasSound = live && now - audio.lastSignal < SIGNAL_WINDOW_MS;
  const hasBlocks = live && now - audio.lastBlock < SIGNAL_WINDOW_MS;
  updateStatus('laptop-signal', hasSound ? 'Sound detected' : hasBlocks ? 'Silent input' :
    live ? 'Waiting for audio data' : 'Waiting for a source', hasSound);
  const localStatus = live ? audio.playback?.status() : null;
  updateStatus('laptop-playback', live && !audio.playback ? 'Original Windows audio' :
    (playbackLabels[localStatus] ?? 'Waiting for a source'), localStatus === 'scheduled');

  const report = host?.phoneReport;
  const status = live && report?.source === host.source && now - report.at < 4500 ? report.status : null;
  updateStatus('phone-playback', !host?.count ? 'No phone listening' :
    !host.phones?.length && host.background ? 'Screen-off stream connected' :
    !live ? 'Connected · waiting for source' : (playbackLabels[status] ?? 'Waiting for phone report'), status === 'scheduled');
}

function updateInvite() {
  const index = Number($('network').value || 0);
  const invite = host?.invites?.[index];
  $('join-options').hidden = !invite;
  $('qr-box').hidden = !invite;
  $('qr').hidden = !invite;
  $('code-card').hidden = !invite || !host?.code;
  $('invite-link').hidden = !invite;
  if (invite) {
    $('qr').src = relayOrigin + '/qr/' + host.id + '.png?network=' + index;
    $('invite-link').href = invite.url;
    const address = new URL('/?join=1', invite.url);
    $('join-address').href = address.href;
    $('join-address').textContent = address.origin;
    $('room-code').textContent = host.code ? host.code.slice(0, 4) + '-' + host.code.slice(4) : '';
  } else {
    $('qr').removeAttribute('src');
    $('invite-link').removeAttribute('href');
  }
}

function sendSource(session, source) {
  session.phoneReport = null;
  if (session.socket.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ type: 'source', source }));
}

function stopSource(session) {
  session.source = null;
  session.pending = false;
  const audio = session.audio;
  session.audio = null;
  if (audio) {
    audio.worklet?.disconnect();
    audio.stream?.getTracks().forEach(track => track.stop());
    audio.playback?.close();
    if (audio.context.state !== 'closed') void audio.context.close().catch(() => {});
  }
  sendSource(session, null);
  if (host === session) showHost();
}

function endHost(session, unexpected = false) {
  if (host !== session) return;
  host = null;
  session.tuning?.controller.abort();
  stopSource(session);
  session.socket.close();
  $('network-field').hidden = true;
  updateStatus('pair-help', '');
  $('pair-help').hidden = true;
  $('connect-guide').open = false;
  $('advanced').open = false;
  pairNotice();
  updateInvite();
  showHost();
  if (canShareTab) captureNotice();
  notice(unexpected ? 'The relay disconnected. Create a new room to continue.' : '');
  if (!unexpected) $('create').focus();
}

function startHost() {
  if (joining || host) return;
  notice();
  pairNotice();
  const session = { count: 0, source: null, speaker: 'copy', buffer: BUFFER_MS };
  Object.assign(session, socketFor('/live/host', {
    clock: showHost,
    message(message) {
      if (host !== session) return;
      if (message.type === 'room') {
        session.id = message.id;
        session.code = message.code;
        session.invites = message.invites;
        $('network').replaceChildren(...session.invites.map(({ name, url }, index) =>
          new Option(name + ' · ' + new URL(url).hostname, index)));
        $('network-field').hidden = session.invites.length < 2;
        $('pair-help').hidden = session.invites.length > 0;
        updateStatus('pair-help', session.invites.length ? '' : 'Connect this laptop to Wi-Fi and create a new room to get a phone link.');
        $('connect-guide').open = false;
        updateInvite();
      }
      if (message.type === 'listeners') {
        if (session.count !== message.count) session.phoneReport = null;
        session.count = message.count;
        session.background = message.background ?? 0;
        session.phones = message.phones;
      }
      if (message.type === 'phone-playback') session.phoneReport = { ...message, at: performance.now() };
      if (message.type === 'tune-delay') {
        session.autoDelay = message.delay;
        if (message.resetManual) {
          hostDelay = 0;
          resetManualDelay('host-sync');
        }
        applyDelay(session.audio?.playback, hostDelay + session.autoDelay);
      }
      if (message.type === 'tune-state' && session.tuning?.id === message.id) {
        setTuneMute(session, session.audio?.playback, message.active, message.resumeAt);
        if (!message.active) {
          session.tuning.controller.abort();
          session.tuning = null;
          if (message.error) session.tuneMessage = message.error;
          else if (message.resumeAt) session.tuneMessage = 'Auto Tune applied to the laptop and measured phones.';
        }
      }
      showHost();
      if (message.type === 'room') $('pair-title').focus();
    },
    close: () => endHost(session, true),
  }));
  host = session;
  showHost();
}

async function chooseSource(kind) {
  const session = host;
  if (!session?.id || !session.clock.ready || session.pending || session.tuning) return;
  captureNotice();
  if (session.source === kind) {
    stopSource(session);
    return;
  }
  session.pending = kind;
  showHost();
  let audio;
  let stream;
  const mode = captureModes[kind];
  const replayLocal = kind === 'click' || (kind === 'tab' && !$('keep-local').checked);
  try {
    if (mode) {
      const controller = kind === 'tab' && typeof CaptureController === 'function' ? new CaptureController() : undefined;
      controller?.setFocusBehavior('no-focus-change');
      // Open the picker directly in the button's click gesture.
      stream = await mediaDevices.getDisplayMedia({
        video: { displaySurface: mode.surface },
        audio: { suppressLocalAudioPlayback: replayLocal, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        controller,
        selfBrowserSurface: 'exclude',
        systemAudio: kind === 'desktop' ? 'include' : 'exclude',
        windowAudio: kind === 'window' ? 'window' : 'exclude',
        surfaceSwitching: 'exclude',
        monitorTypeSurfaces: kind === 'desktop' ? 'include' : 'exclude',
      });
      if (host !== session || session.pending !== kind) return;
      const video = stream.getVideoTracks()[0];
      const track = stream.getAudioTracks()[0];
      if (video?.getSettings().displaySurface !== mode.surface) {
        throw new Error(mode.help);
      }
      if (!track) {
        throw new Error('Chrome returned no audio. ' + mode.help);
      }
      if (replayLocal && track.getSettings().suppressLocalAudioPlayback === false) {
        $('advanced').open = true;
        throw new Error('Chrome kept the original audio enabled. Check “Keep original laptop audio” and try again.');
      }
    }
    if (session.source) stopSource(session);
    session.pending = kind;
    const context = new AudioContextClass({ latencyHint: 'interactive' });
    audio = { context, stream, lastBlock: -Infinity, lastSignal: -Infinity };
    session.audio = audio;
    stream = null;
    if (audio.stream) {
      for (const item of audio.stream.getTracks()) {
        item.addEventListener('ended', () => {
          if (session.audio === audio) {
            stopSource(session);
            captureNotice('Audio sharing ended.');
          }
        });
      }
    }
    await resumeAudio(context);
    if (host !== session || session.audio !== audio) return;
    await context.audioWorklet.addModule('/capture.js');
    if (host !== session || session.audio !== audio) return;
    const worklet = new AudioWorkletNode(context, 'capture-pcm', {
      numberOfInputs: mode ? 1 : 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { test: kind === 'click' },
    });
    audio.worklet = worklet;
    if (replayLocal) {
      audio.playback = new Playback(context, session.clock);
      audio.playback.delay = hostDelay + (session.autoDelay ?? 0);
      audio.playback.speaker = session.speaker;
    }
    worklet.port.onmessage = ({ data: { pcm, peak } }) => {
      if (session.audio !== audio) return;
      audio.lastBlock = performance.now();
      if (peak >= SOUND_THRESHOLD) audio.lastSignal = audio.lastBlock;
      const stamp = outputClock(context);
      const packet = new DataView(pcm);
      const captureTime = stamp.performanceTime + (packet.getFloat64(4, true) / context.sampleRate - stamp.contextTime) * 1000;
      packet.setFloat64(12, captureTime + session.clock.offset + session.buffer, true);
      audio.playback?.receive(pcm);
      if (session.socket.readyState === WebSocket.OPEN && session.socket.bufferedAmount < MAX_PACKET_BYTES * 4) {
        session.socket.send(pcm);
      }
    };
    worklet.onprocessorerror = () => {
      if (session.audio === audio) {
        stopSource(session);
        captureNotice('Audio capture stopped. Start the source again.');
      }
    };
    if (audio.stream) audio.input = context.createMediaStreamSource(audio.stream);
    audio.input?.connect(worklet);
    worklet.connect(context.destination); // The worklet's wired output is silent. Only scheduled PCM is audible.
    session.pending = false;
    session.source = kind;
    sendSource(session, kind);
    showHost();
  } catch (error) {
    if (host !== session || (audio && session.audio !== audio)) return;
    if (audio) stopSource(session);
    else {
      session.pending = false;
      showHost();
    }
    captureNotice(error.name === 'NotAllowedError' || error.name === 'InvalidStateError'
      ? 'The browser cancelled or blocked audio sharing. Open ' + hostAddress + ' directly in desktop Google Chrome and try again.'
      : error.message);
  } finally {
    stream?.getTracks().forEach(track => track.stop());
  }
}

function showPhone() {
  const player = $('background-audio');
  const background = player.hasAttribute('src');
  const connected = phone?.socket?.readyState === WebSocket.OPEN;
  const status = phone?.source && phone.playback?.status();
  updateStatus('room-status', background ? 'Screen-off player' : connected ? 'Room connected' : phone ? 'Connecting' : 'Ready to join');
  updateStatus('listen-status', background ? (player.readyState < 2 ? 'Buffering stream' : player.paused ? 'Paused' : 'Playing') :
    connected ? (playbackLabels[status] ?? 'Waiting for host') : phone ? 'Connecting' : 'Ready');
  $('listen').textContent = background ? 'Switch to synced listening' : phone ? 'Pause' : 'Listen';
  $('listen-background').textContent = background ? 'Stop screen-off player' : 'Listen with screen off';
  $('volume-control').hidden = $('volume-boost').hidden = background;
  document.body.classList.toggle('paired', connected || background);
  document.body.classList.toggle('playing', (connected && status === 'scheduled') || (background && !player.paused));
  $('phone-channel').hidden = !connected;
  updateStatus('phone-channel', 'Speaker mode · ' + (speakerLabels[phone?.playback?.speaker] ?? 'Copy'));
  if (phone?.tuning) updateStatus('listen-status', 'Auto Tune in progress');
  showAutoDelay('phone-sync', phone?.autoDelay ?? 0);
  $('phone-sync').querySelector('input').disabled = Boolean(phone?.tuning);
  $('phone-sync').querySelector('button').disabled = Boolean(phone?.tuning);
}

function useMediaAudioSession() {
  if (!navigator.audioSession) return;
  try { navigator.audioSession.type = 'playback'; } catch { /* Older iPhone browsers can use their default audio session. */ }
}

function stopBackground(message = '') {
  const player = $('background-audio');
  if (!player.hasAttribute('src')) return;
  backgroundAttempt++;
  player.pause();
  player.removeAttribute('src');
  player.load();
  player.hidden = true;
  if (navigator.mediaSession) navigator.mediaSession.metadata = null;
  showPhone();
  notice(message);
}

function listenInBackground() {
  const player = $('background-audio');
  if (player.hasAttribute('src')) {
    stopBackground();
    return;
  }
  if (phone) stopPhone(phone);
  useMediaAudioSession();
  notice();
  const url = new URL('/listen/' + roomId + '.mp3', relayOrigin).href;
  const attempt = ++backgroundAttempt;
  player.src = url;
  player.hidden = false;
  if (navigator.mediaSession && typeof MediaMetadata === 'function') {
    navigator.mediaSession.metadata = new MediaMetadata({ title: 'Speaker Sync', artist: 'Live room' });
  }
  showPhone();
  void player.play().catch(() => {
    if (attempt === backgroundAttempt) stopBackground('The screen-off stream could not start. Check that the room is still open and try Safari.');
  });
}

function stopPhone(session, message = '') {
  if (phone !== session) return;
  phone = null;
  session.socket?.close();
  session.playback?.close();
  if (session.context?.state !== 'closed') void session.context?.close().catch(() => {});
  showPhone();
  notice(message);
}

async function listen() {
  stopBackground();
  if (phone) {
    stopPhone(phone);
    return;
  }
  notice();
  useMediaAudioSession();
  const session = { source: null, buffer: BUFFER_MS };
  phone = session;
  try {
    session.context = new AudioContextClass({ latencyHint: 'interactive' });
    showPhone();
    await session.context.resume();
    if (phone !== session) return;
    Object.assign(session, socketFor('/live/room/' + roomId, {
      clock: showPhone,
      playback: () => ({
        source: session.source, playback: session.playback.status(),
        tuneReady: session.clock.ready && session.context.state === 'running',
      }),
      message(message) {
        if (phone !== session) return;
        if (message.type === 'source') {
          session.source = message.source;
          session.playback.reset();
        }
        if (message.type === 'buffer' && PLAYBACK_BUFFERS.includes(message.ms)) {
          session.buffer = message.ms;
          session.playback.reset();
        }
        if (message.type === 'speaker' && SPEAKER_MODES.includes(message.mode)) {
          session.playback.speaker = message.mode;
        }
        if (message.type === 'tune-delay') {
          session.autoDelay = message.delay;
          if (message.resetManual) {
            phoneDelay = 0;
            resetManualDelay('phone-sync');
          }
          applyDelay(session.playback, phoneDelay + session.autoDelay);
        }
        if (message.type === 'tune-state') {
          session.tuning = message.active;
          setTuneMute(session, session.playback, message.active, message.resumeAt);
          if (!message.active && session.tone) {
            session.tone.stop();
            session.tone = null;
          }
        }
        if (message.type === 'tune-tone') {
          let ok = false;
          try {
            if (session.clock.ready) {
              session.tone = playTone(session.context, session.clock, message.at).node;
              ok = true;
            }
          } catch { /* Report an unplayable tone to the host. */ }
          session.socket.send(JSON.stringify({ type: 'tune-ready', id: message.id, ok }));
        }
        showPhone();
      },
      audio(data) {
        if (phone === session && session.source) session.playback.receive(data);
      },
      close(event) {
        stopPhone(session, event.code === 4001
          ? 'The host ended this room. Scan a new QR code to join again.'
          : 'Could not reach this room. Check your Wi-Fi and ask the host if the room is still open.');
      },
    }));
    session.playback = new Playback(session.context, session.clock);
    session.playback.delay = phoneDelay;
    session.playback.volume = 10 ** (phoneBoost / 20);
    session.context.addEventListener('statechange', () => {
      if (phone !== session) return;
      if (session.context.state !== 'running') stopPhone(session, 'Playback was interrupted. Tap Listen to reconnect.');
      else showPhone();
    });
  } catch {
    stopPhone(session, 'The browser could not start playback. Tap Listen to try again.');
  }
}

function renderRoomView() {
  const hosting = !roomId && isHostPage && !joinOnly;
  $('host').hidden = !hosting;
  $('listener').hidden = !roomId;
  $('intro-copy').hidden = !hosting;
  $('host-entry').hidden = !isHostPage || !joinOnly;
  document.body.classList.toggle('entry-layout', hosting && !host?.id);
  if (roomId) {
    $('join-room').hidden = true;
    updateStatus('headline', 'Room audio');
    showPhone();
  } else if (hosting) {
    showHost();
  } else {
    $('join-room').hidden = false;
    updateStatus('headline', 'Join a room');
    updateStatus('room-status', 'Join by code');
  }
}

async function joinRoom(event) {
  event.preventDefault();
  if (joining || host) return;
  const form = event.currentTarget;
  const button = form.querySelector('button');
  const error = $('join-error');
  error.hidden = true;
  $('join-code').removeAttribute('aria-invalid');
  joining = true;
  button.disabled = true;
  button.textContent = 'Checking code…';
  if (!$('host').hidden) showHost();
  try {
    const url = new URL('/join', relayOrigin);
    url.searchParams.set('code', $('join-code').value);
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (response.status === 404) {
      $('join-code').setAttribute('aria-invalid', 'true');
      throw new Error('That code didn’t match an active room. Check the code on the laptop.');
    }
    if (!response.ok) throw new Error('Could not check the room code. Try again.');
    const { id } = await response.json();
    if (!roomPattern.test(id ?? '')) throw new Error('Could not check the room code. Try again.');
    roomId = id;
    history.replaceState(null, '', '/?room=' + id);
    form.reset();
    notice();
    renderRoomView();
    $('listen').focus();
  } catch (failure) {
    error.textContent = failure instanceof TypeError ? 'Could not reach the room server. Check the connection and try again.' : failure.message;
    error.hidden = false;
  } finally {
    joining = false;
    button.disabled = false;
    button.textContent = 'Join room';
    if (!$('host').hidden) showHost();
  }
}

const isCaptureTest = isHostPage && location.pathname === '/' && params.has('test-audio');
const devRevision = document.documentElement.dataset.devRevision;
if (devRevision) {
  $('mode-label').textContent = 'DEV MODE · AUTO-RELOAD';
  async function checkRevision() {
    try {
      const response = await fetch('/dev/revision', { cache: 'no-store' });
      if (response.ok && (await response.text()) !== devRevision) {
        location.reload();
        return;
      }
    } catch {
      // Nodemon briefly takes the relay offline while restarting it.
    }
    setTimeout(checkRevision, 1000);
  }
  setTimeout(checkRevision, 1000);
}
if (!isCaptureTest) {
  setInterval(() => {
    if (roomId) showPhone();
    else if (!$('host').hidden) showHostDiagnostics();
    const session = roomId ? phone : host;
    const playback = roomId ? session?.playback : session?.audio?.playback;
    const stats = [roomId && $('background-audio').hasAttribute('src') ? 'Screen-off stream' : (session?.buffer ?? BUFFER_MS) + ' ms playback buffer'];
    if (session?.clock?.rtt != null) stats.push(session.clock.rtt + ' ms relay RTT');
    if (playback?.late) stats.push(playback.late + ' late blocks');
    $('metrics').textContent = stats.join(' · ');
  }, 750);
}

if (isCaptureTest) {
  document.title = 'Speaker Sync Test Audio';
  $('headline').textContent = 'Test audio.';
  $('intro-copy').hidden = true;
  $('room-status').textContent = 'Test source';
  $('capture-test').hidden = false;
  const button = $('test-tone');
  let context;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (context) {
        await context.close();
        context = null;
        button.textContent = 'Play click';
        return;
      }
      context = new AudioContextClass();
      await context.resume();
      const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < samples.length * 0.022; i++) {
        const t = i / samples.length;
        samples[i] = 0.48 * Math.sin(2 * Math.PI * 1250 * t) * Math.exp(-t / 0.004);
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(context.destination);
      source.start();
      button.textContent = 'Stop click';
    } catch {
      if (context?.state !== 'closed') void context?.close().catch(() => {});
      context = null;
      notice('This browser could not start the test click.');
    } finally {
      button.disabled = false;
    }
  });
} else {
  setupSync('phone-sync', value => {
    phoneDelay = value;
    applyDelay(phone?.playback, value + (phone?.autoDelay ?? 0));
  });
  $('listen').addEventListener('click', listen);
  $('listen-background').addEventListener('click', listenInBackground);
  const backgroundPlayer = $('background-audio');
  for (const event of ['loadeddata', 'playing', 'waiting', 'pause']) {
    backgroundPlayer.addEventListener(event, () => { if (roomId) showPhone(); });
  }
  backgroundPlayer.addEventListener('error', () => stopBackground('The screen-off stream disconnected. Check that the room is still open.'));
  backgroundPlayer.addEventListener('ended', () => stopBackground('The screen-off stream ended.'));
  $('volume-boost').addEventListener('input', event => {
    phoneBoost = Number(event.currentTarget.value);
    $('volume-amount').value = phoneBoost ? '+' + phoneBoost + ' dB' : '0 dB';
    if (phone?.playback) phone.playback.volume = 10 ** (phoneBoost / 20);
  });
  $('join-error').hidden = !params.has('expired') || Boolean(roomId);
  const joinForm = $('join-room').querySelector('form');
  joinForm.addEventListener('submit', joinRoom);
  $('leave-listener').addEventListener('click', () => {
    stopBackground();
    if (phone) stopPhone(phone);
    roomId = undefined;
    joinOnly = true;
    history.replaceState(null, '', '/?join=1');
    notice();
    renderRoomView();
    $('join-code').focus();
  });
  $('host-entry').addEventListener('click', () => {
    joinOnly = false;
    history.replaceState(null, '', '/');
    renderRoomView();
    $('create').focus();
  });
  if (hostedRelay) {
    joinForm.action = relayOrigin + '/join';
    $('join-help').textContent = 'Use the code next to the QR on the laptop.';
    $('intro-copy').textContent = 'Share live audio from this laptop to phones.';
    $('lan-instruction').hidden = true;
  }
  setupSync('host-sync', value => {
    hostDelay = value;
    applyDelay(host?.audio?.playback, value + (host?.autoDelay ?? 0));
  });
  const laptopSpeaker = $('laptop-speaker');
  addSpeakerOptions(laptopSpeaker);
  laptopSpeaker.addEventListener('change', () => {
    if (!host) return;
    host.speaker = laptopSpeaker.value;
    if (host.audio?.playback) host.audio.playback.speaker = host.speaker;
    showSpeakerLayout();
  });
  $('create').addEventListener('click', startHost);
  $('end').addEventListener('click', () => endHost(host));
  $('network').addEventListener('change', updateInvite);
  $('qr').addEventListener('error', () => pairNotice('The QR code could not load. Use the invite link or room code.'));
  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('invite-link').href);
      pairNotice('Invite link copied.');
    } catch {
      pairNotice('Touch and hold or right-click Open invite to copy its address.');
    }
  });
  $('capture').addEventListener('click', () => chooseSource(captureModes[host?.source] ? host.source : $('capture-source').value));
  $('capture-source').addEventListener('change', showCaptureMode);
  $('keep-local').addEventListener('change', showCaptureMode);
  $('playback-buffer').addEventListener('change', event => {
    const ms = Number(event.currentTarget.value);
    if (!host || !PLAYBACK_BUFFERS.includes(ms)) return;
    host.buffer = ms;
    host.audio?.playback?.reset();
    host.socket.send(JSON.stringify({ type: 'buffer', ms }));
  });
  showCaptureMode();
  $('test').addEventListener('click', () => chooseSource('click'));
  $('browser-help').hidden = canShareTab;
  $('copy-host').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(hostAddress);
      pairNotice('Address copied. Paste it into desktop Google Chrome to host.');
    } catch {
      pairNotice('Open ' + hostAddress + ' directly in desktop Google Chrome.');
    }
  });
  renderRoomView();
}
