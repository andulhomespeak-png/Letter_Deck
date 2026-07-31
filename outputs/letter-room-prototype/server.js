const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const WORDS_FILE = path.join(ROOT, "..", "english-words.js");

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const rooms = new Map();

const wordsRaw = fs.readFileSync(WORDS_FILE, "utf8");
const rawMatch = wordsRaw.match(/`([\s\S]*)`;/);
if (!rawMatch) {
  throw new Error("Could not parse english-words.js");
}
const dictionary = new Set(rawMatch[1].split("\n").map((word) => word.trim()).filter(Boolean));

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const typeMap = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": typeMap[ext] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function drawLetter() {
  return alphabet[Math.floor(Math.random() * alphabet.length)];
}

function generateCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: 5 }, () => letters[Math.floor(Math.random() * letters.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const code = generateCode();
  const now = Date.now();
  const room = {
    code,
    createdAt: now,
    updatedAt: now,
    round: 1,
    letters: [drawLetter(), drawLetter()],
    nextTeamId: 3,
    nextPlayerId: 1,
    teams: [
      { id: "team-1", name: "Team 1", score: 0 },
      { id: "team-2", name: "Team 2", score: 0 }
    ],
    players: [],
    submissions: [],
    lastWinner: null
  };
  rooms.set(code, room);
  return room;
}

function serializeRoom(room) {
  return {
    code: room.code,
    round: room.round,
    letters: room.letters,
    teams: room.teams,
    players: room.players,
    submissions: room.submissions.slice(0, 12),
    lastWinner: room.lastWinner,
    updatedAt: room.updatedAt
  };
}

function touch(room) {
  room.updatedAt = Date.now();
}

function getRoom(code) {
  const room = rooms.get(String(code || "").toUpperCase());
  if (!room) {
    throw new Error("Room not found");
  }
  return room;
}

function ensureLetters(room) {
  while (room.letters.length < 2) {
    room.letters.push(drawLetter());
  }
}

function consumeLetters(room, word) {
  const first = word[0];
  const last = word[word.length - 1];
  let firstRemoved = false;
  let lastRemoved = false;
  room.letters = room.letters.filter((letter) => {
    if (!firstRemoved && letter === first) {
      firstRemoved = true;
      return false;
    }
    if (!lastRemoved && letter === last) {
      lastRemoved = true;
      return false;
    }
    return true;
  });
}

function addSubmission(room, entry) {
  room.submissions.unshift(entry);
  room.submissions = room.submissions.slice(0, 12);
  touch(room);
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "POST" && url.pathname === "/api/teacher/create-room") {
      const room = createRoom();
      return sendJson(res, 200, { room: serializeRoom(room) });
    }

    if (req.method === "GET" && url.pathname === "/api/room") {
      const room = getRoom(url.searchParams.get("code"));
      return sendJson(res, 200, { room: serializeRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/teacher/add-card") {
      const { code } = await readBody(req);
      const room = getRoom(code);
      if (room.letters.length < 2) {
        ensureLetters(room);
      } else {
        room.letters.push(drawLetter());
      }
      room.lastWinner = null;
      touch(room);
      return sendJson(res, 200, { room: serializeRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/teacher/reset-round") {
      const { code } = await readBody(req);
      const room = getRoom(code);
      room.round += 1;
      room.letters = [drawLetter(), drawLetter()];
      room.lastWinner = null;
      touch(room);
      return sendJson(res, 200, { room: serializeRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/teacher/reset-scores") {
      const { code } = await readBody(req);
      const room = getRoom(code);
      room.teams.forEach((team) => {
        team.score = 0;
      });
      room.lastWinner = null;
      touch(room);
      return sendJson(res, 200, { room: serializeRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/teacher/add-team") {
      const { code } = await readBody(req);
      const room = getRoom(code);
      const team = {
        id: `team-${room.nextTeamId}`,
        name: `Team ${room.nextTeamId}`,
        score: 0
      };
      room.nextTeamId += 1;
      room.teams.push(team);
      touch(room);
      return sendJson(res, 200, { room: serializeRoom(room), team });
    }

    if (req.method === "POST" && url.pathname === "/api/teacher/rename-team") {
      const { code, teamId, name } = await readBody(req);
      const room = getRoom(code);
      const team = room.teams.find((item) => item.id === teamId);
      if (!team) {
        throw new Error("Team not found");
      }
      team.name = String(name || "").trim() || team.name;
      touch(room);
      return sendJson(res, 200, { room: serializeRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/student/join") {
      const { code, name, teamId } = await readBody(req);
      const room = getRoom(code);
      const cleanName = String(name || "").trim();
      if (!cleanName) {
        throw new Error("Name is required");
      }
      const team = room.teams.find((item) => item.id === teamId);
      if (!team) {
        throw new Error("Team not found");
      }
      const player = {
        id: `player-${room.nextPlayerId++}`,
        name: cleanName,
        teamId: team.id
      };
      room.players.push(player);
      touch(room);
      return sendJson(res, 200, { player, room: serializeRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/student/submit") {
      const { code, playerId, word } = await readBody(req);
      const room = getRoom(code);
      const player = room.players.find((item) => item.id === playerId);
      if (!player) {
        throw new Error("Player not found");
      }

      const normalized = String(word || "").trim().toLowerCase();
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        playerId,
        playerName: player.name,
        teamId: player.teamId,
        teamName: room.teams.find((team) => team.id === player.teamId)?.name || "Unknown",
        word: normalized,
        ok: false,
        reason: "",
        createdAt: Date.now()
      };

      if (!normalized || normalized.length < 2) {
        entry.reason = "Too short";
        addSubmission(room, entry);
        return sendJson(res, 200, { ok: false, reason: entry.reason, room: serializeRoom(room) });
      }
      if (!/^[a-z]+$/.test(normalized)) {
        entry.reason = "Use A-Z only";
        addSubmission(room, entry);
        return sendJson(res, 200, { ok: false, reason: entry.reason, room: serializeRoom(room) });
      }
      if (!dictionary.has(normalized)) {
        entry.reason = "Not in dictionary";
        addSubmission(room, entry);
        return sendJson(res, 200, { ok: false, reason: entry.reason, room: serializeRoom(room) });
      }

      const upper = normalized.toUpperCase();
      const first = upper[0];
      const last = upper[upper.length - 1];
      if (!(room.letters.includes(first) && room.letters.includes(last))) {
        entry.reason = "Wrong letters";
        addSubmission(room, entry);
        return sendJson(res, 200, { ok: false, reason: entry.reason, room: serializeRoom(room) });
      }

      const team = room.teams.find((item) => item.id === player.teamId);
      team.score += 1;
      consumeLetters(room, upper);
      if (room.letters.length <= 1) {
        ensureLetters(room);
        room.round += 1;
      }
      room.lastWinner = {
        playerName: player.name,
        teamId: player.teamId,
        teamName: team.name,
        word: normalized,
        createdAt: Date.now()
      };

      entry.ok = true;
      entry.reason = "Point awarded";
      addSubmission(room, entry);
      return sendJson(res, 200, { ok: true, room: serializeRoom(room), winner: room.lastWinner });
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Request failed" });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    return handleApi(req, res, url);
  }

  if (req.method !== "GET") {
    res.writeHead(405);
    return res.end("Method not allowed");
  }

  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const filePath = path.join(PUBLIC, requested);
  if (!filePath.startsWith(PUBLIC) || !fs.existsSync(filePath)) {
    res.writeHead(404);
    return res.end("Not found");
  }

  sendFile(res, filePath);
});

server.listen(PORT, HOST, () => {
  console.log(`Letter room prototype running at http://localhost:${PORT}`);
});
