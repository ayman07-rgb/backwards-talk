'use strict';
/**
 * Talk Backwards — client
 * ------------------------------------------------------------
 * 1. MediaRecorder captures the microphone (webm/mp4/ogg depending on browser).
 * 2. Web Audio API decodes it into an AudioBuffer.
 * 3. We reverse every channel of the AudioBuffer in place.
 * 4. The reversed audio is encoded as a 16-bit WAV (plays in every browser).
 * 5. Socket.io sends the WAV bytes to the server, which relays them to player 2.
 */

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */
const SERVER_URL = (window.APP_CONFIG && window.APP_CONFIG.SERVER_URL) || undefined; // undefined = same origin
const socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });

const MAX_RECORD_SECONDS = 8;
const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  screens: { home: $('screen-home'), lobby: $('screen-lobby'), game: $('screen-game') },
  panels: { speak: $('panel-speak'), wait: $('panel-wait'), guess: $('panel-guess'), result: $('panel-result') },
};

let state = null;              // latest room state from the server
let lastRound = -1;            // used to reset the recorder when a new round starts
let audioCtx = null;           // created lazily on first user gesture (autoplay policies)

// Recorder state
let mediaStream = null;
let mediaRecorder = null;
let chunks = [];
let recTimer = null;
let recStartedAt = 0;
let reversedWav = null;        // ArrayBuffer ready to send
let previewUrl = null;
let guessUrl = null;

/* ------------------------------------------------------------------ */
/* Connection status                                                   */
/* ------------------------------------------------------------------ */
function setStatus(stateName, text) {
  els.status.dataset.state = stateName;
  els.status.textContent = text;
}
socket.on('connect', () => setStatus('online', 'Online'));
socket.on('disconnect', () => { setStatus('offline', 'Disconnected'); showScreen('home'); });
socket.on('connect_error', () => setStatus('offline', 'Server unreachable'));

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */
function showScreen(name) {
  Object.entries(els.screens).forEach(([key, el]) => (el.hidden = key !== name));
}
function showPanel(name) {
  Object.entries(els.panels).forEach(([key, el]) => (el.hidden = key !== name));
}

/* ------------------------------------------------------------------ */
/* Home: create / join                                                 */
/* ------------------------------------------------------------------ */
const nameInput = $('name');
nameInput.value = localStorage.getItem('bt-name') || '';

// An invite link looks like https://yoursite/?room=ABCD
const invited = new URLSearchParams(location.search).get('room');
if (invited) $('code').value = invited.toUpperCase().slice(0, 4);

function getName() {
  const name = nameInput.value.trim();
  if (name) localStorage.setItem('bt-name', name);
  return name;
}
function homeError(msg) { $('home-error').textContent = msg || ''; }

$('btn-create').addEventListener('click', () => {
  homeError('');
  socket.emit('room:create', { name: getName() }, (res) => {
    if (!res.ok) homeError(res.error);
  });
});

$('btn-join').addEventListener('click', () => {
  homeError('');
  const code = $('code').value.trim();
  if (code.length !== 4) return homeError('Enter the 4-letter room code.');
  socket.emit('room:join', { name: getName(), code }, (res) => {
    if (!res.ok) homeError(res.error);
  });
});

function leaveRoom() {
  socket.emit('room:leave');
  stopStream();
  state = null;
  lastRound = -1;
  history.replaceState(null, '', location.pathname);
  showScreen('home');
}
$('btn-leave-lobby').addEventListener('click', leaveRoom);
$('btn-leave-game').addEventListener('click', leaveRoom);

$('btn-copy').addEventListener('click', async () => {
  const link = `${location.origin}${location.pathname}?room=${state.code}`;
  try {
    await navigator.clipboard.writeText(link);
    $('btn-copy').textContent = 'Link copied!';
  } catch {
    $('btn-copy').textContent = link; // clipboard blocked: show the link instead
  }
});

/* ------------------------------------------------------------------ */
/* Rendering room state                                                */
/* ------------------------------------------------------------------ */
socket.on('room:peer-left', () => {
  // The server already moved the room back to the lobby; just clean up local audio.
  stopStream();
  resetRecorderUI();
});

socket.on('room:state', (s) => {
  state = s;
  render(s);
});

function render(s) {
  if (s.phase === 'waiting') {
    $('lobby-code').textContent = s.code;
    $('btn-copy').textContent = 'Copy invite link';
    showScreen('lobby');
    return;
  }

  showScreen('game');
  renderScoreboard(s);

  // New round => wipe leftover recording/audio from the previous one
  if (s.round !== lastRound) {
    lastRound = s.round;
    resetRecorderUI();
    clearGuessAudio();
    $('guess').value = '';
    $('secret').value = '';
  }

  const other = s.players.find((p) => p.id !== socket.id);
  const iAmSpeaker = s.speakerId === socket.id;
  const otherName = other ? other.name : 'your friend';

  if (s.phase === 'recording') {
    if (iAmSpeaker) {
      showPanel('speak');
    } else {
      $('wait-title').textContent = `${otherName} is recording…`;
      $('wait-text').textContent = 'Get ready to listen. The audio will play backwards.';
      $('wait-guesses').innerHTML = '';
      showPanel('wait');
    }
  }

  if (s.phase === 'guessing') {
    if (iAmSpeaker) {
      $('wait-title').textContent = `${otherName} is listening…`;
      $('wait-text').textContent = `Attempts left: ${s.attemptsLeft}`;
      renderGuesses($('wait-guesses'), s.guesses);
      showPanel('wait');
    } else {
      $('attempts').textContent = `Attempts left: ${s.attemptsLeft}`;
      renderGuesses($('guess-history'), s.guesses);
      showPanel('guess');
    }
  }

  if (s.phase === 'result') {
    const guesser = s.players.find((p) => p.id !== s.speakerId);
    const guesserName = guesser && guesser.id === socket.id ? 'You' : (guesser ? guesser.name : 'Player');
    $('result-title').textContent = s.result.correct
      ? `${guesserName} got it!`
      : 'Not this time. The word was:';
    $('result-word').textContent = s.result.word;
    showPanel('result');
  }
}

function renderScoreboard(s) {
  const box = $('scores');
  box.innerHTML = '';
  s.players.forEach((p) => {
    const div = document.createElement('div');
    div.className = 'score' + (p.id === s.speakerId ? ' is-speaker' : '') + (p.id === socket.id ? ' is-me' : '');
    const name = document.createElement('span');
    name.textContent = p.name;
    const pts = document.createElement('b');
    pts.textContent = p.score;
    div.append(name, pts);
    box.appendChild(div);
  });
  $('round-label').textContent = `Round ${s.round}`;
}

function renderGuesses(listEl, guesses) {
  listEl.innerHTML = '';
  guesses.forEach((g) => {
    const li = document.createElement('li');
    li.textContent = g; // textContent: never inject user text as HTML
    listEl.appendChild(li);
  });
}

/* ------------------------------------------------------------------ */
/* Speaker: record -> reverse -> preview -> send                       */
/* ------------------------------------------------------------------ */
function getAudioContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

/** Pick a MediaRecorder format the current browser supports. */
function pickMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return candidates.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

function speakError(msg) { $('speak-error').textContent = msg || ''; }

function stopStream() {
  clearInterval(recTimer);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.onstop = null;
    try { mediaRecorder.stop(); } catch { /* already stopped */ }
  }
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
  mediaStream = null;
  mediaRecorder = null;
}

function resetRecorderUI() {
  stopStream();
  reversedWav = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  $('preview').hidden = true;
  $('preview-audio').removeAttribute('src');
  $('btn-record').hidden = false;
  $('btn-record').textContent = 'Start recording';
  $('btn-record').classList.remove('is-recording');
  $('btn-send').disabled = false;
  $('rec-timer').textContent = '';
  speakError('');
}

async function startRecording() {
  speakError('');
  if (!$('secret').value.trim()) return speakError('Type the secret word first.');
  if (!window.MediaRecorder || !navigator.mediaDevices) {
    return speakError('Recording is not supported in this browser (or the page is not on HTTPS).');
  }

  try {
    getAudioContext(); // unlock audio inside this click
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    return speakError('Microphone access was blocked. Allow it in your browser settings and try again.');
  }

  const mimeType = pickMimeType();
  mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
  chunks = [];
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  mediaRecorder.onstop = handleRecordingStopped;
  mediaRecorder.start();

  recStartedAt = Date.now();
  $('btn-record').textContent = 'Stop';
  $('btn-record').classList.add('is-recording');
  recTimer = setInterval(() => {
    const secs = (Date.now() - recStartedAt) / 1000;
    $('rec-timer').textContent = `${secs.toFixed(1)} s / ${MAX_RECORD_SECONDS} s`;
    if (secs >= MAX_RECORD_SECONDS) stopRecording(); // hard cap keeps uploads small
  }, 100);
}

function stopRecording() {
  clearInterval(recTimer);
  if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
}

$('btn-record').addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') stopRecording();
  else startRecording();
});

async function handleRecordingStopped() {
  const type = (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm';
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop()); // release the mic light
  $('btn-record').classList.remove('is-recording');
  $('btn-record').hidden = true;
  $('rec-timer').textContent = 'Reversing…';

  try {
    const encoded = await new Blob(chunks, { type }).arrayBuffer();
    const decoded = await decodeAudio(encoded);
    reverseAudioBuffer(decoded);
    reversedWav = audioBufferToWav(decoded);

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([reversedWav], { type: 'audio/wav' }));
    $('preview-audio').src = previewUrl;
    $('preview').hidden = false;
    $('rec-timer').textContent = '';
  } catch (err) {
    console.error(err);
    resetRecorderUI();
    speakError('Could not process that recording. Please try again.');
  }
}

/** decodeAudioData with a callback fallback for older Safari. */
function decodeAudio(arrayBuffer) {
  return new Promise((resolve, reject) => {
    const p = getAudioContext().decodeAudioData(arrayBuffer, resolve, reject);
    if (p && p.catch) p.catch(reject);
  });
}

/** The core trick: flip every channel of the AudioBuffer in place. */
function reverseAudioBuffer(buffer) {
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    buffer.getChannelData(c).reverse(); // Float32Array.reverse()
  }
  return buffer;
}

/** Encode an AudioBuffer as a mono 16-bit PCM WAV (normalized so quiet voices are audible). */
function audioBufferToWav(buffer) {
  const length = buffer.length;
  const channels = buffer.numberOfChannels;

  // Mix down to mono
  const mono = new Float32Array(length);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += data[i] / channels;
  }

  // Normalize to ~90% of full scale (gain capped so we don't blow up pure noise)
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(mono[i]));
  const gain = peak > 0 ? Math.min(0.9 / peak, 4) : 1;

  const out = new ArrayBuffer(44 + length * 2);
  const view = new DataView(out);
  const writeText = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };

  writeText(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);                 // PCM header size
  view.setUint16(20, 1, true);                  // format: PCM
  view.setUint16(22, 1, true);                  // channels: mono
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);                  // block align
  view.setUint16(34, 16, true);                 // bits per sample
  writeText(36, 'data');
  view.setUint32(40, length * 2, true);

  let offset = 44;
  for (let i = 0; i < length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, mono[i] * gain));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

$('btn-rerecord').addEventListener('click', resetRecorderUI);

$('btn-send').addEventListener('click', () => {
  speakError('');
  if (!reversedWav) return;
  $('btn-send').disabled = true;
  socket.emit('audio:send', { audio: reversedWav, word: $('secret').value }, (res) => {
    if (!res.ok) {
      $('btn-send').disabled = false;
      speakError(res.error);
    }
    // On success the server broadcasts the new room state and the UI moves on.
  });
});

/* ------------------------------------------------------------------ */
/* Guesser: receive audio, guess                                       */
/* ------------------------------------------------------------------ */
socket.on('audio:reversed', ({ audio }) => {
  clearGuessAudio();
  guessUrl = URL.createObjectURL(new Blob([audio], { type: 'audio/wav' }));
  const player = $('guess-audio');
  player.src = guessUrl;
  player.play().catch(() => { /* autoplay blocked: the player controls are right there */ });
});

function clearGuessAudio() {
  if (guessUrl) URL.revokeObjectURL(guessUrl);
  guessUrl = null;
  $('guess-audio').removeAttribute('src');
}

function submitGuess() {
  const guess = $('guess').value.trim();
  if (!guess) return;
  socket.emit('guess:submit', { guess });
  $('guess').value = '';
  $('guess').focus();
}
$('btn-guess').addEventListener('click', submitGuess);
$('guess').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitGuess(); });
$('btn-giveup').addEventListener('click', () => socket.emit('round:giveup'));

/* ------------------------------------------------------------------ */
/* Next round                                                          */
/* ------------------------------------------------------------------ */
$('btn-next').addEventListener('click', () => socket.emit('round:next'));
