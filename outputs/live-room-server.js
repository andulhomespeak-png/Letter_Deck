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
const HOME_HTML = path.join(ROOT, "index.html");
const BUZZER_HTML = path.join(ROOT, "buzzer.html");
const BUZZER_STUDENT_HTML = path.join(ROOT, "buzzer-student.html");
const WORDS_JS = path.join(ROOT, "english-words.js");
const ROOM_TTL_MS = 60 * 60 * 1000;

const rooms = new Map();
const roomSockets = new Map();
const buzzerRooms = new Map();
const buzzerSockets = new Map();

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
const winningScore = 750;
const stealBonusPerLetter = 2;
const definitionCache = new Map();

function getDefinitionCandidates(rawWord) {
  const key = String(rawWord || "").trim().toLowerCase();
  return Array.from(new Set([
    key,
    key.endsWith("ing") && key.length > 5 ? key.slice(0, -3) : "",
    key.endsWith("ing") && key.length > 5 ? `${key.slice(0, -3)}e` : "",
    key.endsWith("ied") && key.length > 4 ? `${key.slice(0, -3)}y` : "",
    key.endsWith("ed") && key.length > 4 ? key.slice(0, -2) : "",
    key.endsWith("ed") && key.length > 4 ? `${key.slice(0, -2)}e` : "",
    key.endsWith("ies") && key.length > 4 ? `${key.slice(0, -3)}y` : "",
    key.endsWith("es") && key.length > 4 ? key.slice(0, -2) : "",
    key.endsWith("s") && key.length > 3 ? key.slice(0, -1) : "",
    key.endsWith("ly") && key.length > 4 ? key.slice(0, -2) : ""
  ].filter(Boolean)));
}

function cleanDefinition(value) {
  return String(value || "").replace(/^[a-z]+\t/i, "").trim();
}

function isDefinitionHeading(value) {
  return /^meanings? relating to\b/i.test(cleanDefinition(value));
}

function parseDictionaryApiDev(data) {
  const definitions = data?.[0]?.meanings?.flatMap((meaning) => meaning.definitions || [])
    ?.map((entry) => cleanDefinition(entry.definition))
    ?.filter(Boolean) || [];
  if (!definitions.length || isDefinitionHeading(definitions[0])) {
    return "";
  }
  return definitions[0];
}

function parseEnglishDictionaryApi(data) {
  const definitions = data?.partsOfSpeech?.flatMap((part) => part?.senses || [])
    ?.map((sense) => cleanDefinition(sense?.definition))
    ?.filter(Boolean) || [];
  return definitions.find((definition) => !isDefinitionHeading(definition)) || "";
}

function parseDatamuse(data) {
  const definitions = data?.[0]?.defs || [];
  const definition = definitions.find((entry) => {
    const text = cleanDefinition(entry);
    return text && !isDefinitionHeading(text);
  }) || "";
  return cleanDefinition(definition);
}

async function fetchJsonWithTimeout(url, timeoutMs = 3500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Letter-Clash/1.0" }
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function lookupDefinition(rawWord) {
  const key = String(rawWord || "").trim().toLowerCase();
  if (!key) {
    return "";
  }
  if (definitionCache.has(key)) {
    return definitionCache.get(key);
  }

  for (const candidate of getDefinitionCandidates(key)) {
    const sources = [
      {
        url: `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(candidate)}`,
        parse: parseDictionaryApiDev
      },
      {
        url: `https://englishdictionaryapi.com/api/v1/words/${encodeURIComponent(candidate)}`,
        parse: parseEnglishDictionaryApi
      },
      {
        url: `https://api.datamuse.com/words?sp=${encodeURIComponent(candidate)}&md=d&max=1`,
        parse: parseDatamuse
      }
    ];

    const [preferredSource, ...fallbackSources] = sources;
    try {
      const data = await fetchJsonWithTimeout(preferredSource.url, 1800);
      const preferredDefinition = data ? preferredSource.parse(data) : "";
      if (preferredDefinition) {
        definitionCache.set(key, preferredDefinition);
        definitionCache.set(candidate, preferredDefinition);
        return preferredDefinition;
      }
    } catch (_) {
    }

    try {
      const definition = await Promise.any(fallbackSources.map(async (source) => {
        const data = await fetchJsonWithTimeout(source.url, 2500);
        const parsed = data ? source.parse(data) : "";
        if (!parsed) {
          throw new Error("Definition unavailable");
        }
        return parsed;
      }));
      definitionCache.set(key, definition);
      definitionCache.set(candidate, definition);
      return definition;
    } catch (_) {
    }
  }

  return "";
}

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
  if (ext === ".html") return "text/html; charset=utf-8";
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
  } while (rooms.has(code) || buzzerRooms.has(code));
  return code;
}

function createBuzzerRoom() {
  const room = {
    code: makeCode(),
    status: "waiting",
    roundId: 0,
    players: [],
    winner: null,
    buzzes: [],
    lockedOutPlayers: [],
    nextPlayerId: 1,
    roundStartedAt: 0,
    updatedAt: Date.now()
  };
  buzzerRooms.set(room.code, room);
  return room;
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
    acceptedWords: [],
    podium: [],
    nextPlayerId: 1,
    updatedAt: Date.now()
  };
  rooms.set(room.code, room);
  return room;
}

function cleanupRooms() {
  const now = Date.now();
  rooms.forEach((room, code) => {
    const hasSockets = !!roomSockets.get(code)?.size;
    if (hasSockets) {
      return;
    }
    if (now - Number(room.updatedAt || 0) < ROOM_TTL_MS) {
      return;
    }
    rooms.delete(code);
    roomSockets.delete(code);
  });
  buzzerRooms.forEach((room, code) => {
    const hasSockets = !!buzzerSockets.get(code)?.size;
    if (hasSockets) {
      return;
    }
    if (now - Number(room.updatedAt || 0) < ROOM_TTL_MS) {
      return;
    }
    buzzerRooms.delete(code);
    buzzerSockets.delete(code);
  });
}

function getRoom(code) {
  const room = rooms.get(String(code || "").toUpperCase());
  if (!room) throw new Error("Room not found");
  return room;
}

function getBuzzerRoom(code) {
  const room = buzzerRooms.get(String(code || "").toUpperCase());
  if (!room) throw new Error("Buzzer room not found");
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

function getBuzzerSocketSet(code) {
  const key = String(code || "").toUpperCase();
  if (!buzzerSockets.has(key)) {
    buzzerSockets.set(key, new Set());
  }
  return buzzerSockets.get(key);
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

function detachBuzzerSocket(socket) {
  const code = socket._buzzerCode;
  if (!code || !buzzerSockets.has(code)) {
    return;
  }
  const sockets = buzzerSockets.get(code);
  sockets.delete(socket);
  if (!sockets.size) {
    buzzerSockets.delete(code);
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

function broadcastBuzzerRoom(room) {
  const sockets = buzzerSockets.get(room.code);
  if (!sockets || !sockets.size) {
    return;
  }
  const payload = { type: "buzzer-room", room: serializeBuzzerRoom(room) };
  sockets.forEach((socket) => {
    try {
      sendWebSocketJson(socket, payload);
    } catch (_) {
      detachBuzzerSocket(socket);
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
    acceptedWords: (room.acceptedWords || []).slice(0, 300),
    podium: room.podium,
    updatedAt: room.updatedAt
  };
}

function serializeBuzzerRoom(room) {
  return {
    code: room.code,
    status: room.status,
    roundId: room.roundId,
    players: room.players,
    winner: room.winner,
    buzzes: room.buzzes.slice(0, 12),
    lockedOutPlayers: room.lockedOutPlayers || [],
    roundStartedAt: room.roundStartedAt,
    updatedAt: room.updatedAt
  };
}

async function enrichAcceptedWord(roomCode, feedbackId, word) {
  const definition = await lookupDefinition(word);
  const room = rooms.get(roomCode);
  if (!room) {
    return;
  }
  const entry = (room.acceptedWords || []).find((item) => item.id === feedbackId);
  if (!entry) {
    return;
  }
  entry.definition = definition;
  entry.definitionState = definition ? "ready" : "missing";
  if (room.lastFeedback?.id === feedbackId) {
    room.lastFeedback.definition = definition;
    room.lastFeedback.definitionState = entry.definitionState;
  }
  touch(room);
  broadcastRoom(room);
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
    if (req.method === "GET" && url.pathname === "/") return html(res, HOME_HTML);
    if (req.method === "GET" && url.pathname === "/letter-clash") return html(res, TEACHER_HTML);
    if (req.method === "GET" && url.pathname === "/buzzer") return html(res, BUZZER_HTML);
    if (req.method === "GET" && url.pathname === "/buzzer-student.html") return html(res, BUZZER_STUDENT_HTML);
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

    if (req.method === "GET" && url.pathname === "/api/definition") {
      const word = String(url.searchParams.get("word") || "").trim();
      return json(res, 200, {
        word,
        definition: await lookupDefinition(word)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/live/create-room") {
      return json(res, 200, { room: serialize(createRoom()) });
    }

    if (req.method === "GET" && url.pathname === "/api/live/room") {
      return json(res, 200, { room: serialize(getRoom(url.searchParams.get("code"))) });
    }

    if (req.method === "POST" && url.pathname === "/api/live/sync") {
      const { code, letters, status, lastSuccess, lastFeedback, teams, podium, clearSubmissions, clearAcceptedWords } = await body(req);
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
      if (clearAcceptedWords) room.acceptedWords = [];
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
        stealBonus: scoreBreakdown.stealBonus,
        definition: "",
        definitionState: "pending"
      };
      room.acceptedWords = room.acceptedWords || [];
      room.acceptedWords.unshift({
        id: submission.id,
        teamId: team.id,
        teamName: team.name,
        word: evaluation.rawWord,
        points: scoreBreakdown.total,
        definition: "",
        definitionState: "pending",
        acceptedAt: Date.now()
      });
      room.acceptedWords = room.acceptedWords.slice(0, 300);

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
      enrichAcceptedWord(room.code, submission.id, evaluation.rawWord).catch(() => {});
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

    if (req.method === "POST" && url.pathname === "/api/buzzer/create-room") {
      return json(res, 200, { room: serializeBuzzerRoom(createBuzzerRoom()) });
    }

    if (req.method === "GET" && url.pathname === "/api/buzzer/room") {
      return json(res, 200, { room: serializeBuzzerRoom(getBuzzerRoom(url.searchParams.get("code"))) });
    }

    if (req.method === "POST" && url.pathname === "/api/buzzer/join") {
      const { code, name } = await body(req);
      const room = getBuzzerRoom(code);
      const clean = String(name || "").trim();
      if (!clean) throw new Error("Name is required");
      let player = room.players.find((item) => item.name.toLowerCase() === clean.toLowerCase());
      if (!player) {
        player = {
          id: `buzzer-player-${room.nextPlayerId++}`,
          name: clean,
          score: 0,
          joinedAt: Date.now()
        };
        room.players.push(player);
      } else if (!Number.isFinite(Number(player.score))) {
        player.score = 0;
      }
      touch(room);
      broadcastBuzzerRoom(room);
      return json(res, 200, { player, room: serializeBuzzerRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/buzzer/start") {
      const { code } = await body(req);
      const room = getBuzzerRoom(code);
      if (!room.players.length) throw new Error("Add participants before going live");
      room.status = "live";
      room.roundId += 1;
      room.winner = null;
      room.buzzes = [];
      room.lockedOutPlayers = [];
      room.roundStartedAt = Date.now();
      touch(room);
      broadcastBuzzerRoom(room);
      return json(res, 200, { room: serializeBuzzerRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/buzzer/reset-round") {
      const { code } = await body(req);
      const room = getBuzzerRoom(code);
      room.roundId += 1;
      room.winner = null;
      room.buzzes = [];
      room.lockedOutPlayers = [];
      room.roundStartedAt = Date.now();
      room.status = room.status === "waiting" ? "waiting" : "live";
      touch(room);
      broadcastBuzzerRoom(room);
      return json(res, 200, { room: serializeBuzzerRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/buzzer/buzz") {
      const { code, playerId, playerName, roundId } = await body(req);
      const room = getBuzzerRoom(code);
      if (room.status !== "live") throw new Error("Buzzer is not live");
      if (Number(roundId) !== Number(room.roundId)) {
        return json(res, 200, { accepted: false, stale: true, room: serializeBuzzerRoom(room) });
      }
      const player = room.players.find((item) => item.id === playerId)
        || room.players.find((item) => item.name.toLowerCase() === String(playerName || "").toLowerCase());
      if (!player) throw new Error("Participant not found");
      const lockedOutPlayers = Array.isArray(room.lockedOutPlayers) ? room.lockedOutPlayers : [];
      if (lockedOutPlayers.includes(player.id)) {
        return json(res, 200, { accepted: false, lockedOut: true, room: serializeBuzzerRoom(room) });
      }
      const now = Date.now();
      const buzz = {
        id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
        playerId: player.id,
        playerName: player.name,
        roundId: room.roundId,
        buzzedAt: now,
        deltaMs: Math.max(0, now - Number(room.roundStartedAt || now)),
        accepted: !room.winner
      };
      room.buzzes.unshift(buzz);
      room.buzzes = room.buzzes.slice(0, 12);
      if (!room.winner) {
        room.winner = buzz;
      }
      touch(room);
      broadcastBuzzerRoom(room);
      return json(res, 200, { accepted: buzz.accepted, room: serializeBuzzerRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/buzzer/score") {
      const { code, playerId, delta } = await body(req);
      const room = getBuzzerRoom(code);
      if (!room.winner || room.winner.playerId !== playerId) {
        throw new Error("Score can only be applied to the current turn holder");
      }
      const player = room.players.find((item) => item.id === playerId);
      if (!player) throw new Error("Participant not found");
      const scoreDelta = Math.max(-10000, Math.min(10000, Math.trunc(Number(delta) || 0)));
      player.score = Number(player.score || 0) + scoreDelta;
      if (scoreDelta < 0) {
        const lockedOutPlayers = Array.isArray(room.lockedOutPlayers) ? room.lockedOutPlayers : [];
        if (!lockedOutPlayers.includes(player.id)) {
          lockedOutPlayers.push(player.id);
        }
        room.lockedOutPlayers = lockedOutPlayers;
      } else {
        room.roundId += 1;
        room.lockedOutPlayers = [];
      }
      room.winner = null;
      room.buzzes = [];
      room.roundStartedAt = Date.now();
      room.status = "live";
      touch(room);
      broadcastBuzzerRoom(room);
      return json(res, 200, { room: serializeBuzzerRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/buzzer/remove-player") {
      const { code, playerId } = await body(req);
      const room = getBuzzerRoom(code);
      const before = room.players.length;
      room.players = room.players.filter((player) => player.id !== playerId);
      if (room.players.length === before) throw new Error("Participant not found");
      room.buzzes = room.buzzes.filter((buzz) => buzz.playerId !== playerId);
      room.lockedOutPlayers = (room.lockedOutPlayers || []).filter((id) => id !== playerId);
      if (room.winner?.playerId === playerId) {
        room.winner = null;
      }
      touch(room);
      broadcastBuzzerRoom(room);
      return json(res, 200, { room: serializeBuzzerRoom(room) });
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
    const isLiveSocket = url.pathname === "/ws/live";
    const isBuzzerSocket = url.pathname === "/ws/buzzer";
    if (!isLiveSocket && !isBuzzerSocket) {
      socket.destroy();
      return;
    }
    const code = String(url.searchParams.get("code") || "").toUpperCase();
    if (!code || (isLiveSocket && !rooms.has(code)) || (isBuzzerSocket && !buzzerRooms.has(code))) {
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

    if (isLiveSocket) {
      socket._roomCode = code;
      getRoomSocketSet(code).add(socket);
      socket.on("close", () => detachSocket(socket));
      socket.on("end", () => detachSocket(socket));
      socket.on("error", () => detachSocket(socket));
    } else {
      socket._buzzerCode = code;
      getBuzzerSocketSet(code).add(socket);
      socket.on("close", () => detachBuzzerSocket(socket));
      socket.on("end", () => detachBuzzerSocket(socket));
      socket.on("error", () => detachBuzzerSocket(socket));
    }
    socket.on("data", (chunk) => {
      if (chunk && chunk.length && (chunk[0] & 0x0f) === 0x8) {
        if (isLiveSocket) {
          detachSocket(socket);
        } else {
          detachBuzzerSocket(socket);
        }
        socket.end();
      }
    });
    if (isLiveSocket) {
      sendWebSocketJson(socket, { type: "room", room: serialize(getRoom(code)) });
    } else {
      sendWebSocketJson(socket, { type: "buzzer-room", room: serializeBuzzerRoom(getBuzzerRoom(code)) });
    }
  } catch (_) {
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  const host = getLocalIp();
  console.log(`Teacher view: http://localhost:${PORT}`);
  console.log(`Phone join:   http://${host}:${PORT}`);
});

setInterval(cleanupRooms, 5 * 60 * 1000).unref();
