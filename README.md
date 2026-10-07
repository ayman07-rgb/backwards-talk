# Talk Backwards

Real-time 2-player game. Player 1 says a word, their browser reverses the audio,
Player 2 hears it backwards and tries to guess. Roles swap every round.

## Structure
```
backwards-talk/
├── package.json
├── server.js          # Express + Socket.io (rooms, turns, scoring, audio relay)
└── public/
    ├── index.html     # UI
    ├── style.css
    ├── config.js      # SERVER_URL (only needed if frontend is hosted separately)
    └── app.js         # MediaRecorder + Web Audio reversal + Socket.io client
```

## Run locally
1. Install Node.js 18+.
2. `npm install`
3. `npm start`
4. Open http://localhost:3000 in two tabs (or two browsers), create a room in one, join with the code in the other.

Microphones only work on HTTPS or localhost, so testing from a phone on your Wi-Fi
(http://192.168.x.x:3000) won't record. Test on the deployed HTTPS URL instead.

## Deploy free (recommended: everything on Render)
1. Push this folder to a GitHub repo.
2. render.com → New → Web Service → connect the repo.
3. Runtime: Node · Build command: `npm install` · Start command: `npm start` · Plan: Free.
4. Open the `https://xxx.onrender.com` URL and share the invite link with your friend.

The free plan sleeps after ~15 min idle, so the first load can take ~50 s. Rooms live in memory and reset on restart.

## Optional: frontend on Vercel/Netlify, backend on Render
1. Deploy the backend on Render as above. Set the env var `CLIENT_ORIGIN` to your frontend URL (e.g. `https://my-game.vercel.app`).
2. In `public/config.js`, set `SERVER_URL` to your Render URL.
3. Vercel/Netlify: import the repo, framework "Other", no build command, output directory `public`.
