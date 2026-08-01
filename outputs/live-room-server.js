const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = path.join(__dirname);
const TEACHER_HTML = path.join(ROOT, "letter-card-game.html");
const STUDENT_HTML = path.join(ROOT, "student.html");

const rooms = new Map();

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
    teams: [],
    submissions: [],
    lastSuccess: null,
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

function serialize(room) {
  return {
    code: room.code,
    status: room.status,
    letters: room.letters,
    teams: room.teams,
    submissions: room.submissions.slice(0, 12),
    lastSuccess: room.lastSuccess,
    podium: room.podium,
    updatedAt: room.updatedAt
  };
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
      const { code, letters, status, lastSuccess, teams, podium } = await body(req);
      const room = getRoom(code);
      room.letters = Array.isArray(letters) ? letters.slice(0, 8) : room.letters;
      if (status) room.status = status;
      if (lastSuccess !== undefined) room.lastSuccess = lastSuccess;
      if (Array.isArray(podium)) room.podium = podium.slice(0, 3);
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
      return json(res, 200, { room: serialize(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/live/start") {
      const { code } = await body(req);
      const room = getRoom(code);
      room.status = "live";
      touch(room);
      return json(res, 200, { room: serialize(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/live/join") {
      const { code, teamName } = await body(req);
      const room = getRoom(code);
      const clean = String(teamName || "").trim();
      if (!clean) throw new Error("Team name is required");
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
      team.members += 1;
      const player = { id: `player-${room.nextPlayerId++}`, teamId: team.id, teamName: team.name };
      touch(room);
      return json(res, 200, { player, room: serialize(room) });
    }

    if (req.method === "POST" && url.pathname === "/api/live/submit") {
      const { code, playerId, teamId, teamName, word } = await body(req);
      const room = getRoom(code);
      if (room.status !== "live") {
        throw new Error("Game is not accepting answers");
      }
      room.submissions.unshift({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        playerId,
        teamId,
        teamName,
        word: String(word || "").trim(),
        createdAt: Date.now()
      });
      room.submissions = room.submissions.slice(0, 12);
      touch(room);
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
      room.submissions = room.submissions.filter((submission) => submission.teamId !== teamId);
      touch(room);
      return json(res, 200, { room: serialize(room) });
    }

    res.writeHead(404);
    res.end("Not found");
  } catch (error) {
    json(res, 400, { error: error.message || "Request failed" });
  }
});

server.listen(PORT, HOST, () => {
  const host = getLocalIp();
  console.log(`Teacher view: http://localhost:${PORT}`);
  console.log(`Phone join:   http://${host}:${PORT}`);
});
