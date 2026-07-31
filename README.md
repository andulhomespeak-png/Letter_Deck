# Letter Deck Live Room

Teacher view and student join flow for the classroom letter game.

## Local run

1. Open `outputs/Start-Letter-Room.bat`
2. Teacher view opens at `http://localhost:8787/`

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
