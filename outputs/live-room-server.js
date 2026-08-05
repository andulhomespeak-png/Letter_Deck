const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = path.join(__dirname);
const TEACHER_HTML = path.join(ROOT, "letter-card-game.html");
const STUDENT_HTML = path.join(ROOT, "student.html");
const WORDS_JS = path.join(ROOT, "english-words.js");

const rooms = new Map();
const roomSockets = new Map();

function loadDictionary() {
  const source = fs.readFileSync(WORDS_JS, "utf8");
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "english-words.js" });
  const raw = String(sandbox.window.ENGLISH_WORDS_RAW || "");
  return new Set(raw.split("\n"));
}

const dictionary = loadDictionary();
const letterPoints = {
  A: 1, E: 1, I: 1, O: 1, N: 1, R: 1, T: 1, L: 1, S: 1, U: 1,
  D: 2, G: 2,
  B: 3, C: 3, M: 3, P: 3,
  F: 4, H: 4, V: 4, W: 4, Y: 4,
  K: 5,
  J: 8, X: 8,
  Q: 10, Z: 10
};
const winningScore = 1000;
const stealBonusPerLetter = 2;

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function html(res, filePath) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(fs.readFileSync(filePath, "utf8"));
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  return "application/octet-stream";
}

function asset(res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Cache-Control": "no-store"
  });
  res.end(fs.readFileSync(filePath));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error("Body too large"));
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

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const room = {
    code: makeCode(),
    status: "waiting",
    letters: [],
    roundId: 1,
    teams: [],
    players: [],
    submissions: [],
    lastSuccess: null,
    lastFeedback: null,
    podium: [],
    nextPlayerId: 1,
    updatedAt: Date.now()
  };
  rooms.set(room.code, room);
  return room;
}

function getRoom(code) {
  const room = rooms.get(String(code || "").toUpperCase());
  if (!room) throw new Error("Room not found");
  return room;
}

function touch(room) {
  room.updatedAt = Date.now();
}

function getRoomSocketSet(code) {
  const key = String(code || "").toUpperCase();
  if (!roomSockets.has(key)) {
    roomSockets.set(key, new Set());
  }
  return roomSockets.get(key);
}

function detachSocket(socket) {
  const code = socket._roomCode;
  if (!code || !roomSockets.has(code)) {
    return;
  }
  const sockets = roomSockets.get(code);
  sockets.delete(socket);
  if (!sockets.size) {
    roomSockets.delete(code);
  }
}

function encodeWebSocketText(text) {
  const payload = Buffer.from(String(text || ""), "utf8");
  const length = payload.length;
  if (length < 126) {
    return Buffer.concat([Buffer.from([0x81, length]), payload]);
  }
  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

function sendWebSocketJson(socket, payload) {
  if (!socket || socket.destroyed || !socket.writable) {
    return;
  }
  socket.write(encodeWebSocketText(JSON.stringify(payload)));
}

function broadcastRoom(room) {
  const sockets = roomSockets.get(room.code);
  if (!sockets || !sockets.size) {
    return;
  }
  const payload = { type: "room", room: serialize(room) };
  sockets.forEach((socket) => {
    try {
      sendWebSocketJson(socket, payload);
    } catch (_) {
      detachSocket(socket);
    }
  });
}

function serialize(room) {
  return {
    code: room.code,
    status: room.status,
    letters: room.letters,
    roundId: room.roundId,
    teams: room.teams,
    submissions: room.submissions.slice(0, 12),
    lastSuccess: room.lastSuccess,
    lastFeedback: room.lastFeedback,
    podium: room.podium,
    updatedAt: room.updatedAt
  };
}

function getLengthBonus(length) {
  if (length >= 8) return 15;
  if (length === 7) return 10;
  if (length === 6) return 6;
  if (length === 5) return 3;
  if (length === 4) return 1;
  return 0;
}

function getLetterCounts(items) {
  return items.reduce((counts, item) => {
    counts[item] = (counts[item] || 0) + 1;
    return counts;
  }, {});
}

function getWordTableUsage(activeLetters, word) {
  const available = getLetterCounts(activeLetters);
  const consumed = {};
  const first = word[0];
  const last = word[word.length - 1];

  if (!available[first]) {
    return null;
  }
  available[first] -= 1;
  consumed[first] = (consumed[first] || 0) + 1;

  if (!available[last]) {
    return null;
  }
  available[last] -= 1;
  consumed[last] = (consumed[last] || 0) + 1;

  let stolenLetters = 0;
  for (let index = 1; index < word.length - 1; index += 1) {
    const letter = word[index];
    if (available[letter] > 0) {
      available[letter] -= 1;
      consumed[letter] = (consumed[letter] || 0) + 1;
      stolenLetters += 1;
    }
  }

  return { consumed, stolenLetters };
}

function getWordScore(word, stolenLetters = 0) {
  const lettersScore = word
    .split("")
    .reduce((total, letter) => total + (letterPoints[letter] || 0), 0);
  const lengthBonus = getLengthBonus(word.length);
  const stealBonus = stolenLetters * stealBonusPerLetter;
  return {
    lettersScore,
    lengthBonus,
    stealBonus,
    stolenLetters,
    total: lettersScore + lengthBonus + stealBonus
  };
}

function consumeLetters(activeLetters, consumedLetters) {
  const remaining = { ...consumedLetters };
  return activeLetters.filter((letter) => {
    if (remaining[letter] > 0) {
      remaining[letter] -= 1;
      return false;
    }
    return true;
  });
}

function evaluateSubmission(room, submission) {
  const rawWord = String(submission.word || "").trim().toLowerCase();
  const word = rawWord.toUpperCase();
  if (room.letters.length < 2) {
    return { ok: false, message: "Need 2 cards on the table first." };
  }
  if (rawWord.length < 2) {
    return { ok: false, message: "Type a longer word." };
  }
  if (!/^[a-z]+$/.test(rawWord)) {
    return { ok: false, message: "Use only letters A-Z." };
  }
  if (!dictionary.has(rawWord)) {
    return { ok: false, message: `"${rawWord}" is not in the local dictionary.` };
  }
  const usage = getWordTableUsage(room.letters, word);
  if (!usage) {
    return {
      ok: false,
      message: `"${rawWord}" is real, but it must start and end with ${room.letters.join(" / ")}.`
    };
  }
  return { ok: true, rawWord, word, usage };
}

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry && entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }
  return "localhost";
}

function getPublicOrigin(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = forwardedHost || req.headers.host || `localhost:${PORT}`;
  const proto = forwardedProto || (String(host).includes("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "GET" && url.pathname === "/") return html(res, TEACHER_HTML);
    if (req.method === "GET" && url.pathname === "/student.html") return html(res, STUDENT_HTML);
    if (req.method === "GET" && url.pathname === "/english-words.js") {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(fs.readFileSync(path.join(ROOT, "english-words.js"), "utf8"));
    }
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const assetPath = path.join(ROOT, relativePath);
      if (assetPath.startsWith(ROOT) && fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
        return asset(res, assetPath);
      }
    }
    if (req.method === "GET" && url.pathname === "/api/live/server-info") {
      const publicOrigin = getPublicOrigin(req);
      return json(res, 200, {
        host: getLocalIp(),
        port: PORT,
        localOrigin: `http://${getLocalIp()}:${PORT}`,
        publicOrigin,
        teacherUrl: `${publicOrigin}/`
      });
    }

    if (req.method === "POST" && url.pathname === "/api/live/create-room") {
      return json(res, 200, { room: serialize(createRoom()) });
    }

    if (req.method === "GET" && url.pathname === "/api/live/room") {
      return json(res, 200, { room: serialize(getRoom(url.searchParams.get("code"))) });
    }

    if (req.method === "POST" && url.pathname === "/api/live/sync") {
      const { code, letters, status, lastSuccess, lastFeedback, teams, podium, clearSubmissions } = await body(req);
      const room = getRoom(code);
      if (Array.isArray(letters)) {
        const nextLetters = letters.slice(0, 8);
        if (nextLetters.join("|") !== room.letters.join("|")) {
          room.letters = nextLetters;
          room.roundId += 1;
        }
      }
      if (status) room.status = status;
      if (lastSuccess !== undefined) room.lastSuccess = lastSuccess;
      if (lastFeedback !== undefined) room.lastFeedback = lastFeedback;
      if (Array.isArray(podium)) room.podium = podium.slice(0, 3);
      if (clearSubmissions) room.submissions = [];
      if (Array.isArray(teams)) {
        room.teams = teams.map((team, index) => {
          const existing = room.teams.find((item) => item.id === team.id)
            || room.teams.find((item) => item.name.toLowerCase() === String(team.name || "").toLowerCase());
          return {
            id: team.id || existing?.id || `team-${index + 1}`,
            name: String(team.name || existing?.name || `Team ${index + 1}`),
            members: existing?.members ?? (Number(team.members) || 0),
            score: Number(team.score) || 0
          };
        });
      }
      touch(room);
      broadcastRoom(room);
      return json(res, 200, { room: serialize(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/live/start") {
      const { code } = await body(req);
      const room = getRoom(code);
      room.status = "live";
      touch(room);
      broadcastRoom(room);
      return json(res, 200, { room: serialize(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/live/join") {
      const { code, teamName, reconnect } = await body(req);
      const room = getRoom(code);
      const clean = String(teamName || "").trim();
      if (!clean) throw new Error("Team name is required");
      const existingPlayer = room.players.find((item) => item.teamName.toLowerCase() === clean.toLowerCase());
      if (existingPlayer && !reconnect) {
        return json(res, 409, {
          error: "A participant with this name is already connected.",
          reconnectable: true,
          teamName: existingPlayer.teamName
        });
      }
      let team = room.teams.find((item) => item.name.toLowerCase() === clean.toLowerCase());
      if (!team) {
        team = {
          id: `team-${room.teams.length + 1}`,
          name: clean,
          members: 0,
          score: 0
        };
        room.teams.push(team);
      }
      let player = existingPlayer || null;
      if (!player) {
        team.members += 1;
        player = { id: `player-${room.nextPlayerId++}`, teamId: team.id, teamName: team.name };
        room.players.push(player);
      } else {
        player.teamId = team.id;
        player.teamName = team.name;
      }
      touch(room);
      broadcastRoom(room);
      return json(res, 200, { player, room: serialize(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/live/submit") {
      const { code, playerId, teamId, teamName, word, roundId } = await body(req);
      const room = getRoom(code);
      if (room.status !== "live") {
        throw new Error("Game is not accepting answers");
      }
      const submission = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        playerId,
        teamId,
        teamName,
        word: String(word || "").trim(),
        createdAt: Date.now()
      };
      if (Number(roundId) !== Number(room.roundId)) {
        room.lastFeedback = {
          id: submission.id,
          teamId: submission.teamId || "",
          teamName: submission.teamName || "Student",
          word: submission.word,
          tone: "bad",
          message: "Too late. The letters already changed."
        };
        room.submissions = [];
        touch(room);
        broadcastRoom(room);
        return json(res, 200, { ok: false, stale: true, room: serialize(room) });
      }
      const evaluation = evaluateSubmission(room, submission);

      if (!evaluation.ok) {
        room.lastFeedback = {
          id: submission.id,
          teamId: submission.teamId || "",
          teamName: submission.teamName || "Student",
          word: submission.word,
          tone: "bad",
          message: evaluation.message
        };
        room.submissions = [];
        touch(room);
        broadcastRoom(room);
        return json(res, 200, { ok: false, room: serialize(room) });
      }

      const team = room.teams.find((item) => submission.teamId && item.id === submission.teamId)
        || room.teams.find((item) => item.name.toLowerCase() === String(submission.teamName || "").toLowerCase());
      if (!team) {
        throw new Error("Team not found");
      }

      const scoreBreakdown = getWordScore(evaluation.word, evaluation.usage.stolenLetters);
      const consumedLetters = Object.entries(evaluation.usage.consumed)
        .flatMap(([letter, count]) => Array.from({ length: count }, () => letter));

      room.letters = consumeLetters(room.letters, evaluation.usage.consumed);
      while (room.letters.length < 8) {
        room.letters.push("ABCDEFGHIJKLMNOPQRSTUVWXYZ"[Math.floor(Math.random() * 26)]);
      }
      room.roundId += 1;
      team.score = Number(team.score || 0) + scoreBreakdown.total;

      room.lastSuccess = {
        id: submission.id,
        teamId: team.id,
        teamName: team.name,
        word: evaluation.rawWord,
        consumedLetters,
        points: scoreBreakdown.total
      };
      room.lastFeedback = {
        id: submission.id,
        teamId: team.id,
        teamName: team.name,
        word: evaluation.rawWord,
        consumedLetters,
        tone: "good",
        message: `+${scoreBreakdown.total} pts`,
        points: scoreBreakdown.total,
        lettersScore: scoreBreakdown.lettersScore,
        lengthBonus: scoreBreakdown.lengthBonus,
        stealBonus: scoreBreakdown.stealBonus
      };

      if (team.score >= winningScore) {
        room.status = "finished";
        room.podium = room.teams
          .slice()
          .sort((a, b) => (Number(b.score) - Number(a.score)) || String(a.name || "").localeCompare(String(b.name || "")))
          .slice(0, 3)
          .map((entry) => ({
            id: entry.id,
            name: entry.name,
            score: Number(entry.score) || 0
          }));
      }

      room.submissions = [];
      touch(room);
      broadcastRoom(room);
      return json(res, 200, { ok: true, room: serialize(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/live/remove-team") {
      const { code, teamId } = await body(req);
      const room = getRoom(code);
      const before = room.teams.length;
      room.teams = room.teams.filter((team) => team.id !== teamId);
      if (room.teams.length === before) {
        throw new Error("Team not found");
      }
      room.players = room.players.filter((player) => player.teamId !== teamId);
      room.submissions = room.submissions.filter((submission) => submission.teamId !== teamId);
      touch(room);
      broadcastRoom(room);
      return json(res, 200, { room: serialize(room) });
    }

    res.writeHead(404);
    res.end("Not found");
  } catch (error) {
    json(res, 400, { error: error.message || "Request failed" });
  }
});

server.on("upgrade", (req, socket) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== "/ws/live") {
      socket.destroy();
      return;
    }
    const code = String(url.searchParams.get("code") || "").toUpperCase();
    if (!code || !rooms.has(code)) {
      socket.destroy();
      return;
    }
    const key = String(req.headers["sec-websocket-key"] || "");
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n"
      + "Upgrade: websocket\r\n"
      + "Connection: Upgrade\r\n"
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    socket._roomCode = code;
    getRoomSocketSet(code).add(socket);
    socket.on("close", () => detachSocket(socket));
    socket.on("end", () => detachSocket(socket));
    socket.on("error", () => detachSocket(socket));
    socket.on("data", (chunk) => {
      if (chunk && chunk.length && (chunk[0] & 0x0f) === 0x8) {
        detachSocket(socket);
        socket.end();
      }
    });
    sendWebSocketJson(socket, { type: "room", room: serialize(getRoom(code)) });
  } catch (_) {
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  const host = getLocalIp();
  console.log(`Teacher view: http://localhost:${PORT}`);
  console.log(`Phone join:   http://${host}:${PORT}`);
});
