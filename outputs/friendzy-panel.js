(function () {
  const teacherOnlyPaths = new Set([
    "/",
    "/index.html",
    "/buzzer",
    "/buzzer.html",
    "/letter-clash",
    "/letter-card-game.html",
    "/name-wheel",
    "/name-wheel.html",
    "/quick-poll",
    "/quick-poll.html",
    "/bingo",
    "/bingo.html",
    "/timer",
    "/timer.html"
  ]);
  if (!teacherOnlyPaths.has(window.location.pathname)) return;
  if (window.__friendzyPanelLoaded) return;
  window.__friendzyPanelLoaded = true;

  const storageKey = "friendzy-classroom-code";
  let room = null;
  let baseUrl = window.location.origin;
  let pollTimer = null;
  let lastPlayersSignature = "";
  let wakeLock = null;

  async function requestFriendzyWakeLock() {
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    try {
      if (wakeLock && !wakeLock.released) return;
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    } catch (_) {
      wakeLock = null;
    }
  }

  ["pointerdown", "keydown", "touchstart"].forEach((eventName) => {
    document.addEventListener(eventName, requestFriendzyWakeLock, { passive: true });
  });
  window.addEventListener("focus", requestFriendzyWakeLock);
  window.addEventListener("pageshow", requestFriendzyWakeLock);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") requestFriendzyWakeLock();
  });
  requestFriendzyWakeLock();

  const style = document.createElement("style");
  style.textContent = `
    .friendzy-tab {
      position: fixed;
      right: 0;
      top: 50%;
      z-index: 9000;
      transform: translateY(-50%);
      width: 44px;
      min-height: 44px;
      padding: 0;
      border: 1px solid rgba(255,255,255,0.72);
      border-right: 0;
      border-radius: 18px 0 0 18px;
      display: grid;
      grid-template-columns: 44px 0;
      align-items: center;
      overflow: hidden;
      color: #100b2f;
      background: linear-gradient(135deg, rgba(255,255,255,0.92), rgba(238,248,255,0.86));
      box-shadow: 0 14px 38px rgba(16, 11, 47, 0.18);
      backdrop-filter: blur(16px);
      font: 1000 0.78rem "Trebuchet MS", "Segoe UI", sans-serif;
      letter-spacing: 0.04em;
      cursor: pointer;
      transition: width 160ms ease, transform 140ms ease, box-shadow 140ms ease;
    }

    .friendzy-tab:hover {
      width: 138px;
      transform: translateY(-50%) translateX(-3px);
      box-shadow: 0 18px 46px rgba(11, 130, 255, 0.2);
    }

    .friendzy-mark {
      width: 44px;
      height: 44px;
      display: grid;
      place-items: center;
      color: #fff;
      background: linear-gradient(135deg, #087dff, #3024d8);
      font-size: 1.25rem;
      line-height: 1;
      text-shadow: 0 2px 8px rgba(16, 11, 47, 0.28);
    }

    .friendzy-tab-info {
      min-width: 94px;
      padding: 0 10px 0 8px;
      display: grid;
      align-content: center;
      gap: 1px;
      white-space: nowrap;
      opacity: 0;
      transition: opacity 120ms ease;
    }

    .friendzy-tab:hover .friendzy-tab-info {
      opacity: 1;
    }

    .friendzy-tab strong {
      font-size: 0.74rem;
      line-height: 1;
      text-transform: uppercase;
    }

    .friendzy-tab small {
      color: rgba(16, 11, 47, 0.62);
      font-size: 0.64rem;
      letter-spacing: 0;
      text-transform: uppercase;
    }

    .friendzy-backdrop {
      position: fixed;
      inset: 0;
      z-index: 8999;
      background: rgba(16, 11, 47, 0.24);
      backdrop-filter: blur(8px);
    }

    .friendzy-backdrop.hidden,
    .friendzy-drawer.hidden,
    .friendzy-large.hidden {
      display: none;
    }

    .friendzy-drawer {
      position: fixed;
      right: clamp(10px, 1.5vw, 18px);
      top: clamp(10px, 1.5vw, 18px);
      bottom: clamp(10px, 1.5vw, 18px);
      z-index: 9001;
      width: min(390px, calc(100vw - 28px));
      padding: 16px;
      border-radius: 32px;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) auto;
      gap: 12px;
      color: #100b2f;
      background: rgba(255,255,255,0.93);
      border: 1px solid rgba(255,255,255,0.78);
      box-shadow: 0 34px 90px rgba(16, 11, 47, 0.28);
      backdrop-filter: blur(18px);
      font-family: "Trebuchet MS", "Segoe UI", sans-serif;
      animation: friendzyDrawerIn 180ms ease both;
    }

    .friendzy-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .friendzy-head h2 {
      margin: 0;
      color: #3e3580;
      font-size: 1rem;
      font-weight: 1000;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    .friendzy-head-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .friendzy-code {
      margin: 0;
      color: #ff2f45;
      font-size: 1.35rem;
      font-weight: 1000;
      letter-spacing: 0.1em;
      text-align: center;
    }

    .friendzy-qr {
      border-radius: 26px;
      padding: 12px;
      display: grid;
      gap: 8px;
      place-items: center;
      background: rgba(255,255,255,0.76);
      border: 1px solid rgba(16, 11, 47, 0.12);
      cursor: zoom-in;
      transition: transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease;
    }

    .friendzy-drawer.is-qr-hidden {
      grid-template-rows: auto minmax(0, 1fr) auto;
    }

    .friendzy-drawer.is-qr-hidden .friendzy-qr {
      display: none;
    }

    .friendzy-qr:hover {
      transform: translateY(-2px) scale(1.01);
      border-color: rgba(11, 130, 255, 0.34);
      box-shadow: 0 18px 42px rgba(11, 130, 255, 0.16);
    }

    .friendzy-qr img {
      width: min(100%, 245px);
      aspect-ratio: 1;
      object-fit: contain;
      border-radius: 18px;
      background: #fff;
      image-rendering: pixelated;
    }

    .friendzy-qr img.is-hidden {
      display: none;
    }

    .friendzy-fallback {
      display: none;
      margin: 0;
      padding: 12px;
      border-radius: 18px;
      color: #100b2f;
      background: #fff;
      font-size: 0.78rem;
      font-weight: 1000;
      line-height: 1.25;
      text-align: center;
      overflow-wrap: anywhere;
    }

    .friendzy-fallback.is-visible {
      display: block;
    }

    .friendzy-players {
      min-height: 0;
      overflow-y: auto;
      display: grid;
      align-content: start;
      gap: 10px;
      padding-right: 2px;
    }

    .friendzy-pill {
      min-height: 42px;
      padding: 8px 13px;
      border-radius: 999px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      color: #100b2f;
      font-weight: 1000;
      background: linear-gradient(135deg, rgba(255,255,255,0.96), rgba(238,248,255,0.88));
      border: 1px solid rgba(11, 130, 255, 0.18);
      box-shadow: 0 12px 28px rgba(16, 11, 47, 0.1);
    }

    .friendzy-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .friendzy-remove {
      width: 28px;
      min-width: 28px;
      min-height: 28px;
      height: 28px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      color: #fff;
      background: linear-gradient(135deg, #ff2f45, #a8001a);
      box-shadow: none;
      font: 1000 0.9rem "Trebuchet MS", "Segoe UI", sans-serif;
      cursor: pointer;
    }

    .friendzy-empty {
      margin: 0;
      padding: 18px 12px;
      color: rgba(16, 11, 47, 0.62);
      font-weight: 1000;
      text-align: center;
      border-radius: 22px;
      background: rgba(255,255,255,0.58);
      border: 1px dashed rgba(16, 11, 47, 0.14);
    }

    .friendzy-actions {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }

    .friendzy-actions button,
    .friendzy-head button,
    .friendzy-large button {
      min-height: 38px;
      border: 0;
      border-radius: 999px;
      padding: 0 12px;
      color: #100b2f;
      background: rgba(255,255,255,0.94);
      box-shadow: 0 12px 26px rgba(16, 11, 47, 0.12);
      font: 1000 0.9rem "Trebuchet MS", "Segoe UI", sans-serif;
      cursor: pointer;
    }

    .friendzy-actions .danger {
      color: #fff;
      background: linear-gradient(135deg, #ff2f45, #a8001a);
    }

    .friendzy-large {
      position: fixed;
      inset: 0;
      z-index: 9010;
      padding: clamp(14px, 3vw, 28px);
      display: grid;
      place-items: center;
      background: rgba(16, 11, 47, 0.46);
      backdrop-filter: blur(18px);
    }

    .friendzy-large-card {
      width: min(96vw, 1120px);
      height: min(92vh, 860px);
      padding: clamp(16px, 3vw, 28px);
      border-radius: clamp(28px, 4vw, 42px);
      display: grid;
      grid-template-columns: minmax(0, 1.45fr) minmax(260px, 0.65fr);
      gap: clamp(14px, 2vw, 22px);
      background: rgba(255,255,255,0.94);
      border: 1px solid rgba(255,255,255,0.78);
      box-shadow: 0 34px 94px rgba(16, 11, 47, 0.3);
      overflow: hidden;
    }

    .friendzy-large-main {
      min-width: 0;
      min-height: 0;
      display: grid;
      gap: 10px;
      place-items: center;
    }

    .friendzy-large-main img {
      justify-self: center;
      align-self: center;
      width: min(100%, 72vh, 720px);
      height: auto;
      aspect-ratio: 1 / 1;
      object-fit: contain;
      border-radius: 28px;
      background: #fff;
      image-rendering: pixelated;
    }

    .friendzy-large-side {
      min-height: 0;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      gap: 12px;
      padding: 14px;
      border-radius: 28px;
      background: rgba(255,255,255,0.68);
      border: 1px solid rgba(16, 11, 47, 0.12);
    }

    .friendzy-large-side h2 {
      margin: 0;
      color: #3e3580;
      font-size: 1rem;
      font-weight: 1000;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    .friendzy-large-list {
      min-height: 0;
      overflow-y: auto;
      display: grid;
      align-content: start;
      gap: 8px;
    }

    .friendzy-large-actions {
      display: grid;
      grid-template-columns: 1fr;
    }

    @keyframes friendzyDrawerIn {
      from { opacity: 0; transform: translateX(24px) scale(0.98); }
      to { opacity: 1; transform: translateX(0) scale(1); }
    }

    @media (max-width: 640px) {
      .friendzy-tab {
        display: none;
      }

      .friendzy-drawer {
        left: 10px;
        right: 10px;
        width: auto;
      }

      .friendzy-large-card {
        grid-template-columns: 1fr;
        height: min(94vh, 860px);
      }

      .friendzy-large-main img {
        width: min(100%, 44vh, 560px);
      }
    }
  `;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.innerHTML = `
    <button class="friendzy-tab" id="friendzyTab" type="button">
      <span class="friendzy-mark" aria-hidden="true">F</span>
      <span class="friendzy-tab-info">
        <strong>Friendzy</strong>
        <small id="friendzyTabCount">0 connected</small>
      </span>
    </button>
    <div class="friendzy-backdrop hidden" id="friendzyBackdrop"></div>
    <aside class="friendzy-drawer hidden" id="friendzyDrawer" aria-label="Friendzy connection panel">
      <div class="friendzy-head">
        <h2>Players <span id="friendzyPlayerCount">(0)</span></h2>
        <div class="friendzy-head-actions">
          <button id="friendzyQrToggle" type="button">Hide QR</button>
          <button id="friendzyPanelClose" type="button">Close</button>
        </div>
      </div>
      <section class="friendzy-qr" id="friendzyQrBox" role="button" tabindex="0" aria-label="Enlarge Friendzy QR">
        <img id="friendzyQrImage" alt="Friendzy classroom QR">
        <p class="friendzy-fallback" id="friendzyFallback">Creating QR...</p>
        <p class="friendzy-code" id="friendzyCode">-----</p>
      </section>
      <div class="friendzy-players" id="friendzyPlayers"></div>
      <div class="friendzy-actions">
        <button id="friendzyEnlarge" type="button">Enlarge</button>
        <button id="friendzyRefresh" type="button">Sync</button>
        <button class="danger" id="friendzyReset" type="button">Reset</button>
      </div>
    </aside>
    <div class="friendzy-large hidden" id="friendzyLarge" aria-hidden="true">
      <div class="friendzy-large-card">
        <div class="friendzy-large-main">
          <img id="friendzyLargeQr" alt="Large Friendzy classroom QR">
          <p class="friendzy-code" id="friendzyLargeCode">-----</p>
        </div>
        <section class="friendzy-large-side" aria-label="Connected players">
          <h2>Players <span id="friendzyLargeCount">(0)</span></h2>
          <div class="friendzy-large-list" id="friendzyLargePlayers"></div>
          <div class="friendzy-large-actions">
            <button id="friendzyLargeClose" type="button">Close</button>
          </div>
        </section>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  const tab = document.getElementById("friendzyTab");
  const tabCount = document.getElementById("friendzyTabCount");
  const backdrop = document.getElementById("friendzyBackdrop");
  const drawer = document.getElementById("friendzyDrawer");
  const closeBtn = document.getElementById("friendzyPanelClose");
  const qrBox = document.getElementById("friendzyQrBox");
  const qrToggle = document.getElementById("friendzyQrToggle");
  const qrImage = document.getElementById("friendzyQrImage");
  const fallback = document.getElementById("friendzyFallback");
  const codeEl = document.getElementById("friendzyCode");
  const countEl = document.getElementById("friendzyPlayerCount");
  const playersEl = document.getElementById("friendzyPlayers");
  const enlargeBtn = document.getElementById("friendzyEnlarge");
  const refreshBtn = document.getElementById("friendzyRefresh");
  const resetBtn = document.getElementById("friendzyReset");
  const large = document.getElementById("friendzyLarge");
  const largeQr = document.getElementById("friendzyLargeQr");
  const largeCode = document.getElementById("friendzyLargeCode");
  const largeCount = document.getElementById("friendzyLargeCount");
  const largePlayers = document.getElementById("friendzyLargePlayers");
  const largeClose = document.getElementById("friendzyLargeClose");
  let qrVisible = true;

  async function api(path, payload = null, method = "POST") {
    const response = await fetch(path, {
      method,
      headers: payload ? { "Content-Type": "application/json" } : undefined,
      body: payload ? JSON.stringify(payload) : undefined
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || "Request failed");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function isMissingRoomError(error) {
    return /room not found/i.test(String(error?.message || ""));
  }

  async function hydrateBaseUrl() {
    try {
      const data = await api("/api/live/server-info", null, "GET");
      const onLocalHost = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
      baseUrl = onLocalHost && data?.localOrigin ? data.localOrigin : (data?.publicOrigin || window.location.origin);
    } catch (_) {}
  }

  function getJoinUrl() {
    if (!room) return "";
    return `${baseUrl}/student-hub.html?code=${encodeURIComponent(room.code)}`;
  }

  function getQrSrc(size = 360) {
    if (!room) return "";
    return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(getJoinUrl())}`;
  }

  function escapeHtml(value) {
    return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function renderPlayers(target) {
    const players = room?.players || [];
    target.innerHTML = players.length
      ? players.map((player) => `
        <div class="friendzy-pill">
          <span class="friendzy-name">${escapeHtml(player.name)}</span>
          <button class="friendzy-remove" type="button" data-friendzy-remove="${escapeHtml(player.id)}" aria-label="Remove ${escapeHtml(player.name)}">x</button>
        </div>
      `).join("")
      : `<p class="friendzy-empty">Connected players will appear here.</p>`;
  }

  function render() {
    const players = room?.players || [];
    const count = players.length;
    const code = room?.code || "-----";
    const playersSignature = players.map((player) => `${player.id}:${player.name}`).join("|");
    tabCount.textContent = `${count} connected`;
    countEl.textContent = `(${count})`;
    largeCount.textContent = `(${count})`;
    drawer.classList.toggle("is-qr-hidden", !qrVisible);
    qrToggle.textContent = qrVisible ? "Hide QR" : "Show QR";
    codeEl.textContent = code;
    largeCode.textContent = code;
    fallback.textContent = getJoinUrl() || "Creating QR...";
    if (room) {
      qrImage.classList.remove("is-hidden");
      fallback.classList.remove("is-visible");
      qrImage.src = getQrSrc(360);
      largeQr.src = getQrSrc(840);
    }
    renderPlayers(playersEl);
    renderPlayers(largePlayers);
    if (playersSignature !== lastPlayersSignature) {
      lastPlayersSignature = playersSignature;
      window.dispatchEvent(new CustomEvent("friendzy:players-updated", {
        detail: { players, code: room?.code || "" }
      }));
    }
  }

  function isHomePage() {
    const path = window.location.pathname.replace(/\/+$/, "") || "/";
    return path === "/" || path.endsWith("/index.html");
  }

  async function setStandbyIfHome() {
    if (!room || !isHomePage()) return;
    try {
      await api("/api/classroom/set-tool", { code: room.code, activeTool: "standby", activeToolCode: "" });
      room.activeTool = "standby";
      room.activeToolCode = "";
      render();
    } catch (_) {}
  }

  function getCurrentToolState() {
    const path = window.location.pathname.replace(/\/+$/, "") || "/";
    if (path.endsWith("/buzzer")) {
      return { activeTool: "buzzer", activeToolCode: localStorage.getItem("letter-clash-buzzer-room-code") || "" };
    }
    if (path.endsWith("/letter-clash") || path.endsWith("/letter-card-game.html")) {
      return { activeTool: "letter-clash", activeToolCode: localStorage.getItem("letter-clash-live-room-code") || "" };
    }
    if (path.endsWith("/name-wheel")) {
      return { activeTool: "wheel", activeToolCode: localStorage.getItem("name-wheel-room-code") || "" };
    }
    if (path.endsWith("/quick-poll")) {
      return { activeTool: "quick-poll", activeToolCode: localStorage.getItem("quick-poll-room-code") || "" };
    }
    if (path.endsWith("/bingo")) {
      return { activeTool: "bingo", activeToolCode: localStorage.getItem("bingo-room-code") || "" };
    }
    if (isHomePage()) {
      return { activeTool: "standby", activeToolCode: "" };
    }
    return null;
  }

  async function syncCurrentToolState() {
    if (!room) return;
    const state = getCurrentToolState();
    if (!state) return;
    try {
      await api("/api/classroom/set-tool", { code: room.code, ...state });
      room.activeTool = state.activeTool;
      room.activeToolCode = state.activeToolCode;
      render();
    } catch (_) {}
  }

  async function ensureRoom() {
    const savedCode = localStorage.getItem(storageKey);
    if (savedCode) {
      try {
        const existing = await api(`/api/classroom/room?code=${encodeURIComponent(savedCode)}`, null, "GET");
        room = existing.room;
        render();
        return room;
      } catch (error) {
        if (isMissingRoomError(error)) {
          localStorage.removeItem(storageKey);
        } else {
          room = {
            code: savedCode,
            players: [],
            activeTool: "standby",
            activeToolCode: ""
          };
          render();
          return room;
        }
      }
    }
    const data = await api("/api/classroom/create-room");
    room = data.room;
    localStorage.setItem(storageKey, room.code);
    render();
    return room;
  }

  async function pollRoom() {
    if (!room) return;
    try {
      const data = await api(`/api/classroom/room?code=${encodeURIComponent(room.code)}`, null, "GET");
      room = data.room;
      render();
    } catch (error) {
      if (isMissingRoomError(error)) {
        room = null;
        localStorage.removeItem(storageKey);
        await ensureRoom();
      }
    } finally {
      pollTimer = setTimeout(pollRoom, 1200);
    }
  }

  function openDrawer() {
    drawer.classList.remove("hidden");
    backdrop.classList.remove("hidden");
    render();
  }

  function closeDrawer() {
    drawer.classList.add("hidden");
    backdrop.classList.add("hidden");
  }

  function openLarge() {
    large.classList.remove("hidden");
    large.setAttribute("aria-hidden", "false");
    render();
  }

  function closeLarge() {
    large.classList.add("hidden");
    large.setAttribute("aria-hidden", "true");
  }

  tab.addEventListener("click", openDrawer);
  closeBtn.addEventListener("click", closeDrawer);
  backdrop.addEventListener("click", closeDrawer);
  qrBox.addEventListener("click", openLarge);
  enlargeBtn.addEventListener("click", openLarge);
  largeClose.addEventListener("click", closeLarge);
  large.addEventListener("click", (event) => {
    if (event.target === large) closeLarge();
  });
  refreshBtn.addEventListener("click", () => {
    ensureRoom().then(syncCurrentToolState).then(() => pollRoom()).catch(() => {});
  });
  qrToggle.addEventListener("click", () => {
    qrVisible = !qrVisible;
    render();
  });
  resetBtn.addEventListener("click", async () => {
    if (!room || !confirm("Reset this Friendzy classroom session?")) return;
    const oldCode = room.code;
    try { await api("/api/classroom/delete-room", { code: oldCode }); } catch (_) {}
    localStorage.removeItem(storageKey);
    room = null;
    await ensureRoom();
    render();
    window.dispatchEvent(new CustomEvent("friendzy:reset"));
  });
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-friendzy-remove]");
    if (!button || !room) return;
    const playerId = Number(button.dataset.friendzyRemove || 0);
    if (!playerId) return;
    const player = (room.players || []).find((item) => Number(item.id) === playerId);
    if (!player || !confirm(`Remove ${player.name} from Friendzy?`)) return;
    try {
      const data = await api("/api/classroom/remove-player", { code: room.code, playerId });
      room = data.room;
      render();
      window.dispatchEvent(new CustomEvent("friendzy:player-removed", {
        detail: { playerId, name: player.name }
      }));
    } catch (error) {
      alert(error.message || "Could not remove player.");
    }
  });
  qrImage.addEventListener("error", () => {
    qrImage.classList.add("is-hidden");
    fallback.classList.add("is-visible");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeLarge();
    closeDrawer();
  });

  hydrateBaseUrl()
    .then(ensureRoom)
    .then(syncCurrentToolState)
    .then(() => {
      clearTimeout(pollTimer);
      pollRoom();
    })
    .catch(() => {
      tabCount.textContent = "offline";
    });
})();
