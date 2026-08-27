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
const SERVER_INSTANCE_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const TEACHER_HTML = path.join(ROOT, "letter-card-game.html");
const STUDENT_HTML = path.join(ROOT, "student.html");
const HOME_HTML = path.join(ROOT, "index.html");
const BUZZER_HTML = path.join(ROOT, "buzzer.html");
const BUZZER_STUDENT_HTML = path.join(ROOT, "buzzer-student.html");
const TIMER_HTML = path.join(ROOT, "timer.html");
const NAME_WHEEL_HTML = path.join(ROOT, "name-wheel.html");
const NAME_WHEEL_STUDENT_HTML = path.join(ROOT, "name-wheel-student.html");
const QUICK_POLL_HTML = path.join(ROOT, "quick-poll.html");
const QUICK_POLL_STUDENT_HTML = path.join(ROOT, "quick-poll-student.html");
const BINGO_HTML = path.join(ROOT, "bingo.html");
const BINGO_STUDENT_HTML = path.join(ROOT, "bingo-student.html");
const STUDENT_HUB_HTML = path.join(ROOT, "student-hub.html");
const WORDS_JS = path.join(ROOT, "english-words.js");
const LEARNED_WORDS_JSON = path.join(ROOT, "learned-words.json");
const BUZZER_TRIVIA_JSON = path.join(ROOT, "buzzer-trivia.json");
const ROOM_TTL_MS = 60 * 60 * 1000;
const CLASSROOM_ROOM_TTL_MS = 12 * 60 * 60 * 1000;

const rooms = new Map();
const roomSockets = new Map();
const buzzerRooms = new Map();
const buzzerSockets = new Map();
const wheelRooms = new Map();
const pollRooms = new Map();
const bingoRooms = new Map();
const classroomRooms = new Map();
let buzzerTriviaBank = loadBuzzerTriviaBank();

function loadDictionary() {
  const source = fs.readFileSync(WORDS_JS, "utf8");
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "english-words.js" });
  const raw = String(sandbox.window.ENGLISH_WORDS_RAW || "");
  return new Set(raw.split("\n"));
}

function normalizeLearnedWord(value) {
  const word = String(value || "").trim().toLowerCase();
  return /^[a-z]{2,}$/.test(word) ? word : "";
}

function loadLearnedWords() {
  try {
    if (!fs.existsSync(LEARNED_WORDS_JSON)) {
      return new Set();
    }
    const values = JSON.parse(fs.readFileSync(LEARNED_WORDS_JSON, "utf8"));
    return new Set((Array.isArray(values) ? values : []).map(normalizeLearnedWord).filter(Boolean));
  } catch (_) {
    return new Set();
  }
}

function saveLearnedWords() {
  try {
    const values = Array.from(learnedWords).sort();
    fs.writeFileSync(LEARNED_WORDS_JSON, `${JSON.stringify(values, null, 2)}\n`, "utf8");
  } catch (_) {}
}

function normalizeBuzzerTriviaItem(item, index = 0) {
  const category = String(item?.category || "General").trim() || "General";
  const question = String(item?.question || "").trim();
  const type = String(item?.type || "open").trim().toLowerCase() === "multiple" ? "multiple" : "open";
  const options = (Array.isArray(item?.options) ? item.options : [])
    .map((option) => String(option || "").trim())
    .filter(Boolean)
    .slice(0, 4);
  const correctOptionIndex = Math.max(0, Math.min(3, Math.trunc(Number(item?.correctOptionIndex) || 0)));
  const answer = type === "multiple" ? (options[correctOptionIndex] || "") : String(item?.answer || "").trim();
  if (!question || !answer) return null;
  if (type === "multiple" && options.length !== 4) return null;
  return {
    id: String(item?.id || `trivia-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`),
    category,
    type,
    question,
    answer,
    options: type === "multiple" ? options : [],
    correctOptionIndex: type === "multiple" ? correctOptionIndex : 0
  };
}

function normalizeBuzzerTriviaBank(values) {
  return (Array.isArray(values) ? values : [])
    .map(normalizeBuzzerTriviaItem)
    .filter(Boolean)
    .slice(0, 500);
}

function loadBuzzerTriviaBank() {
  try {
    if (!fs.existsSync(BUZZER_TRIVIA_JSON)) {
      return [];
    }
    return normalizeBuzzerTriviaBank(JSON.parse(fs.readFileSync(BUZZER_TRIVIA_JSON, "utf8")));
  } catch (_) {
    return [];
  }
}

function saveBuzzerTriviaBank() {
  try {
    fs.writeFileSync(BUZZER_TRIVIA_JSON, `${JSON.stringify(buzzerTriviaBank, null, 2)}\n`, "utf8");
  } catch (_) {}
}

function getBuzzerTriviaQuestion(room) {
  if (!room?.triviaMode || !buzzerTriviaBank.length) return null;
  const index = Math.max(0, Math.min(buzzerTriviaBank.length - 1, Number(room.triviaIndex || 0)));
  const item = buzzerTriviaBank[index] || null;
  if (!item) return null;
  return {
    id: item.id,
    category: item.category,
    type: item.type || "open",
    question: item.question,
    options: item.type === "multiple" ? item.options || [] : [],
    correctOptionIndex: Number(item.correctOptionIndex || 0),
    answer: room.triviaAnswerVisible ? item.answer : "",
    answerVisible: !!room.triviaAnswerVisible,
    attemptedOptionIndexes: Array.isArray(room.triviaAttemptedOptionIndexes) ? room.triviaAttemptedOptionIndexes : [],
    index,
    total: buzzerTriviaBank.length
  };
}

function getBuzzerTriviaUsedIndexes(room) {
  if (!buzzerTriviaBank.length) return [];
  const max = buzzerTriviaBank.length;
  return Array.from(new Set((Array.isArray(room?.triviaUsedIndexes) ? room.triviaUsedIndexes : [])
    .map((index) => Math.trunc(Number(index)))
    .filter((index) => Number.isFinite(index) && index >= 0 && index < max)));
}

function markCurrentBuzzerTriviaUsed(room) {
  if (!room?.triviaMode || !buzzerTriviaBank.length) return;
  const index = Math.max(0, Math.min(buzzerTriviaBank.length - 1, Math.trunc(Number(room.triviaIndex || 0))));
  const used = getBuzzerTriviaUsedIndexes(room);
  if (!used.includes(index)) used.push(index);
  room.triviaUsedIndexes = used;
}

function getBuzzerTriviaProgress(room) {
  const used = getBuzzerTriviaUsedIndexes(room);
  if (!room?.triviaMode || !buzzerTriviaBank.length) {
    return { used: used.length, total: buzzerTriviaBank.length };
  }
  const current = Math.max(0, Math.min(buzzerTriviaBank.length - 1, Math.trunc(Number(room.triviaIndex || 0))));
  const currentIsVisible = room.status === "live" || !!room.winner || !!room.triviaAnswerVisible || (room.triviaAttemptedOptionIndexes || []).length > 0;
  const visibleUsed = currentIsVisible && !used.includes(current) ? used.length + 1 : used.length;
  return { used: Math.min(visibleUsed, buzzerTriviaBank.length), total: buzzerTriviaBank.length };
}

function advanceBuzzerTrivia(room) {
  if (!room?.triviaMode || !buzzerTriviaBank.length) return;
  let used = getBuzzerTriviaUsedIndexes(room);
  if (used.length >= buzzerTriviaBank.length) {
    used = [];
  }
  const available = buzzerTriviaBank
    .map((_, index) => index)
    .filter((index) => !used.includes(index));
  if (available.length) {
    if (room.triviaShuffle !== false) {
      room.triviaIndex = available[Math.floor(Math.random() * available.length)];
    } else {
      const current = Math.max(0, Math.min(buzzerTriviaBank.length - 1, Math.trunc(Number(room.triviaIndex || 0))));
      room.triviaIndex = available.find((index) => index > current) ?? available[0];
    }
  } else {
    room.triviaIndex = 0;
  }
  room.triviaUsedIndexes = used;
  room.triviaAnswerVisible = false;
  room.triviaAttemptedOptionIndexes = [];
  room.lockedOutPlayers = [];
  room.winner = null;
  room.buzzes = [];
}

function rememberDictionaryWord(rawWord) {
  const word = normalizeLearnedWord(rawWord);
  if (!word || dictionary.has(word)) {
    return;
  }
  dictionary.add(word);
  learnedWords.add(word);
  saveLearnedWords();
}

const dictionary = loadDictionary();
const learnedWords = loadLearnedWords();
learnedWords.forEach((word) => dictionary.add(word));
const letterPoints = {
  A: 1, E: 1, I: 1, O: 1, N: 1, R: 1, T: 1, L: 1, S: 1, U: 1,
  D: 2, G: 2,
  B: 3, C: 3, M: 3, P: 3,
  F: 4, H: 4, V: 4, W: 4, Y: 4,
  K: 5,
  J: 8, X: 8,
  Q: 10, Z: 10
};
const winningScore = 500;
const stealBonusPerLetter = 2;
const definitionCache = new Map();

function getDefinitionCandidates(rawWord, options = {}) {
  const key = String(rawWord || "").trim().toLowerCase();
  if (options.exactOnly) {
    return key ? [key] : [];
  }
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

function parseDictionaryApiDev(data, expectedWord = "") {
  const returnedWord = String(data?.[0]?.word || "").trim().toLowerCase();
  const expected = String(expectedWord || "").trim().toLowerCase();
  if (expected && returnedWord && returnedWord !== expected) {
    return "";
  }
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

function parseDatamuse(data, expectedWord = "") {
  const returnedWord = String(data?.[0]?.word || "").trim().toLowerCase();
  const expected = String(expectedWord || "").trim().toLowerCase();
  if (!returnedWord || (expected && returnedWord !== expected)) {
    return "";
  }
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

async function lookupDefinition(rawWord, options = {}) {
  const key = String(rawWord || "").trim().toLowerCase();
  if (!key) {
    return "";
  }
  if (definitionCache.has(key)) {
    return definitionCache.get(key);
  }

  for (const candidate of getDefinitionCandidates(key, { exactOnly: !!options.exactOnly })) {
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
      const preferredDefinition = data ? preferredSource.parse(data, candidate) : "";
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
        const parsed = data ? source.parse(data, candidate) : "";
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

async function validateDictionaryWord(rawWord) {
  const word = normalizeLearnedWord(rawWord);
  if (!word) {
    return { ok: false, definition: "", learned: false };
  }
  if (dictionary.has(word)) {
    return { ok: true, definition: definitionCache.get(word) || "", learned: false };
  }
  const definition = await lookupDefinition(word, { exactOnly: true });
  if (!definition) {
    return { ok: false, definition: "", learned: false };
  }
  rememberDictionaryWord(word);
  definitionCache.set(word, definition);
  return { ok: true, definition, learned: true };
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
  } while (rooms.has(code) || buzzerRooms.has(code) || wheelRooms.has(code) || pollRooms.has(code) || bingoRooms.has(code) || classroomRooms.has(code));
  return code;
}

function createClassroomRoom() {
  const room = {
    code: makeCode(),
    activeTool: "standby",
    activeToolCode: "",
    players: [],
    nextPlayerId: 1,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  classroomRooms.set(room.code, room);
  return room;
}

function createPollRoom() {
  const room = {
    code: makeCode(),
    status: "waiting",
    blockSelfVote: true,
    options: [],
    candidatePlayerIds: [],
    nominationMode: false,
    nomineePlayerIds: [],
    players: [],
    votes: [],
    nextPlayerId: 1,
    pollId: 1,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  pollRooms.set(room.code, room);
  return room;
}

function createWheelRoom() {
  const room = {
    code: makeCode(),
    names: [],
    players: [],
    activeTurnName: "",
    spinCommandId: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  wheelRooms.set(room.code, room);
  return room;
}

function numberToBingoWords(number) {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy"];
  if (number < 20) return ones[number];
  const ten = Math.floor(number / 10);
  const one = number % 10;
  return one ? `${tens[ten]} ${ones[one]}` : tens[ten];
}

function getDefaultBingoWords() {
  return Array.from({ length: 75 }, (_, index) => numberToBingoWords(index + 1));
}

function createBingoRoom() {
  const room = {
    code: makeCode(),
    status: "setup",
    preset: "numbers",
    words: getDefaultBingoWords(),
    calledWords: [],
    players: [],
    cards: {},
    pendingClaim: null,
    winner: null,
    nextPlayerId: 1,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  bingoRooms.set(room.code, room);
  return room;
}

function createBuzzerRoom() {
  const room = {
    code: makeCode(),
    status: "waiting",
    roundId: 0,
    players: [],
    winner: null,
    podium: [],
    buzzes: [],
    lockedOutPlayers: [],
    buzzerHeld: true,
    triviaMode: false,
    triviaIndex: 0,
    triviaShuffle: true,
    triviaUsedIndexes: [],
    triviaAnswerVisible: false,
    triviaAttemptedOptionIndexes: [],
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
  wheelRooms.forEach((room, code) => {
    if (now - Number(room.updatedAt || 0) < ROOM_TTL_MS) {
      return;
    }
    wheelRooms.delete(code);
  });
  pollRooms.forEach((room, code) => {
    if (now - Number(room.updatedAt || 0) < ROOM_TTL_MS) {
      return;
    }
    pollRooms.delete(code);
  });
  bingoRooms.forEach((room, code) => {
    if (now - Number(room.updatedAt || 0) < ROOM_TTL_MS) {
      return;
    }
    bingoRooms.delete(code);
  });
  classroomRooms.forEach((room, code) => {
    if (now - Number(room.updatedAt || 0) < CLASSROOM_ROOM_TTL_MS) {
      return;
    }
    classroomRooms.delete(code);
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

function getWheelRoom(code) {
  const room = wheelRooms.get(String(code || "").toUpperCase());
  if (!room) throw new Error("Wheel room not found");
  return room;
}

function getPollRoom(code) {
  const room = pollRooms.get(String(code || "").toUpperCase());
  if (!room) throw new Error("Poll room not found");
  return room;
}

function getBingoRoom(code) {
  const room = bingoRooms.get(String(code || "").toUpperCase());
  if (!room) throw new Error("Bingo room not found");
  return room;
}

function getClassroomRoom(code) {
  const room = classroomRooms.get(String(code || "").toUpperCase());
  if (!room) throw new Error("Classroom room not found");
  return room;
}

function touch(room) {
  room.updatedAt = Date.now();
}

function sameName(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
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
    podium: Array.isArray(room.podium) ? room.podium : [],
    buzzes: room.buzzes.slice(0, 12),
    lockedOutPlayers: room.lockedOutPlayers || [],
    buzzerHeld: !!room.buzzerHeld,
    triviaMode: !!room.triviaMode,
    triviaShuffle: room.triviaShuffle !== false,
    triviaProgress: getBuzzerTriviaProgress(room),
    trivia: getBuzzerTriviaQuestion(room),
    roundStartedAt: room.roundStartedAt,
    updatedAt: room.updatedAt
  };
}

function serializeClassroomRoom(room) {
  return {
    code: room.code,
    activeTool: room.activeTool || "standby",
    activeToolCode: room.activeToolCode || "",
    players: (room.players || []).slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))),
    updatedAt: room.updatedAt
  };
}

function serializeWheelRoom(room) {
  room.names = normalizeWheelNames(room.names);
  if (room.activeTurnName) {
    const stillConnected = (room.players || []).some((player) => sameName(player.name, room.activeTurnName));
    if (!stillConnected) room.activeTurnName = "";
  }
  return {
    code: room.code,
    names: room.names,
    players: (room.players || []).slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""))),
    activeTurnName: room.activeTurnName || "",
    spinCommandId: Number(room.spinCommandId || 0),
    updatedAt: room.updatedAt
  };
}

function normalizeWheelNames(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 500);
}

function normalizePollOptions(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 100);
}

function normalizeBingoWords(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 300);
}

function shuffleValues(values) {
  const items = values.slice();
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
  return items;
}

const bingoNumberOnes = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19
};

const bingoNumberTens = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70
};

function getClassicBingoNumberValue(word) {
  const raw = String(word || "").trim();
  const numeric = Number(raw);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 75) return numeric;
  const clean = raw.toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ").trim();
  if (bingoNumberOnes[clean]) return bingoNumberOnes[clean];
  if (bingoNumberTens[clean]) return bingoNumberTens[clean];
  const [ten, one] = clean.split(" ");
  const value = (bingoNumberTens[ten] || 0) + (bingoNumberOnes[one] || 0);
  return value >= 1 && value <= 75 ? value : 0;
}

function getBingoEntry(rawWord) {
  const raw = String(rawWord || "").trim();
  const arrowMatch = raw.match(/^(.+?)\s*(?:->|→)\s*(.+)$/);
  if (arrowMatch) {
    return {
      raw,
      call: arrowMatch[1].trim(),
      display: arrowMatch[2].trim()
    };
  }
  const value = getClassicBingoNumberValue(raw);
  return {
    raw,
    call: raw,
    display: value ? String(value) : raw
  };
}

function makeBingoCard(words) {
  const columnTargets = [5, 5, 4, 5, 5];
  const entries = words.map(getBingoEntry).filter((entry) => entry.raw && entry.call && entry.display);
  const numericValues = entries.map((entry) => getClassicBingoNumberValue(entry.call));
  const isClassicNumbers = entries.length >= 75
    && numericValues.every((value) => Number.isInteger(value) && value >= 1 && value <= 75)
    && new Set(numericValues).size >= 75;
  const columnWords = isClassicNumbers
    ? columnTargets.map((target, column) => {
      const min = column * 15 + 1;
      const max = min + 14;
      return shuffleValues(entries.filter((entry) => {
        const value = getClassicBingoNumberValue(entry.call);
        return value >= min && value <= max;
      }))
        .slice(0, target)
        .sort((a, b) => getClassicBingoNumberValue(a.call) - getClassicBingoNumberValue(b.call));
    })
    : columnTargets.map((target, column) => {
      const sortedWords = entries.slice().sort((a, b) => a.display.localeCompare(b.display));
      const start = Math.floor((sortedWords.length * column) / 5);
      const end = Math.floor((sortedWords.length * (column + 1)) / 5);
      return shuffleValues(sortedWords.slice(start, end))
        .slice(0, target)
        .sort((a, b) => a.display.localeCompare(b.display));
    });
  const cells = Array.from({ length: 25 }, () => ({ word: "", marked: false, free: false }));
  for (let column = 0; column < 5; column += 1) {
    let wordIndex = 0;
    for (let row = 0; row < 5; row += 1) {
      const cellIndex = row * 5 + column;
      if (cellIndex === 12) {
        cells[cellIndex] = { word: "FREE", marked: true, free: true };
      } else {
        const entry = columnWords[column][wordIndex] || { raw: "", display: "" };
        cells[cellIndex] = {
          word: entry.raw,
          display: entry.display,
          marked: false,
          free: false
        };
        wordIndex += 1;
      }
    }
  }
  return { size: 5, cells };
}

function getBingoCardSignature(card) {
  return (card?.cells || [])
    .map((cell) => String(cell?.word || "").trim().toLowerCase())
    .join("|");
}

function getExistingBingoCardSignatures(room, excludePlayerId = "") {
  const excludeId = String(excludePlayerId || "");
  return new Set(Object.entries(room.cards || {})
    .filter(([playerId]) => String(playerId) !== excludeId)
    .map(([, card]) => getBingoCardSignature(card))
    .filter(Boolean));
}

function makeUniqueBingoCard(room, playerId) {
  const existing = getExistingBingoCardSignatures(room, playerId);
  let fallbackCard = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const card = makeBingoCard(room.words || []);
    fallbackCard = fallbackCard || card;
    const signature = getBingoCardSignature(card);
    if (!existing.has(signature)) {
      return card;
    }
  }
  return fallbackCard || makeBingoCard(room.words || []);
}

function getBingoLine(card, calledWords = []) {
  const cells = card?.cells || [];
  if (cells.length !== 25) {
    return [];
  }
  const called = new Set((calledWords || []).map((word) => String(word || "").trim().toLowerCase()));
  const marked = (index) => {
    const cell = cells[index] || {};
    if (cell.free) return true;
    return !!cell.marked && called.has(String(cell.word || "").trim().toLowerCase());
  };
  for (let row = 0; row < 5; row += 1) {
    const line = [0, 1, 2, 3, 4].map((offset) => row * 5 + offset);
    if (line.every(marked)) return line;
  }
  for (let column = 0; column < 5; column += 1) {
    const line = [0, 1, 2, 3, 4].map((offset) => offset * 5 + column);
    if (line.every(marked)) return line;
  }
  const diagonalA = [0, 6, 12, 18, 24];
  if (diagonalA.every(marked)) return diagonalA;
  const diagonalB = [4, 8, 12, 16, 20];
  if (diagonalB.every(marked)) return diagonalB;
  return [];
}

function getBingoClaimResult(card, calledWords = []) {
  const cells = card?.cells || [];
  const called = new Set((calledWords || []).map((word) => String(word || "").trim().toLowerCase()));
  const marked = (index) => {
    const cell = cells[index] || {};
    if (cell.free) return true;
    return !!cell.marked && called.has(String(cell.word || "").trim().toLowerCase());
  };
  if (cells.length === 25 && cells.every((cell, index) => marked(index))) {
    return { isValid: true, line: cells.map((_, index) => index), pattern: "full-card" };
  }
  const line = getBingoLine(card, calledWords);
  return { isValid: !!line.length, line, pattern: line.length ? "line" : "" };
}

function hasBingo(card, calledWords = []) {
  return getBingoClaimResult(card, calledWords).isValid;
}

function ensureBingoCard(room, playerId) {
  const id = String(playerId || "");
  if (!room.cards) room.cards = {};
  if (!room.cards[id]) {
    if ((room.words || []).length < 24) {
      return null;
    }
    room.cards[id] = makeUniqueBingoCard(room, id);
  }
  return room.cards[id];
}

function getPollCandidates(room) {
  const candidateIds = new Set((room.candidatePlayerIds || []).map((id) => Number(id)));
  const playerCandidates = (room.players || []).filter((player) => candidateIds.has(Number(player.id))).map((player) => ({
      id: `player-${player.id}`,
      playerId: player.id,
      label: player.name
  }));
  const optionCandidates = (room.options || []).map((label, index) => ({
    id: `option-${index}`,
    label
  }));
  return [...optionCandidates, ...playerCandidates];
}

function serializeBingoRoom(room, playerId = "") {
  const sortedPlayers = (room.players || []).slice().sort((a, b) => {
    const bingoDelta = Number(b.bingos || 0) - Number(a.bingos || 0);
    if (bingoDelta) return bingoDelta;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
  const id = String(playerId || "");
  if (id) ensureBingoCard(room, id);
  return {
    code: room.code,
    status: room.status,
    preset: room.preset || "",
    words: room.words || [],
    calledWords: room.calledWords || [],
    players: sortedPlayers,
    pendingClaim: room.pendingClaim || null,
    winner: room.winner || null,
    card: id ? (room.cards?.[id] || null) : null,
    updatedAt: room.updatedAt
  };
}

function serializePollRoom(room) {
  const candidates = getPollCandidates(room);
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const validVotes = (room.votes || []).filter((vote) => candidateIds.has(vote.candidateId));
  const sortedPlayers = (room.players || []).slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  const results = candidates.map((candidate) => ({
    ...candidate,
    votes: validVotes.filter((vote) => vote.candidateId === candidate.id).length
  })).sort((a, b) => b.votes - a.votes || a.label.localeCompare(b.label));
  return {
    code: room.code,
    status: room.status,
    blockSelfVote: !!room.blockSelfVote,
    options: room.options || [],
    candidatePlayerIds: room.candidatePlayerIds || [],
    nominationMode: !!room.nominationMode,
    nomineePlayerIds: room.nomineePlayerIds || [],
    players: sortedPlayers,
    candidates,
    results,
    votes: validVotes,
    pollId: room.pollId,
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

async function evaluateSubmission(room, submission) {
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
  const dictionaryResult = await validateDictionaryWord(rawWord);
  if (!dictionaryResult.ok) {
    return { ok: false, message: `"${rawWord}" is not in the dictionary.` };
  }
  const usage = getWordTableUsage(room.letters, word);
  if (!usage) {
    return {
      ok: false,
      message: `"${rawWord}" is real, but it must start and end with ${room.letters.join(" / ")}.`
    };
  }
  return { ok: true, rawWord, word, usage, definition: dictionaryResult.definition || "", learned: !!dictionaryResult.learned };
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
    if (req.method === "GET" && url.pathname === "/timer") return html(res, TIMER_HTML);
    if (req.method === "GET" && url.pathname === "/name-wheel") return html(res, NAME_WHEEL_HTML);
    if (req.method === "GET" && url.pathname === "/quick-poll") return html(res, QUICK_POLL_HTML);
    if (req.method === "GET" && url.pathname === "/bingo") return html(res, BINGO_HTML);
    if (req.method === "GET" && url.pathname === "/student-hub.html") return html(res, STUDENT_HUB_HTML);
    if (req.method === "GET" && url.pathname === "/buzzer-student.html") return html(res, BUZZER_STUDENT_HTML);
    if (req.method === "GET" && url.pathname === "/name-wheel-student.html") return html(res, NAME_WHEEL_STUDENT_HTML);
    if (req.method === "GET" && url.pathname === "/quick-poll-student.html") return html(res, QUICK_POLL_STUDENT_HTML);
    if (req.method === "GET" && url.pathname === "/bingo-student.html") return html(res, BINGO_STUDENT_HTML);
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
        instanceId: SERVER_INSTANCE_ID,
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

    if (req.method === "POST" && url.pathname === "/api/classroom/create-room") {
      return json(res, 200, { room: serializeClassroomRoom(createClassroomRoom()) });
    }

    if (req.method === "POST" && url.pathname === "/api/classroom/delete-room") {
      const { code } = await body(req);
      classroomRooms.delete(String(code || "").toUpperCase());
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/classroom/room") {
      const room = getClassroomRoom(url.searchParams.get("code"));
      touch(room);
      return json(res, 200, { room: serializeClassroomRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/classroom/set-tool") {
      const { code, activeTool, activeToolCode } = await body(req);
      const room = getClassroomRoom(code);
      const cleanTool = String(activeTool || "standby").trim().toLowerCase();
      const allowedTools = new Set(["standby", "buzzer", "letter-clash", "wheel", "quick-poll", "bingo", "timer"]);
      room.activeTool = allowedTools.has(cleanTool) ? cleanTool : "standby";
      room.activeToolCode = room.activeTool === "standby" ? "" : String(activeToolCode || "").trim().toUpperCase();
      touch(room);
      return json(res, 200, { room: serializeClassroomRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/classroom/join") {
      const { code, name, deviceId } = await body(req);
      const room = getClassroomRoom(code);
      const cleanName = String(name || "").trim();
      const cleanDeviceId = String(deviceId || "").trim();
      if (!cleanName) throw new Error("Name is required");
      if (!cleanDeviceId) throw new Error("Device ID is required");
      let player = room.players.find((item) => item.deviceId === cleanDeviceId);
      const duplicate = room.players.find((item) => item !== player && String(item.name || "").trim().toLowerCase() === cleanName.toLowerCase());
      if (duplicate) throw new Error("That name is already connected");
      if (!player) {
        player = { id: room.nextPlayerId || 1, name: cleanName, deviceId: cleanDeviceId, joinedAt: Date.now(), updatedAt: Date.now() };
        room.nextPlayerId = Number(room.nextPlayerId || 1) + 1;
        room.players.push(player);
      } else {
        player.name = cleanName;
        player.updatedAt = Date.now();
      }
      touch(room);
      return json(res, 200, { room: serializeClassroomRoom(room), player });
    }

    if (req.method === "POST" && url.pathname === "/api/classroom/remove-player") {
      const { code, playerId } = await body(req);
      const room = getClassroomRoom(code);
      const id = Number(playerId || 0);
      const before = room.players.length;
      room.players = room.players.filter((player) => Number(player.id) !== id);
      if (room.players.length === before) throw new Error("Participant not found");
      touch(room);
      return json(res, 200, { room: serializeClassroomRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/live/create-room") {
      return json(res, 200, { room: serialize(createRoom()) });
    }

    if (req.method === "POST" && url.pathname === "/api/live/delete-room") {
      const { code } = await body(req);
      const cleanCode = String(code || "").toUpperCase();
      const sockets = roomSockets.get(cleanCode);
      if (sockets) {
        sockets.forEach((socket) => {
          try {
            sendWebSocketJson(socket, { type: "room-deleted", code: cleanCode });
            socket.destroy();
          } catch (_) {}
        });
      }
      rooms.delete(cleanCode);
      roomSockets.delete(cleanCode);
      return json(res, 200, { ok: true });
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
      const { code, teamName, reconnect, classroomPlayerId } = await body(req);
      const room = getRoom(code);
      const clean = String(teamName || "").trim();
      const requestedClassroomId = Number(classroomPlayerId || 0);
      if (!clean) throw new Error("Team name is required");
      const existingPlayer = room.players.find((item) => requestedClassroomId && Number(item.classroomPlayerId || 0) === requestedClassroomId)
        || room.players.find((item) => item.teamName.toLowerCase() === clean.toLowerCase());
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
        player = { id: `player-${room.nextPlayerId++}`, teamId: team.id, teamName: team.name, classroomPlayerId: requestedClassroomId || undefined };
        room.players.push(player);
      } else {
        player.teamId = team.id;
        player.teamName = team.name;
        if (requestedClassroomId) player.classroomPlayerId = requestedClassroomId;
      }
      touch(room);
      broadcastRoom(room);
      return json(res, 200, { player, room: serialize(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/live/import-classroom") {
      const { code, classroomCode } = await body(req);
      const room = getRoom(code);
      const classroom = getClassroomRoom(classroomCode);
      const previousTeams = Array.isArray(room.teams) ? room.teams : [];
      const previousPlayers = Array.isArray(room.players) ? room.players : [];
      const nextTeams = [];
      const nextPlayers = [];
      const usedTeamIds = new Set();
      const usedNames = new Set();
      (classroom.players || []).forEach((sourcePlayer) => {
        const clean = String(sourcePlayer.name || "").trim();
        if (!clean) return;
        const nameKey = clean.toLowerCase();
        if (usedNames.has(nameKey)) return;
        usedNames.add(nameKey);
        const existingPlayer = previousPlayers.find((item) => Number(item.classroomPlayerId || 0) === Number(sourcePlayer.id || 0))
          || previousPlayers.find((item) => sameName(item.teamName, clean));
        const existingTeam = previousTeams.find((item) => existingPlayer?.teamId && item.id === existingPlayer.teamId)
          || previousTeams.find((item) => sameName(item.name, clean));
        let teamId = existingTeam?.id || "";
        if (!teamId || usedTeamIds.has(teamId)) {
          let index = nextTeams.length + 1;
          teamId = `team-${index}`;
          while (usedTeamIds.has(teamId) || previousTeams.some((item) => item.id === teamId)) {
            index += 1;
            teamId = `team-${index}`;
          }
        }
        usedTeamIds.add(teamId);
        const team = {
          id: teamId,
          name: clean,
          members: 1,
          score: Number(existingTeam?.score || 0)
        };
        nextTeams.push(team);
        nextPlayers.push({
          id: existingPlayer?.id || `player-${room.nextPlayerId++}`,
          teamId: team.id,
          teamName: team.name,
          classroomPlayerId: sourcePlayer.id
        });
      });
      const previousSignature = previousPlayers
        .map((player) => `${Number(player.classroomPlayerId || 0)}:${String(player.teamName || "").trim()}`)
        .sort()
        .join("|");
      const nextSignature = nextPlayers
        .map((player) => `${Number(player.classroomPlayerId || 0)}:${String(player.teamName || "").trim()}`)
        .sort()
        .join("|");
      const removedTeamIds = new Set(previousTeams
        .filter((team) => !nextTeams.some((item) => item.id === team.id))
        .map((team) => team.id));
      const removedPlayerIds = new Set(previousPlayers
        .filter((player) => !nextPlayers.some((item) => item.id === player.id))
        .map((player) => player.id));
      room.teams = nextTeams;
      room.players = nextPlayers;
      room.submissions = (room.submissions || []).filter((submission) => !removedTeamIds.has(submission.teamId) && !removedPlayerIds.has(submission.playerId));
      room.podium = (room.podium || []).filter((item) => !removedTeamIds.has(item.id));
      if (removedTeamIds.has(room.lastSuccess?.teamId)) room.lastSuccess = null;
      if (removedTeamIds.has(room.lastFeedback?.teamId)) room.lastFeedback = null;
      const changed = previousSignature !== nextSignature;
      if (changed) {
        touch(room);
        broadcastRoom(room);
      }
      return json(res, 200, { room: serialize(room), changed });
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
      const evaluation = await evaluateSubmission(room, submission);

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
        definition: evaluation.definition || "",
        definitionState: evaluation.definition ? "ready" : "pending"
      };
      room.acceptedWords = room.acceptedWords || [];
      room.acceptedWords.unshift({
        id: submission.id,
        teamId: team.id,
        teamName: team.name,
        word: evaluation.rawWord,
        points: scoreBreakdown.total,
        definition: evaluation.definition || "",
        definitionState: evaluation.definition ? "ready" : "pending",
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
      if (!evaluation.definition) {
        enrichAcceptedWord(room.code, submission.id, evaluation.rawWord).catch(() => {});
      }
      return json(res, 200, { ok: true, room: serialize(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/live/remove-team") {
      const { code, teamId, name } = await body(req);
      const room = getRoom(code);
      const clean = String(name || "").trim().toLowerCase();
      const removedTeamIds = new Set(room.teams
        .filter((team) => team.id === teamId || (clean && String(team.name || "").trim().toLowerCase() === clean))
        .map((team) => team.id));
      const before = room.teams.length;
      room.teams = room.teams.filter((team) => !removedTeamIds.has(team.id));
      if (room.teams.length === before) {
        throw new Error("Team not found");
      }
      room.players = room.players.filter((player) => !removedTeamIds.has(player.teamId));
      room.submissions = room.submissions.filter((submission) => !removedTeamIds.has(submission.teamId));
      touch(room);
      broadcastRoom(room);
      return json(res, 200, { room: serialize(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/buzzer/create-room") {
      return json(res, 200, { room: serializeBuzzerRoom(createBuzzerRoom()) });
    }

    if (req.method === "POST" && url.pathname === "/api/buzzer/delete-room") {
      const { code } = await body(req);
      const cleanCode = String(code || "").toUpperCase();
      const sockets = buzzerSockets.get(cleanCode);
      if (sockets) {
        sockets.forEach((socket) => {
          try {
            sendWebSocketJson(socket, { type: "buzzer-room-deleted", code: cleanCode });
            socket.destroy();
          } catch (_) {}
        });
      }
      buzzerRooms.delete(cleanCode);
      buzzerSockets.delete(cleanCode);
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/buzzer/room") {
      return json(res, 200, { room: serializeBuzzerRoom(getBuzzerRoom(url.searchParams.get("code"))) });
    }

    if (req.method === "GET" && url.pathname === "/api/buzzer/trivia-bank") {
      return json(res, 200, { items: buzzerTriviaBank });
    }

    if (req.method === "POST" && url.pathname === "/api/buzzer/trivia-bank") {
      const { items } = await body(req);
      buzzerTriviaBank = normalizeBuzzerTriviaBank(items);
      saveBuzzerTriviaBank();
      buzzerRooms.forEach((room) => {
        room.triviaUsedIndexes = getBuzzerTriviaUsedIndexes(room);
        if (Number(room.triviaIndex || 0) >= buzzerTriviaBank.length) {
          room.triviaIndex = 0;
          room.triviaAnswerVisible = false;
          touch(room);
          broadcastBuzzerRoom(room);
        } else if (room.triviaMode) {
          broadcastBuzzerRoom(room);
        }
      });
      return json(res, 200, { items: buzzerTriviaBank });
    }

    if (req.method === "POST" && url.pathname === "/api/buzzer/trivia-state") {
      const { code, triviaMode, triviaIndex, reveal, shuffle } = await body(req);
      const room = getBuzzerRoom(code);
      if (triviaMode !== undefined) {
        const wasTriviaMode = !!room.triviaMode;
        room.triviaMode = !!triviaMode;
        if (!wasTriviaMode && room.triviaMode && buzzerTriviaBank.length && room.triviaShuffle !== false) {
          const used = getBuzzerTriviaUsedIndexes(room);
          const available = buzzerTriviaBank.map((_, index) => index).filter((index) => !used.includes(index));
          room.triviaIndex = available.length
            ? available[Math.floor(Math.random() * available.length)]
            : Math.floor(Math.random() * buzzerTriviaBank.length);
        }
        if (!room.triviaMode) {
          room.triviaAnswerVisible = false;
          room.triviaAttemptedOptionIndexes = [];
        }
      }
      if (triviaIndex !== undefined && buzzerTriviaBank.length) {
        room.triviaIndex = Math.max(0, Math.min(buzzerTriviaBank.length - 1, Math.trunc(Number(triviaIndex) || 0)));
        room.triviaAnswerVisible = false;
        room.triviaAttemptedOptionIndexes = [];
      }
      if (shuffle !== undefined) {
        room.triviaShuffle = !!shuffle;
      }
      if (reveal !== undefined) {
        room.triviaAnswerVisible = !!reveal;
      }
      touch(room);
      broadcastBuzzerRoom(room);
      return json(res, 200, { room: serializeBuzzerRoom(room), items: buzzerTriviaBank });
    }

    if (req.method === "POST" && url.pathname === "/api/buzzer/trivia-next") {
      const { code } = await body(req);
      const room = getBuzzerRoom(code);
      markCurrentBuzzerTriviaUsed(room);
      advanceBuzzerTrivia(room);
      touch(room);
      broadcastBuzzerRoom(room);
      return json(res, 200, { room: serializeBuzzerRoom(room) });
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

    if (req.method === "POST" && url.pathname === "/api/buzzer/import-classroom") {
      const { code, classroomCode } = await body(req);
      const room = getBuzzerRoom(code);
      const classroom = getClassroomRoom(classroomCode);
      const previousPlayers = Array.isArray(room.players) ? room.players : [];
      const usedNames = new Set();
      const nextPlayers = (classroom.players || [])
        .map((sourcePlayer) => {
          const clean = String(sourcePlayer.name || "").trim();
          if (!clean) return null;
          const nameKey = clean.toLowerCase();
          if (usedNames.has(nameKey)) return null;
          usedNames.add(nameKey);
          const existing = previousPlayers.find((player) => Number(player.classroomPlayerId || 0) === Number(sourcePlayer.id || 0))
            || previousPlayers.find((player) => sameName(player.name, clean));
          return {
            id: existing?.id || `buzzer-player-${room.nextPlayerId++}`,
            name: clean,
            score: Number(existing?.score || 0),
            joinedAt: existing?.joinedAt || sourcePlayer.joinedAt || Date.now(),
            classroomPlayerId: sourcePlayer.id
          };
        })
        .filter(Boolean);
      const previousSignature = previousPlayers
        .map((player) => `${Number(player.classroomPlayerId || 0)}:${String(player.name || "").trim()}`)
        .sort()
        .join("|");
      const nextSignature = nextPlayers
        .map((player) => `${Number(player.classroomPlayerId || 0)}:${String(player.name || "").trim()}`)
        .sort()
        .join("|");
      const nextIds = new Set(nextPlayers.map((player) => player.id));
      room.players = nextPlayers;
      room.buzzes = (room.buzzes || []).filter((buzz) => nextIds.has(buzz.playerId));
      room.lockedOutPlayers = (room.lockedOutPlayers || []).filter((id) => nextIds.has(id));
      if (room.winner && !nextIds.has(room.winner.playerId)) {
        room.winner = null;
      }
      const changed = previousSignature !== nextSignature;
      if (changed) {
        touch(room);
        broadcastBuzzerRoom(room);
      }
      return json(res, 200, { room: serializeBuzzerRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/buzzer/start") {
      const { code } = await body(req);
      const room = getBuzzerRoom(code);
      if (!room.players.length) throw new Error("Add participants before going live");
      room.status = "live";
      if (!room.roundId) {
        room.roundId = 1;
      }
      if (room.triviaMode && room.triviaAnswerVisible) {
        advanceBuzzerTrivia(room);
      }
      room.buzzerHeld = false;
      room.roundStartedAt = Date.now();
      touch(room);
      broadcastBuzzerRoom(room);
      return json(res, 200, { room: serializeBuzzerRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/buzzer/clear-game") {
      const { code } = await body(req);
      const room = getBuzzerRoom(code);
      room.status = "waiting";
      room.roundId = 0;
      room.winner = null;
      room.podium = [];
      room.buzzes = [];
      room.lockedOutPlayers = [];
      room.buzzerHeld = true;
      room.triviaAnswerVisible = false;
      room.triviaAttemptedOptionIndexes = [];
      room.triviaUsedIndexes = [];
      room.roundStartedAt = 0;
      room.players.forEach((player) => {
        player.score = 0;
        player.hasPlayed = false;
      });
      touch(room);
      broadcastBuzzerRoom(room);
      return json(res, 200, { room: serializeBuzzerRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/buzzer/hold") {
      const { code, held } = await body(req);
      const room = getBuzzerRoom(code);
      if (room.triviaMode && room.triviaAnswerVisible && !held) {
        advanceBuzzerTrivia(room);
      }
      room.buzzerHeld = !!held;
      if (!Array.isArray(room.lockedOutPlayers)) {
        room.lockedOutPlayers = [];
      }
      touch(room);
      broadcastBuzzerRoom(room);
      return json(res, 200, { room: serializeBuzzerRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/buzzer/buzz") {
      const { code, playerId, playerName, roundId } = await body(req);
      const room = getBuzzerRoom(code);
      if (room.status !== "live") throw new Error("Buzzer is not live");
      if (room.buzzerHeld) {
        return json(res, 200, { accepted: false, held: true, room: serializeBuzzerRoom(room) });
      }
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
      const { code, playerId, delta, selectedOptionIndex } = await body(req);
      const room = getBuzzerRoom(code);
      if (!room.winner || room.winner.playerId !== playerId) {
        throw new Error("Score can only be applied to the current turn holder");
      }
      const player = room.players.find((item) => item.id === playerId);
      if (!player) throw new Error("Participant not found");
      const scoreDelta = Math.max(-10000, Math.min(10000, Math.trunc(Number(delta) || 0)));
      player.score = Number(player.score || 0) + scoreDelta;
      player.hasPlayed = true;
      if (scoreDelta < 0) {
        const lockedOutPlayers = Array.isArray(room.lockedOutPlayers) ? room.lockedOutPlayers : [];
        if (!lockedOutPlayers.includes(player.id)) {
          lockedOutPlayers.push(player.id);
        }
        room.lockedOutPlayers = lockedOutPlayers;
        if (room.triviaMode && selectedOptionIndex !== undefined) {
          const attempted = Array.isArray(room.triviaAttemptedOptionIndexes) ? room.triviaAttemptedOptionIndexes : [];
          const optionIndex = Math.trunc(Number(selectedOptionIndex));
          if (Number.isFinite(optionIndex) && optionIndex >= 0 && !attempted.includes(optionIndex)) {
            attempted.push(optionIndex);
          }
          room.triviaAttemptedOptionIndexes = attempted;
          const trivia = getBuzzerTriviaQuestion(room);
          const remainingOptions = Math.max(0, (trivia?.options || []).length - attempted.length);
          if (trivia?.type === "multiple" && remainingOptions <= 1) {
            markCurrentBuzzerTriviaUsed(room);
            room.triviaAnswerVisible = true;
            room.buzzerHeld = true;
            room.roundId += 1;
          } else {
            room.buzzerHeld = true;
          }
        } else {
          room.buzzerHeld = false;
        }
      } else {
        room.roundId += 1;
        room.lockedOutPlayers = [];
        room.buzzerHeld = true;
        if (room.triviaMode) {
          markCurrentBuzzerTriviaUsed(room);
          room.triviaAnswerVisible = true;
        } else {
          advanceBuzzerTrivia(room);
        }
      }
      room.winner = null;
      room.buzzes = [];
      room.roundStartedAt = Date.now();
      room.status = "live";
      touch(room);
      broadcastBuzzerRoom(room);
      return json(res, 200, { room: serializeBuzzerRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/buzzer/pass") {
      const { code } = await body(req);
      const room = getBuzzerRoom(code);
      if (room.status !== "live") throw new Error("Buzzer is not live");
      room.roundId += 1;
      room.lockedOutPlayers = [];
      room.buzzerHeld = true;
      room.winner = null;
      room.buzzes = [];
      room.roundStartedAt = Date.now();
      markCurrentBuzzerTriviaUsed(room);
      advanceBuzzerTrivia(room);
      touch(room);
      broadcastBuzzerRoom(room);
      return json(res, 200, { room: serializeBuzzerRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/buzzer/end-session") {
      const { code } = await body(req);
      const room = getBuzzerRoom(code);
      const ranked = room.players
        .slice()
        .sort((a, b) => (Number(b.score || 0) - Number(a.score || 0)) || String(a.name || "").localeCompare(String(b.name || "")))
        .map((player) => ({
          id: player.id,
          name: player.name,
          score: Number(player.score || 0)
        }));
      room.podium = ranked;
      room.status = "finished";
      room.buzzerHeld = true;
      room.winner = null;
      room.buzzes = [];
      touch(room);
      broadcastBuzzerRoom(room);
      return json(res, 200, { room: serializeBuzzerRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/buzzer/close-podium") {
      const { code } = await body(req);
      const room = getBuzzerRoom(code);
      room.podium = [];
      room.status = room.players.length ? "waiting" : "waiting";
      room.buzzerHeld = true;
      room.winner = null;
      room.buzzes = [];
      touch(room);
      broadcastBuzzerRoom(room);
      return json(res, 200, { room: serializeBuzzerRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/buzzer/remove-player") {
      const { code, playerId, name } = await body(req);
      const room = getBuzzerRoom(code);
      const clean = String(name || "").trim().toLowerCase();
      const removedIds = new Set(room.players
        .filter((player) => player.id === playerId || (clean && String(player.name || "").trim().toLowerCase() === clean))
        .map((player) => player.id));
      const before = room.players.length;
      room.players = room.players.filter((player) => !removedIds.has(player.id));
      if (room.players.length === before) throw new Error("Participant not found");
      room.buzzes = room.buzzes.filter((buzz) => !removedIds.has(buzz.playerId));
      room.lockedOutPlayers = (room.lockedOutPlayers || []).filter((id) => !removedIds.has(id));
      if (removedIds.has(room.winner?.playerId)) {
        room.winner = null;
      }
      touch(room);
      broadcastBuzzerRoom(room);
      return json(res, 200, { room: serializeBuzzerRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/wheel/create-room") {
      return json(res, 200, { room: serializeWheelRoom(createWheelRoom()) });
    }

    if (req.method === "POST" && url.pathname === "/api/wheel/delete-room") {
      const { code } = await body(req);
      wheelRooms.delete(String(code || "").toUpperCase());
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/wheel/room") {
      return json(res, 200, { room: serializeWheelRoom(getWheelRoom(url.searchParams.get("code"))) });
    }

    if (req.method === "POST" && url.pathname === "/api/wheel/sync") {
      const { code, names } = await body(req);
      const room = getWheelRoom(code);
      room.names = normalizeWheelNames(names);
      touch(room);
      return json(res, 200, { room: serializeWheelRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/wheel/join") {
      const { code, name } = await body(req);
      const room = getWheelRoom(code);
      const clean = String(name || "").trim();
      if (!clean) throw new Error("Name is required");
      if (!Array.isArray(room.players)) room.players = [];
      const alreadyExists = room.players.some((item) => String(item.name || "").trim().toLowerCase() === clean.toLowerCase());
      if (!alreadyExists) {
        room.players.push({ name: clean, joinedAt: Date.now() });
      }
      room.names = normalizeWheelNames(room.names);
      touch(room);
      return json(res, 200, { room: serializeWheelRoom(room), added: !alreadyExists, name: clean });
    }

    if (req.method === "POST" && url.pathname === "/api/wheel/import-classroom") {
      const { code, classroomCode } = await body(req);
      const room = getWheelRoom(code);
      const classroom = getClassroomRoom(classroomCode);
      const previousPlayers = Array.isArray(room.players) ? room.players : [];
      const nextPlayers = (classroom.players || [])
        .map((sourcePlayer) => {
          const clean = String(sourcePlayer.name || "").trim();
          if (!clean) return null;
          const existing = previousPlayers.find((player) => Number(player.classroomPlayerId || 0) === Number(sourcePlayer.id || 0))
            || previousPlayers.find((player) => sameName(player.name, clean));
          return {
            name: clean,
            joinedAt: existing?.joinedAt || sourcePlayer.joinedAt || Date.now(),
            classroomPlayerId: sourcePlayer.id
          };
        })
        .filter(Boolean);
      const previousSignature = previousPlayers
        .map((player) => `${Number(player.classroomPlayerId || 0)}:${String(player.name || "").trim()}`)
        .sort()
        .join("|");
      const nextSignature = nextPlayers
        .map((player) => `${Number(player.classroomPlayerId || 0)}:${String(player.name || "").trim()}`)
        .sort()
        .join("|");
      room.players = nextPlayers;
      if (room.activeTurnName && !room.players.some((player) => sameName(player.name, room.activeTurnName))) {
        room.activeTurnName = "";
      }
      const changed = previousSignature !== nextSignature;
      if (changed) touch(room);
      return json(res, 200, { room: serializeWheelRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/wheel/remove-player") {
      const { code, name } = await body(req);
      const room = getWheelRoom(code);
      const clean = String(name || "").trim().toLowerCase();
      const before = (room.players || []).length;
      room.players = (room.players || []).filter((player) => String(player.name || "").trim().toLowerCase() !== clean);
      if (room.players.length === before) throw new Error("Participant not found");
      if (sameName(room.activeTurnName, name)) room.activeTurnName = "";
      touch(room);
      return json(res, 200, { room: serializeWheelRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/wheel/set-turn") {
      const { code, name } = await body(req);
      const room = getWheelRoom(code);
      const clean = String(name || "").trim();
      if (!clean) throw new Error("Name is required");
      const player = (room.players || []).find((item) => sameName(item.name, clean));
      if (!player) throw new Error("Participant not found");
      room.activeTurnName = sameName(room.activeTurnName, player.name) ? "" : player.name;
      touch(room);
      return json(res, 200, { room: serializeWheelRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/wheel/request-spin") {
      const { code, name } = await body(req);
      const room = getWheelRoom(code);
      const clean = String(name || "").trim();
      if (!clean) throw new Error("Name is required");
      if (!sameName(room.activeTurnName, clean)) throw new Error("Wait for your turn.");
      room.spinCommandId = Number(room.spinCommandId || 0) + 1;
      touch(room);
      return json(res, 200, { room: serializeWheelRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/wheel/consume-turn") {
      const { code, name } = await body(req);
      const room = getWheelRoom(code);
      const clean = String(name || "").trim();
      if (!clean) throw new Error("Name is required");
      if (!sameName(room.activeTurnName, clean)) throw new Error("Wait for your turn.");
      room.activeTurnName = "";
      touch(room);
      return json(res, 200, { room: serializeWheelRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/bingo/create-room") {
      return json(res, 200, { room: serializeBingoRoom(createBingoRoom()) });
    }

    if (req.method === "POST" && url.pathname === "/api/bingo/delete-room") {
      const { code } = await body(req);
      bingoRooms.delete(String(code || "").toUpperCase());
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/bingo/room") {
      return json(res, 200, {
        room: serializeBingoRoom(getBingoRoom(url.searchParams.get("code")), url.searchParams.get("playerId"))
      });
    }

    if (req.method === "POST" && url.pathname === "/api/bingo/sync") {
      const { code, words, preset } = await body(req);
      const room = getBingoRoom(code);
      const nextWords = normalizeBingoWords(words);
      const changed = (room.words || []).join("\n").toLowerCase() !== nextWords.join("\n").toLowerCase();
      room.words = nextWords;
      room.preset = String(preset || "").trim();
      if (changed && !["live", "checking"].includes(room.status)) {
        room.cards = {};
        room.players.forEach((player) => ensureBingoCard(room, player.id));
        room.calledWords = [];
        room.pendingClaim = null;
        room.winner = null;
        room.status = "setup";
      }
      touch(room);
      return json(res, 200, { room: serializeBingoRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/bingo/join") {
      const { code, name, playerId, classroomPlayerId } = await body(req);
      const room = getBingoRoom(code);
      const clean = String(name || "").trim();
      if (!clean) throw new Error("Name is required");
      const requestedId = Number(playerId || 0);
      const requestedClassroomId = Number(classroomPlayerId || 0);
      let player = room.players.find((item) => Number(item.id) === requestedId)
        || room.players.find((item) => requestedClassroomId && Number(item.classroomPlayerId) === requestedClassroomId);
      const duplicate = room.players.find((item) => item !== player && String(item.name || "").trim().toLowerCase() === clean.toLowerCase());
      if (duplicate && requestedClassroomId) {
        player = duplicate;
      } else if (duplicate) {
        throw new Error("A participant with this name is already connected.");
      }
      if (!player) {
        player = { id: room.nextPlayerId || 1, name: clean, bingos: 0, joinedAt: Date.now(), updatedAt: Date.now(), classroomPlayerId: requestedClassroomId || undefined };
        room.nextPlayerId = Number(player.id) + 1;
        room.players.push(player);
      } else {
        player.name = clean;
        player.bingos = Number(player.bingos || 0);
        if (requestedClassroomId) player.classroomPlayerId = requestedClassroomId;
        player.updatedAt = Date.now();
      }
      ensureBingoCard(room, player.id);
      touch(room);
      return json(res, 200, { room: serializeBingoRoom(room, player.id), player });
    }

    if (req.method === "POST" && url.pathname === "/api/bingo/import-classroom") {
      const { code, classroomCode } = await body(req);
      const room = getBingoRoom(code);
      const classroom = getClassroomRoom(classroomCode);
      const previousPlayers = Array.isArray(room.players) ? room.players : [];
      const usedNames = new Set();
      const nextPlayers = (classroom.players || [])
        .map((sourcePlayer) => {
          const clean = String(sourcePlayer.name || "").trim();
          if (!clean) return null;
          const nameKey = clean.toLowerCase();
          if (usedNames.has(nameKey)) return null;
          usedNames.add(nameKey);
          const existing = previousPlayers.find((player) => Number(player.classroomPlayerId || 0) === Number(sourcePlayer.id || 0))
            || previousPlayers.find((player) => sameName(player.name, clean));
          const player = {
            id: existing?.id || room.nextPlayerId || 1,
            name: clean,
            bingos: Number(existing?.bingos || 0),
            joinedAt: existing?.joinedAt || sourcePlayer.joinedAt || Date.now(),
            updatedAt: Date.now(),
            classroomPlayerId: sourcePlayer.id
          };
          if (!existing) room.nextPlayerId = Number(player.id) + 1;
          ensureBingoCard(room, player.id);
          return player;
        })
        .filter(Boolean);
      const previousSignature = previousPlayers
        .map((player) => `${Number(player.classroomPlayerId || 0)}:${String(player.name || "").trim()}`)
        .sort()
        .join("|");
      const nextSignature = nextPlayers
        .map((player) => `${Number(player.classroomPlayerId || 0)}:${String(player.name || "").trim()}`)
        .sort()
        .join("|");
      const nextIds = new Set(nextPlayers.map((player) => String(player.id)));
      room.players = nextPlayers;
      Object.keys(room.cards || {}).forEach((id) => {
        if (!nextIds.has(String(id))) delete room.cards[id];
      });
      if (room.pendingClaim && !nextIds.has(String(room.pendingClaim.playerId || ""))) {
        room.pendingClaim = null;
        room.status = "live";
      }
      if (room.winner && !nextIds.has(String(room.winner.playerId || ""))) {
        room.winner = null;
        room.status = "setup";
      }
      const changed = previousSignature !== nextSignature;
      if (changed) touch(room);
      return json(res, 200, { room: serializeBingoRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/bingo/start") {
      const { code } = await body(req);
      const room = getBingoRoom(code);
      if ((room.words || []).length < 24) throw new Error("Add at least 24 vocabulary words.");
      if (!(room.players || []).length) throw new Error("Add participants before starting Bingo.");
      room.players.forEach((player) => ensureBingoCard(room, player.id));
      room.status = "live";
      room.calledWords = [];
      room.pendingClaim = null;
      room.winner = null;
      Object.values(room.cards || {}).forEach((card) => {
        (card.cells || []).forEach((cell) => {
          cell.marked = !!cell.free;
        });
      });
      touch(room);
      return json(res, 200, { room: serializeBingoRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/bingo/shuffle-card") {
      const { code, playerId } = await body(req);
      const room = getBingoRoom(code);
      if (room.status !== "setup") throw new Error("Cards can only be changed before Bingo starts.");
      const player = room.players.find((item) => Number(item.id) === Number(playerId || 0));
      if (!player) throw new Error("Participant not found.");
      if (!room.cards) room.cards = {};
      room.cards[String(player.id)] = makeUniqueBingoCard(room, player.id);
      touch(room);
      return json(res, 200, { room: serializeBingoRoom(room, player.id) });
    }

    if (req.method === "POST" && url.pathname === "/api/bingo/reset") {
      const { code, clearScores } = await body(req);
      const room = getBingoRoom(code);
      room.status = "setup";
      room.calledWords = [];
      room.cards = {};
      room.pendingClaim = null;
      room.winner = null;
      if (clearScores) {
        (room.players || []).forEach((player) => {
          player.bingos = 0;
          player.updatedAt = Date.now();
        });
      }
      touch(room);
      return json(res, 200, { room: serializeBingoRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/bingo/remove-player") {
      const { code, name, playerId } = await body(req);
      const room = getBingoRoom(code);
      const clean = String(name || "").trim().toLowerCase();
      const removedIds = new Set((room.players || [])
        .filter((player) => Number(player.id) === Number(playerId || 0) || (clean && String(player.name || "").trim().toLowerCase() === clean))
        .map((player) => String(player.id)));
      const before = room.players.length;
      room.players = room.players.filter((player) => !removedIds.has(String(player.id)));
      if (room.players.length === before) throw new Error("Participant not found.");
      removedIds.forEach((id) => {
        if (room.cards) delete room.cards[id];
      });
      if (removedIds.has(String(room.pendingClaim?.playerId || ""))) {
        room.pendingClaim = null;
        room.status = "live";
      }
      if (removedIds.has(String(room.winner?.playerId || ""))) {
        room.winner = null;
        room.status = "setup";
      }
      touch(room);
      return json(res, 200, { room: serializeBingoRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/bingo/call") {
      const { code } = await body(req);
      const room = getBingoRoom(code);
      if (room.status !== "live") throw new Error("Start Bingo first.");
      const called = new Set((room.calledWords || []).map((word) => String(word || "").toLowerCase()));
      const remaining = (room.words || []).filter((word) => !called.has(String(word || "").toLowerCase()));
      if (!remaining.length) throw new Error("All words have been called.");
      const word = remaining[Math.floor(Math.random() * remaining.length)];
      room.calledWords = [word, ...(room.calledWords || [])].slice(0, 300);
      touch(room);
      return json(res, 200, { room: serializeBingoRoom(room), word });
    }

    if (req.method === "POST" && url.pathname === "/api/bingo/mark") {
      const { code, playerId, word } = await body(req);
      const room = getBingoRoom(code);
      if (room.status !== "live") throw new Error("Bingo is not accepting marks right now.");
      const card = ensureBingoCard(room, playerId);
      if (!card) throw new Error("Bingo card is not ready.");
      const clean = String(word || "").trim();
      const cell = (card.cells || []).find((item) => String(item.word || "").trim().toLowerCase() === clean.toLowerCase());
      if (!cell) throw new Error("Word not found on your card.");
      if (!cell.free) {
        cell.marked = !cell.marked;
      }
      touch(room);
      return json(res, 200, { room: serializeBingoRoom(room, playerId) });
    }

    if (req.method === "POST" && url.pathname === "/api/bingo/claim") {
      const { code, playerId } = await body(req);
      const room = getBingoRoom(code);
      if (room.status !== "live") throw new Error("Bingo is not accepting claims right now.");
      const player = room.players.find((item) => Number(item.id) === Number(playerId || 0));
      if (!player) throw new Error("Participant not found.");
      const card = ensureBingoCard(room, player.id);
      const result = getBingoClaimResult(card, room.calledWords);
      room.status = "checking";
      room.pendingClaim = {
        playerId: player.id,
        name: player.name,
        card,
        line: result.line,
        pattern: result.pattern,
        isValid: result.isValid,
        reviewed: false,
        claimedAt: Date.now()
      };
      touch(room);
      return json(res, 200, { room: serializeBingoRoom(room, player.id), pendingClaim: room.pendingClaim });
    }

    if (req.method === "POST" && url.pathname === "/api/bingo/review-claim") {
      const { code } = await body(req);
      const room = getBingoRoom(code);
      if (!room.pendingClaim) throw new Error("No Bingo claim is waiting.");
      room.pendingClaim.reviewed = true;
      touch(room);
      return json(res, 200, { room: serializeBingoRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/bingo/resolve-claim") {
      const { code, valid } = await body(req);
      const room = getBingoRoom(code);
      const claim = room.pendingClaim;
      if (!claim) throw new Error("No Bingo claim is waiting.");
      if (valid) {
        if (!claim.isValid) throw new Error("This card does not have a valid Bingo.");
        const player = room.players.find((item) => Number(item.id) === Number(claim.playerId));
        if (player) {
          player.bingos = Number(player.bingos || 0) + 1;
          player.updatedAt = Date.now();
        }
        room.status = "finished";
        room.winner = {
          playerId: claim.playerId,
          name: claim.name,
          line: claim.line,
          pattern: claim.pattern,
          claimedAt: claim.claimedAt,
          confirmedAt: Date.now()
        };
      } else {
        room.status = "live";
      }
      room.pendingClaim = null;
      touch(room);
      return json(res, 200, { room: serializeBingoRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/poll/create-room") {
      return json(res, 200, { room: serializePollRoom(createPollRoom()) });
    }

    if (req.method === "POST" && url.pathname === "/api/poll/delete-room") {
      const { code } = await body(req);
      pollRooms.delete(String(code || "").toUpperCase());
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/poll/room") {
      return json(res, 200, { room: serializePollRoom(getPollRoom(url.searchParams.get("code"))) });
    }

    if (req.method === "POST" && url.pathname === "/api/poll/sync") {
      const { code, options, blockSelfVote, candidatePlayerIds, nominationMode, nomineePlayerIds } = await body(req);
      const room = getPollRoom(code);
      const nextOptions = normalizePollOptions(options);
      const validPlayerIds = new Set((room.players || []).map((player) => Number(player.id)));
      const nextCandidatePlayerIds = Array.from(new Set((Array.isArray(candidatePlayerIds) ? candidatePlayerIds : room.candidatePlayerIds || [])
        .map((id) => Number(id))
        .filter((id) => validPlayerIds.has(id))));
      const nextNomineePlayerIds = Array.from(new Set((Array.isArray(nomineePlayerIds) ? nomineePlayerIds : room.nomineePlayerIds || [])
        .map((id) => Number(id))
        .filter((id) => validPlayerIds.has(id))));
      const changed = room.options.join("\n") !== nextOptions.join("\n")
        || (room.candidatePlayerIds || []).join("|") !== nextCandidatePlayerIds.join("|")
        || room.blockSelfVote !== !!blockSelfVote;
      room.options = nextOptions;
      room.candidatePlayerIds = nextCandidatePlayerIds;
      room.blockSelfVote = !!blockSelfVote;
      room.nominationMode = !!nominationMode;
      room.nomineePlayerIds = nextNomineePlayerIds;
      if (changed && room.status !== "voting") {
        room.votes = [];
      }
      touch(room);
      return json(res, 200, { room: serializePollRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/poll/join") {
      const { code, name, playerId, classroomPlayerId } = await body(req);
      const room = getPollRoom(code);
      const clean = String(name || "").trim();
      if (!clean) throw new Error("Name is required");
      const requestedId = Number(playerId || 0);
      const requestedClassroomId = Number(classroomPlayerId || 0);
      let player = room.players.find((item) => item.id === requestedId)
        || room.players.find((item) => requestedClassroomId && Number(item.classroomPlayerId) === requestedClassroomId);
      const duplicate = room.players.find((item) => item !== player && String(item.name || "").trim().toLowerCase() === clean.toLowerCase());
      if (duplicate && requestedClassroomId) {
        player = duplicate;
      } else if (duplicate) {
        throw new Error("A participant with this name is already connected.");
      }
      if (!player) {
        player = { id: room.nextPlayerId || 1, name: clean, joinedAt: Date.now(), updatedAt: Date.now(), classroomPlayerId: requestedClassroomId || undefined };
        room.nextPlayerId = player.id + 1;
        room.players.push(player);
      } else {
        player.name = clean;
        if (requestedClassroomId) player.classroomPlayerId = requestedClassroomId;
        player.updatedAt = Date.now();
      }
      const playerIds = new Set(room.players.map((item) => Number(item.id)));
      room.candidatePlayerIds = (room.candidatePlayerIds || []).filter((id) => playerIds.has(Number(id)));
      room.nomineePlayerIds = (room.nomineePlayerIds || []).filter((id) => playerIds.has(Number(id)));
      touch(room);
      return json(res, 200, { room: serializePollRoom(room), player });
    }

    if (req.method === "POST" && url.pathname === "/api/poll/import-classroom") {
      const { code, classroomCode } = await body(req);
      const room = getPollRoom(code);
      const classroom = getClassroomRoom(classroomCode);
      const previousPlayers = Array.isArray(room.players) ? room.players : [];
      const usedNames = new Set();
      const nextPlayers = (classroom.players || [])
        .map((sourcePlayer) => {
          const clean = String(sourcePlayer.name || "").trim();
          if (!clean) return null;
          const nameKey = clean.toLowerCase();
          if (usedNames.has(nameKey)) return null;
          usedNames.add(nameKey);
          const existing = previousPlayers.find((player) => Number(player.classroomPlayerId || 0) === Number(sourcePlayer.id || 0))
            || previousPlayers.find((player) => sameName(player.name, clean));
          const player = {
            id: existing?.id || room.nextPlayerId || 1,
            name: clean,
            joinedAt: existing?.joinedAt || sourcePlayer.joinedAt || Date.now(),
            updatedAt: Date.now(),
            classroomPlayerId: sourcePlayer.id
          };
          if (!existing) room.nextPlayerId = Number(player.id) + 1;
          return player;
        })
        .filter(Boolean);
      const previousSignature = previousPlayers
        .map((player) => `${Number(player.classroomPlayerId || 0)}:${String(player.name || "").trim()}`)
        .sort()
        .join("|");
      const nextSignature = nextPlayers
        .map((player) => `${Number(player.classroomPlayerId || 0)}:${String(player.name || "").trim()}`)
        .sort()
        .join("|");
      room.players = nextPlayers;
      const playerIds = new Set(room.players.map((item) => Number(item.id)));
      room.candidatePlayerIds = (room.candidatePlayerIds || []).filter((id) => playerIds.has(Number(id)));
      room.nomineePlayerIds = (room.nomineePlayerIds || []).filter((id) => playerIds.has(Number(id)));
      room.votes = (room.votes || []).filter((vote) => {
        if (!playerIds.has(Number(vote.voterId))) return false;
        const candidateId = String(vote.candidateId || "");
        if (!candidateId.startsWith("player-")) return true;
        return playerIds.has(Number(candidateId.replace("player-", "")));
      });
      const changed = previousSignature !== nextSignature;
      if (changed) touch(room);
      return json(res, 200, { room: serializePollRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/poll/nominate") {
      const { code, playerId } = await body(req);
      const room = getPollRoom(code);
      if (!room.nominationMode) throw new Error("Nominations are not open.");
      const id = Number(playerId || 0);
      const player = room.players.find((item) => Number(item.id) === id);
      if (!player) throw new Error("Join the poll before nominating yourself.");
      const nominees = new Set((room.nomineePlayerIds || []).map((item) => Number(item)));
      const candidates = new Set((room.candidatePlayerIds || []).map((item) => Number(item)));
      if (nominees.has(id) || candidates.has(id)) {
        return json(res, 200, { room: serializePollRoom(room), alreadyNominated: true });
      }
      nominees.add(id);
      room.nomineePlayerIds = Array.from(nominees);
      touch(room);
      return json(res, 200, { room: serializePollRoom(room), alreadyNominated: false });
    }

    if (req.method === "POST" && url.pathname === "/api/poll/remove-player") {
      const { code, playerId, name } = await body(req);
      const room = getPollRoom(code);
      const clean = String(name || "").trim().toLowerCase();
      const ids = new Set((room.players || [])
        .filter((player) => Number(player.id) === Number(playerId || 0) || (clean && String(player.name || "").trim().toLowerCase() === clean))
        .map((player) => Number(player.id)));
      const before = room.players.length;
      room.players = room.players.filter((player) => !ids.has(Number(player.id)));
      if (room.players.length === before) throw new Error("Participant not found");
      room.candidatePlayerIds = (room.candidatePlayerIds || []).filter((candidateId) => !ids.has(Number(candidateId)));
      room.nomineePlayerIds = (room.nomineePlayerIds || []).filter((nomineeId) => !ids.has(Number(nomineeId)));
      room.votes = (room.votes || []).filter((vote) => !ids.has(Number(vote.voterId)) && !ids.has(Number(String(vote.candidateId || "").replace("player-", ""))));
      touch(room);
      return json(res, 200, { room: serializePollRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/poll/start") {
      const { code } = await body(req);
      const room = getPollRoom(code);
      const candidates = getPollCandidates(room);
      if (!room.players.length) throw new Error("Add participants before starting the vote.");
      if (candidates.length < 2) throw new Error("Add at least two options before starting the vote.");
      room.status = "voting";
      room.votes = [];
      room.pollId = Number(room.pollId || 0) + 1;
      touch(room);
      return json(res, 200, { room: serializePollRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/poll/end") {
      const { code } = await body(req);
      const room = getPollRoom(code);
      room.status = "closed";
      touch(room);
      return json(res, 200, { room: serializePollRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/poll/reset") {
      const { code, clearTargets } = await body(req);
      const room = getPollRoom(code);
      room.status = "waiting";
      room.votes = [];
      if (clearTargets) {
        room.options = [];
        room.candidatePlayerIds = [];
        room.nomineePlayerIds = [];
      }
      room.pollId = Number(room.pollId || 0) + 1;
      touch(room);
      return json(res, 200, { room: serializePollRoom(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/poll/vote") {
      const { code, playerId, candidateId } = await body(req);
      const room = getPollRoom(code);
      if (room.status !== "voting") throw new Error("Voting is not open.");
      const voter = room.players.find((player) => player.id === Number(playerId || 0));
      if (!voter) throw new Error("Join the poll before voting.");
      if (room.votes.some((vote) => vote.voterId === voter.id)) throw new Error("You already voted.");
      const candidate = getPollCandidates(room).find((item) => item.id === String(candidateId || ""));
      if (!candidate) throw new Error("Option not found.");
      if (room.blockSelfVote && candidate.playerId === voter.id) {
        throw new Error("You cannot vote for yourself.");
      }
      room.votes.push({ voterId: voter.id, voterName: voter.name, candidateId: candidate.id, candidateLabel: candidate.label, createdAt: Date.now() });
      touch(room);
      return json(res, 200, { room: serializePollRoom(room), vote: room.votes[room.votes.length - 1] });
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
