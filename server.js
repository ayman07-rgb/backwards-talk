'use strict';
/**
 * Backwards Talk — backend
 * ------------------------------------------------------------
 * - Express serves the static frontend from /public
 * - Socket.io handles rooms (max 2 players), turns, scoring
 * - The server NEVER processes audio: the speaker's browser reverses it
 *   and uploads a ready-to-play WAV; we only relay the bytes.
 *
 * Env vars (all optional):
 *   PORT           port to listen on (hosts like Render set this for you)
 *   CLIENT_ORIGIN  allowed frontend origin(s), comma separated, when the
 *                  frontend is hosted elsewhere (Vercel/Netlify). Default "*".
 */
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';

const MAX_AUDIO_BYTES = 2.5 * 1024 * 1024; // reject uploads bigger than this
const MAX_ATTEMPTS = 3;                    // guesses per round
const MAX_NAME_LEN = 20;
const MAX_WORD_LEN = 40;

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN === '*' ? '*' : CLIENT_ORIGIN.split(',').map((s) => s.trim()),
  },
  maxHttpBufferSize: 3e6, // ~3 MB, enough for a few seconds of WAV
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

/* ------------------------------------------------------------------ */
/* Room state                                                          */
/* ------------------------------------------------------------------ */

/**
 * room = {
 *   code, players: [{ id, name, score }], speakerIdx: 0 | 1,
 *   phase: 'waiting' | 'recording' | 'guessing' | 'result',
 *   round, secret: { raw, norm } | null, attemptsLeft, guesses: [], result
 * }
 */
const rooms = new Map();

/** 4-letter room code, no ambiguous letters (I/O). */
function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

/** Lowercase, strip accents/diacritics and punctuation so "Café!" == "cafe". Works for Arabic too. */
function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

const cleanName = (n) => String(n || '').trim().slice(0, MAX_NAME_LEN) || 'Player';

/** What clients are allowed to see — the secret word is NOT included. */
function publicState(room) {
  const speaker = room.players[room.speakerIdx];
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    speakerId: speaker ? speaker.id : null,
    attemptsLeft: room.attemptsLeft,
    guesses: room.guesses,
    result: room.result, // only filled once the round is over
    players: room.players.map((p) => ({ id: p.id, name: p.name, score: p.score })),
  };
}

const broadcast = (room) => io.to(room.code).emit('room:state', publicState(room));

function startRound(room) {
  room.phase = 'recording';
  room.round += 1;
  room.secret = null;
  room.attemptsLeft = MAX_ATTEMPTS;
  room.guesses = [];
  room.result = null;
}

function finishRound(room, correct) {
  room.phase = 'result';
  room.result = { correct, word: room.secret ? room.secret.raw : '' };
  broadcast(room);
}

function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  socket.leave(code);
  socket.data.roomCode = null;

  const room = rooms.get(code);
  if (!room) return;

  room.players = room.players.filter((p) => p.id !== socket.id);
  if (room.players.length === 0) {
    rooms.delete(code);
    return;
  }
  // One player left: go back to the lobby and wait for a new friend.
  room.phase = 'waiting';
  room.speakerIdx = 0;
  room.round = 0;
  room.secret = null;
  room.result = null;
  room.guesses = [];
  io.to(code).emit('room:peer-left');
  broadcast(room);
}

/* ------------------------------------------------------------------ */
/* Socket handlers                                                     */
/* ------------------------------------------------------------------ */

io.on('connection', (socket) => {
  const getRoom = () => rooms.get(socket.data.roomCode);

  // --- Create a room ---------------------------------------------------
  socket.on('room:create', ({ name } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    leaveRoom(socket);

    const room = {
      code: makeCode(),
      players: [{ id: socket.id, name: cleanName(name), score: 0 }],
      speakerIdx: 0,
      phase: 'waiting',
      round: 0,
      secret: null,
      attemptsLeft: MAX_ATTEMPTS,
      guesses: [],
      result: null,
    };
    rooms.set(room.code, room);
    socket.join(room.code);
    socket.data.roomCode = room.code;

    reply({ ok: true, code: room.code });
    broadcast(room);
  });

  // --- Join a room -----------------------------------------------------
  socket.on('room:join', ({ name, code } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const roomCode = String(code || '').trim().toUpperCase();
    const room = rooms.get(roomCode);

    if (!room) return reply({ ok: false, error: 'Room not found. Check the code.' });
    if (room.players.length >= 2) return reply({ ok: false, error: 'This room is already full.' });

    leaveRoom(socket);
    room.players.push({ id: socket.id, name: cleanName(name), score: 0 });
    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    startRound(room); // two players present: the game begins
    reply({ ok: true, code: roomCode });
    broadcast(room);
  });

  // --- Speaker uploads the already-reversed audio ------------------------
  socket.on('audio:send', ({ audio, word } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = getRoom();
    if (!room || room.phase !== 'recording') return reply({ ok: false, error: 'Not your moment to record.' });

    const speaker = room.players[room.speakerIdx];
    if (!speaker || speaker.id !== socket.id) return reply({ ok: false, error: 'Only the speaker can send audio.' });
    if (!Buffer.isBuffer(audio) || audio.length === 0 || audio.length > MAX_AUDIO_BYTES) {
      return reply({ ok: false, error: 'Audio is missing or too large. Try a shorter recording.' });
    }

    const raw = String(word || '').trim().slice(0, MAX_WORD_LEN);
    const norm = normalize(raw);
    if (!norm) return reply({ ok: false, error: 'Type the secret word first.' });

    room.secret = { raw, norm };
    room.phase = 'guessing';

    const guesser = room.players[1 - room.speakerIdx];
    io.to(guesser.id).emit('audio:reversed', { audio, round: room.round }); // relay bytes as-is
    reply({ ok: true });
    broadcast(room);
  });

  // --- Guesser submits a guess ------------------------------------------
  socket.on('guess:submit', ({ guess } = {}) => {
    const room = getRoom();
    if (!room || room.phase !== 'guessing') return;
    const guesser = room.players[1 - room.speakerIdx];
    if (!guesser || guesser.id !== socket.id) return;

    const text = String(guess || '').trim().slice(0, MAX_WORD_LEN);
    if (!normalize(text)) return;

    if (normalize(text) === room.secret.norm) {
      guesser.score += 1;
      return finishRound(room, true);
    }
    room.guesses.push(text);
    room.attemptsLeft -= 1;
    if (room.attemptsLeft <= 0) return finishRound(room, false);
    broadcast(room);
  });

  // --- Guesser gives up ---------------------------------------------------
  socket.on('round:giveup', () => {
    const room = getRoom();
    if (!room || room.phase !== 'guessing') return;
    const guesser = room.players[1 - room.speakerIdx];
    if (guesser && guesser.id === socket.id) finishRound(room, false);
  });

  // --- Next round: roles swap ---------------------------------------------
  socket.on('round:next', () => {
    const room = getRoom();
    if (!room || room.phase !== 'result' || room.players.length < 2) return;
    room.speakerIdx = 1 - room.speakerIdx;
    startRound(room);
    broadcast(room);
  });

  socket.on('room:leave', () => leaveRoom(socket));
  socket.on('disconnect', () => leaveRoom(socket));
});

server.listen(PORT, () => console.log(`Backwards Talk running on http://localhost:${PORT}`));
