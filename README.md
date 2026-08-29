# Letter Deck Live Room

Teacher view and student join flow for the classroom letter game.

## Local run

1. Open `outputs/Start-Letter-Room.bat`
2. Teacher view opens at `http://localhost:8787/`

## Friendzy QR rule

The Friendzy QR is a single classroom-session identity shared by every activity. It must remain unchanged for the lifetime of a running server. Only an explicit teacher `Reset` or a server restart may create a new QR; navigation, polling, activity changes, player updates, synchronization errors, and inactivity must never replace it.

## Deploy to Render

This project is already prepared for Render with:

- `package.json`
- `render.yaml`

Recommended service type:

- `Web Service`
- `Node`
- `Free` for testing, `Paid` if you want more reliable classroom use

Important note:

- Live room state is currently stored in memory.
- If the service restarts or sleeps, the current room is lost.

## Main files

- `outputs/letter-card-game.html`
- `outputs/student.html`
- `outputs/live-room-server.js`
