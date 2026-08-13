// ============================================================================
// wrangler-ephemeral-suite — chat + pizarra + airdrop en un solo deploy
// Cada herramienta vive bajo su propio prefijo de ruta (/chat, /board, /drop)
// para no colisionar entre sí (chat y pizarra usaban ambos "/room/*" en sus
// repos originales standalone).
// ============================================================================

const TEMP_ACCOUNT_LIFETIME_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// CHAT
// ---------------------------------------------------------------------------
const CHAT_HISTORY_LIMIT = 50;

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        text TEXT NOT NULL,
        ts INTEGER NOT NULL
      )`
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS room_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT NOT NULL DEFAULT 'open',
        admin_token TEXT,
        created_ts INTEGER
      )`
    );
    this.sql.exec(`INSERT OR IGNORE INTO room_config (id, mode, admin_token, created_ts) VALUES (1, 'open', NULL, ?)`, Date.now());
    this.sql.exec(`UPDATE room_config SET created_ts = ? WHERE id = 1 AND created_ts IS NULL`, Date.now());
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS invites (
        token TEXT PRIMARY KEY,
        used INTEGER NOT NULL DEFAULT 0,
        created_ts INTEGER NOT NULL,
        used_ts INTEGER
      )`
    );
  }

  getConfig() {
    return [...this.sql.exec(`SELECT mode, admin_token, created_ts FROM room_config WHERE id = 1`)][0];
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }

    const url = new URL(request.url);
    const name = (url.searchParams.get("name") || "anónimo").slice(0, 32);
    const adminParam = url.searchParams.get("admin");
    const inviteParam = url.searchParams.get("invite");

    const config = this.getConfig();
    let isAdmin = false;
    let newAdminToken = null;

    if (adminParam) {
      if (!config.admin_token) {
        newAdminToken = crypto.randomUUID();
        this.sql.exec(`UPDATE room_config SET admin_token = ? WHERE id = 1`, newAdminToken);
        isAdmin = true;
      } else if (adminParam === config.admin_token) {
        isAdmin = true;
      }
    }

    if (!isAdmin && config.mode === "closed") {
      let validInvite = false;
      if (inviteParam) {
        const rows = [...this.sql.exec(`SELECT token FROM invites WHERE token = ? AND used = 0`, inviteParam)];
        if (rows.length) {
          this.sql.exec(`UPDATE invites SET used = 1, used_ts = ? WHERE token = ?`, Date.now(), inviteParam);
          validInvite = true;
        }
      }
      if (!validInvite) {
        return new Response("Este chat es privado. Necesitás un enlace de invitación válido.", { status: 403 });
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);
    server.serializeAttachment({ name, isAdmin });

    const history = [...this.sql.exec(
      `SELECT name, text, ts FROM messages ORDER BY id DESC LIMIT ?`,
      CHAT_HISTORY_LIMIT
    )].reverse();
    server.send(JSON.stringify({ history, ts: Date.now() }));
    server.send(JSON.stringify({
      status: true,
      mode: config.mode,
      isAdmin,
      adminToken: newAdminToken,
      createdTs: config.created_ts,
      expiryMs: TEMP_ACCOUNT_LIFETIME_MS,
      ts: Date.now(),
    }));

    const joinPayload = JSON.stringify({ system: true, text: `${name} se unió al chat`, ts: Date.now() });
    for (const session of this.state.getWebSockets()) {
      session.send(joinPayload);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const { name, isAdmin } = ws.deserializeAttachment() || { name: "anónimo", isAdmin: false };

    let parsed = null;
    try {
      parsed = JSON.parse(message);
    } catch {
      // not JSON, treat as plain chat text below
    }

    if (isAdmin && parsed && typeof parsed === "object" && parsed.cmd) {
      this.handleAdminCommand(ws, parsed);
      return;
    }

    const text = String(message);
    const ts = Date.now();

    this.sql.exec(`INSERT INTO messages (name, text, ts) VALUES (?, ?, ?)`, name, text, ts);
    this.sql.exec(
      `DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT ?)`,
      CHAT_HISTORY_LIMIT
    );

    const payload = JSON.stringify({ name, text, ts });
    for (const session of this.state.getWebSockets()) {
      session.send(payload);
    }
  }

  handleAdminCommand(ws, cmd) {
    if (cmd.cmd === "setMode") {
      const mode = cmd.mode === "closed" ? "closed" : "open";
      this.sql.exec(`UPDATE room_config SET mode = ? WHERE id = 1`, mode);
      const payload = JSON.stringify({ system: true, text: `La sala ahora es ${mode === "closed" ? "CERRADA (solo invitados)" : "ABIERTA (cualquiera con el enlace)"}`, ts: Date.now() });
      for (const session of this.state.getWebSockets()) {
        session.send(payload);
      }
      return;
    }

    if (cmd.cmd === "createInvite") {
      const token = crypto.randomUUID();
      this.sql.exec(`INSERT INTO invites (token, used, created_ts) VALUES (?, 0, ?)`, token, Date.now());
      ws.send(JSON.stringify({ inviteToken: token, ts: Date.now() }));
      return;
    }
  }

  async webSocketClose(ws) {
    const { name } = ws.deserializeAttachment() || { name: "anónimo" };
    const leavePayload = JSON.stringify({ system: true, text: `${name} salió del chat`, ts: Date.now() });
    for (const session of this.state.getWebSockets()) {
      session.send(leavePayload);
    }
  }
}

const CHAT_PAGE = `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --bg: #eef0f4;
    --card: #ffffff;
    --border: #e2e5ea;
    --text: #1c1f26;
    --muted: #7a8091;
    --primary: #3b6bf5;
    --primary-text: #ffffff;
    --bubble-other: #eef1f6;
    --danger: #c0392b;
    --radius: 14px;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    margin: 0;
    padding: 32px 16px;
    display: flex;
    justify-content: center;
  }
  .app { width: 100%; max-width: 480px; }
  h1 {
    font-size: 18px;
    font-weight: 600;
    margin: 0 0 16px 4px;
    color: var(--text);
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 1px 3px rgba(20, 20, 40, 0.06);
    padding: 20px;
  }
  #login input {
    width: 100%;
    padding: 11px 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    font-size: 15px;
    outline: none;
    margin-bottom: 10px;
  }
  #login input:focus { border-color: var(--primary); }
  button {
    font-family: inherit;
    cursor: pointer;
    border: none;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 600;
    transition: opacity 0.15s;
  }
  button:hover { opacity: 0.85; }
  #join {
    width: 100%;
    padding: 11px;
    background: var(--primary);
    color: var(--primary-text);
    font-size: 15px;
  }
  #loginError {
    color: var(--danger);
    margin-top: 10px;
    font-size: 13px;
    line-height: 1.4;
  }
  #chat { display: none; flex-direction: column; }
  #login { display: flex; flex-direction: column; justify-content: center; }
  #expiryBanner {
    display: none;
    padding: 8px 12px;
    margin-bottom: 12px;
    font-size: 12.5px;
    border-radius: 999px;
    background: #eaf0ff;
    color: #33447a;
    text-align: center;
  }
  #adminPanel {
    display: none;
    background: #fbfaf3;
    border: 1px solid #ecdfa0;
    border-radius: 12px;
    padding: 12px 14px;
    margin-bottom: 12px;
    font-size: 13px;
  }
  #adminPanel .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
  #adminPanel button {
    padding: 6px 10px;
    background: #fff;
    border: 1px solid #d8cc80;
    color: #6b5b0f;
    font-size: 12.5px;
  }
  #modeLabel { font-weight: 700; }
  #inviteList div, #adminLink {
    font-size: 11.5px;
    word-break: break-all;
    color: #445;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 6px;
    margin-top: 4px;
    display: block;
  }
  #log {
    height: 320px;
    overflow-y: auto;
    padding: 4px 2px 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .msg-row { display: flex; flex-direction: column; max-width: 78%; }
  .msg-row.own { align-self: flex-end; align-items: flex-end; }
  .msg-row.other { align-self: flex-start; align-items: flex-start; }
  .msg-name { font-size: 11.5px; font-weight: 700; margin: 0 4px 2px; }
  .bubble {
    padding: 9px 13px;
    border-radius: 16px;
    font-size: 14.5px;
    line-height: 1.35;
    word-break: break-word;
  }
  .own .bubble { background: var(--primary); color: var(--primary-text); border-bottom-right-radius: 4px; }
  .other .bubble { background: var(--bubble-other); color: var(--text); border-bottom-left-radius: 4px; }
  .msg-time { font-size: 10.5px; color: var(--muted); margin: 3px 4px 0; }
  .system-row { align-self: center; }
  .system-row .bubble {
    background: transparent;
    color: var(--muted);
    font-size: 12px;
    font-style: italic;
    padding: 2px 8px;
  }
  .divider {
    align-self: center;
    font-size: 11px;
    color: var(--muted);
    margin: 2px 0;
  }
  .input-row {
    display: flex;
    gap: 8px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  #msg {
    flex: 1;
    padding: 10px 14px;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 14.5px;
    outline: none;
  }
  #msg:focus { border-color: var(--primary); }
  #send {
    padding: 0 20px;
    background: var(--primary);
    color: var(--primary-text);
    border-radius: 999px;
  }
  .suite-nav { font-size: 12px; margin: 0 0 10px 4px; }
  .suite-nav a { color: var(--muted); text-decoration: none; }
  .suite-nav a:hover { color: var(--primary); }

  @media (max-width: 600px) {
    body { padding: 0; align-items: stretch; }
    .app {
      max-width: 100%;
      height: 100dvh;
      display: flex;
      flex-direction: column;
    }
    h1 { margin: 14px 16px 10px; flex-shrink: 0; }
    #login, #chat {
      flex: 1;
      min-height: 0;
      border-radius: 0;
      border-left: none;
      border-right: none;
      border-bottom: none;
      box-shadow: none;
    }
    #expiryBanner, #adminPanel { flex-shrink: 0; }
    #log { flex: 1; height: auto; min-height: 0; }
    .input-row { flex-shrink: 0; }
  }
</style>
</head>
<body>
<div class="app">
  <h1>💬 Chat efímero</h1>
  <div class="suite-nav"><a href="/">← suite</a> · <a href="/board">pizarra</a> · <a href="/drop">airdrop</a></div>

  <div id="login" class="card">
    <input id="name" placeholder="tu nombre">
    <button id="join">entrar</button>
    <div id="loginError"></div>
  </div>

  <div id="chat" class="card">
    <div id="expiryBanner"></div>
    <div id="adminPanel">
      <div class="row"><b>Panel admin</b> · modo: <span id="modeLabel">-</span></div>
      <div class="row">
        <button id="toggleMode">cambiar a...</button>
        <button id="createInvite">generar invitación</button>
      </div>
      <div id="inviteList"></div>
      <div style="color:#8a7c2a; font-size:11px; margin-top:6px;">Guardá este link para volver como admin:</div>
      <a id="adminLink" href="#"></a>
    </div>
    <div id="log"></div>
    <div class="input-row">
      <input id="msg" placeholder="Escribí un mensaje...">
      <button id="send">Enviar</button>
    </div>
  </div>
</div>

  <script>
    function colorFor(name) {
      let hash = 0;
      for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
      return 'hsl(' + (hash % 360) + ', 60%, 40%)';
    }

    const params = new URLSearchParams(location.search);
    const adminParam = params.get('admin');
    const inviteParam = params.get('invite');

    let ws;
    let currentMode = 'open';
    let expiryInterval = null;
    const log = document.getElementById('log');

    function startExpiryCountdown(expiresAt) {
      const banner = document.getElementById('expiryBanner');
      banner.style.display = 'block';
      if (expiryInterval) clearInterval(expiryInterval);

      function tick() {
        const remainingMs = expiresAt - Date.now();
        if (remainingMs <= 0) {
          banner.textContent = '⏳ Este chat efímero ya debería haber desaparecido (cuenta temporal vencida). Puede cortarse en cualquier momento.';
          banner.style.background = '#fdd';
          banner.style.color = '#a00';
          clearInterval(expiryInterval);
          return;
        }
        const mins = Math.floor(remainingMs / 60000);
        const secs = Math.floor((remainingMs % 60000) / 1000);
        const label = mins + ':' + String(secs).padStart(2, '0');
        banner.textContent = '⏳ Chat efímero: se autodestruye en ~' + label + ' (aproximado, cuenta temporal de Cloudflare)';
        if (remainingMs < 5 * 60000) {
          banner.style.background = '#fee';
          banner.style.color = '#a40';
        }
      }
      tick();
      expiryInterval = setInterval(tick, 1000);
    }

    function connect(myName) {
      const loginError = document.getElementById('loginError');
      loginError.textContent = '';

      let wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host +
        '/chat/room/test?name=' + encodeURIComponent(myName);
      if (adminParam) wsUrl += '&admin=' + encodeURIComponent(adminParam);
      if (inviteParam) wsUrl += '&invite=' + encodeURIComponent(inviteParam);
      ws = new WebSocket(wsUrl);

      let hasOpened = false;
      ws.onopen = () => {
        hasOpened = true;
        document.getElementById('login').style.display = 'none';
        document.getElementById('chat').style.display = 'flex';
      };

      ws.onclose = () => {
        if (!hasOpened) {
          loginError.textContent = 'No se pudo entrar: la sala es privada y necesitás un enlace de invitación válido (o el tuyo ya se usó).';
        }
      };

      function esc(s) {
        const div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
      }

      function renderMsg(d) {
        const time = new Date(d.ts).toLocaleTimeString();
        if (d.system) {
          log.innerHTML += '<div class="msg-row system-row"><div class="bubble">' + esc(d.text) + '</div></div>';
          return;
        }
        const isOwn = d.name === myName;
        const side = isOwn ? 'own' : 'other';
        log.innerHTML +=
          '<div class="msg-row ' + side + '">' +
            (isOwn ? '' : '<div class="msg-name" style="color:' + colorFor(d.name) + '">' + esc(d.name) + '</div>') +
            '<div class="bubble">' + esc(d.text) + '</div>' +
            '<div class="msg-time">' + time + '</div>' +
          '</div>';
      }

      function updateModeUI() {
        document.getElementById('modeLabel').textContent = currentMode;
        document.getElementById('toggleMode').textContent = currentMode === 'open' ? 'cambiar a CERRADA' : 'cambiar a ABIERTA';
      }

      ws.onmessage = (e) => {
        const d = JSON.parse(e.data);
        if (d.history) {
          if (d.history.length) {
            log.innerHTML += '<div class="divider">— historial —</div>';
            d.history.forEach(renderMsg);
            log.innerHTML += '<div class="divider">— ahora —</div>';
          }
        } else if (d.status) {
          currentMode = d.mode;
          if (d.createdTs && d.expiryMs) {
            startExpiryCountdown(d.createdTs + d.expiryMs);
          }
          if (d.isAdmin) {
            document.getElementById('adminPanel').style.display = 'block';
            updateModeUI();
            if (d.adminToken) {
              const link = location.origin + location.pathname + '?admin=' + d.adminToken;
              const a = document.getElementById('adminLink');
              a.href = link;
              a.textContent = link;
            }
          }
        } else if (d.inviteToken) {
          const link = location.origin + location.pathname + '?invite=' + d.inviteToken;
          const div = document.createElement('div');
          div.textContent = 'Invitación: ' + link;
          document.getElementById('inviteList').appendChild(div);
        } else {
          renderMsg(d);
          if (d.system && d.text.includes('sala ahora es')) {
            currentMode = d.text.includes('CERRADA') ? 'closed' : 'open';
            updateModeUI();
          }
        }
        log.scrollTop = log.scrollHeight;
      };
    }

    function join() {
      const n = document.getElementById('name');
      const myName = (n.value || 'anónimo').trim();
      if (!myName) return;
      localStorage.setItem('chatName', myName);
      connect(myName);
    }
    document.getElementById('join').onclick = join;
    document.getElementById('name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') join();
    });

    function sendMsg() {
      const i = document.getElementById('msg');
      if (!i.value) return;
      ws.send(i.value);
      i.value = '';
    }
    document.getElementById('send').onclick = sendMsg;
    document.getElementById('msg').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendMsg();
    });

    document.getElementById('toggleMode').onclick = () => {
      const next = currentMode === 'open' ? 'closed' : 'open';
      ws.send(JSON.stringify({ cmd: 'setMode', mode: next }));
    };
    document.getElementById('createInvite').onclick = () => {
      ws.send(JSON.stringify({ cmd: 'createInvite' }));
    };

    const saved = localStorage.getItem('chatName');
    if (saved) {
      document.getElementById('name').value = saved;
    }
  </script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// PIZARRA (Board)
// ---------------------------------------------------------------------------
const STROKE_LIMIT = 300;

export class Board {
  constructor(state, env) {
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS strokes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        width REAL NOT NULL,
        points TEXT NOT NULL,
        ts INTEGER NOT NULL
      )`
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS room_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT NOT NULL DEFAULT 'open',
        admin_token TEXT,
        created_ts INTEGER
      )`
    );
    this.sql.exec(`INSERT OR IGNORE INTO room_config (id, mode, admin_token, created_ts) VALUES (1, 'open', NULL, ?)`, Date.now());
    this.sql.exec(`UPDATE room_config SET created_ts = ? WHERE id = 1 AND created_ts IS NULL`, Date.now());
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS invites (
        token TEXT PRIMARY KEY,
        used INTEGER NOT NULL DEFAULT 0,
        created_ts INTEGER NOT NULL,
        used_ts INTEGER
      )`
    );
  }

  getConfig() {
    return [...this.sql.exec(`SELECT mode, admin_token, created_ts FROM room_config WHERE id = 1`)][0];
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }

    const url = new URL(request.url);
    const name = (url.searchParams.get("name") || "anónimo").slice(0, 32);
    const adminParam = url.searchParams.get("admin");
    const inviteParam = url.searchParams.get("invite");

    const config = this.getConfig();
    let isAdmin = false;
    let newAdminToken = null;

    if (adminParam) {
      if (!config.admin_token) {
        newAdminToken = crypto.randomUUID();
        this.sql.exec(`UPDATE room_config SET admin_token = ? WHERE id = 1`, newAdminToken);
        isAdmin = true;
      } else if (adminParam === config.admin_token) {
        isAdmin = true;
      }
    }

    if (!isAdmin && config.mode === "closed") {
      let validInvite = false;
      if (inviteParam) {
        const rows = [...this.sql.exec(`SELECT token FROM invites WHERE token = ? AND used = 0`, inviteParam)];
        if (rows.length) {
          this.sql.exec(`UPDATE invites SET used = 1, used_ts = ? WHERE token = ?`, Date.now(), inviteParam);
          validInvite = true;
        }
      }
      if (!validInvite) {
        return new Response("Esta pizarra es privada. Necesitás un enlace de invitación válido.", { status: 403 });
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const clientId = crypto.randomUUID();
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ name, isAdmin, clientId });

    const history = [...this.sql.exec(
      `SELECT name, color, width, points, ts FROM strokes ORDER BY id ASC LIMIT ?`,
      STROKE_LIMIT
    )].map((row) => ({ ...row, points: JSON.parse(row.points) }));
    server.send(JSON.stringify({ history, ts: Date.now() }));
    server.send(JSON.stringify({
      status: true,
      mode: config.mode,
      isAdmin,
      adminToken: newAdminToken,
      clientId,
      createdTs: config.created_ts,
      expiryMs: TEMP_ACCOUNT_LIFETIME_MS,
      ts: Date.now(),
    }));

    const joinPayload = JSON.stringify({ system: true, text: `${name} se unió a la pizarra`, ts: Date.now() });
    for (const session of this.state.getWebSockets()) {
      session.send(joinPayload);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const { name, isAdmin, clientId } = ws.deserializeAttachment() || { name: "anónimo", isAdmin: false, clientId: null };

    let parsed = null;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;

    if (isAdmin && parsed.cmd) {
      this.handleAdminCommand(ws, parsed);
      return;
    }

    if (parsed.draw) {
      const payload = JSON.stringify({
        draw: true,
        clientId,
        strokeId: parsed.strokeId,
        color: parsed.color,
        width: parsed.width,
        points: parsed.points,
      });
      for (const session of this.state.getWebSockets()) {
        if (session !== ws) session.send(payload);
      }
      return;
    }

    if (parsed.strokeEnd) {
      const color = String(parsed.color || "#000000").slice(0, 16);
      const width = Number(parsed.width) || 3;
      const points = Array.isArray(parsed.points) ? parsed.points.slice(0, 5000) : [];
      const ts = Date.now();

      this.sql.exec(
        `INSERT INTO strokes (name, color, width, points, ts) VALUES (?, ?, ?, ?, ?)`,
        name, color, width, JSON.stringify(points), ts
      );
      this.sql.exec(
        `DELETE FROM strokes WHERE id NOT IN (SELECT id FROM strokes ORDER BY id DESC LIMIT ?)`,
        STROKE_LIMIT
      );
      return;
    }
  }

  handleAdminCommand(ws, cmd) {
    if (cmd.cmd === "setMode") {
      const mode = cmd.mode === "closed" ? "closed" : "open";
      this.sql.exec(`UPDATE room_config SET mode = ? WHERE id = 1`, mode);
      const payload = JSON.stringify({ system: true, text: `La pizarra ahora es ${mode === "closed" ? "CERRADA (solo invitados)" : "ABIERTA (cualquiera con el enlace)"}`, ts: Date.now() });
      for (const session of this.state.getWebSockets()) {
        session.send(payload);
      }
      return;
    }

    if (cmd.cmd === "createInvite") {
      const token = crypto.randomUUID();
      this.sql.exec(`INSERT INTO invites (token, used, created_ts) VALUES (?, 0, ?)`, token, Date.now());
      ws.send(JSON.stringify({ inviteToken: token, ts: Date.now() }));
      return;
    }

    if (cmd.cmd === "clearBoard") {
      this.sql.exec(`DELETE FROM strokes`);
      const payload = JSON.stringify({ clear: true, system: true, text: "El admin borró la pizarra", ts: Date.now() });
      for (const session of this.state.getWebSockets()) {
        session.send(payload);
      }
      return;
    }
  }

  async webSocketClose(ws) {
    const { name } = ws.deserializeAttachment() || { name: "anónimo" };
    const leavePayload = JSON.stringify({ system: true, text: `${name} salió de la pizarra`, ts: Date.now() });
    for (const session of this.state.getWebSockets()) {
      session.send(leavePayload);
    }
  }
}

const BOARD_COLORS = ["#1c1f26", "#e63946", "#f4a300", "#2a9d8f", "#3b6bf5", "#8e44ad"];

const BOARD_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --bg: #eef0f4;
    --card: #ffffff;
    --border: #e2e5ea;
    --text: #1c1f26;
    --muted: #7a8091;
    --primary: #3b6bf5;
    --primary-text: #ffffff;
    --danger: #c0392b;
    --radius: 14px;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    margin: 0;
    padding: 32px 16px;
    display: flex;
    justify-content: center;
  }
  .app { width: 100%; max-width: 640px; }
  h1 {
    font-size: 18px;
    font-weight: 600;
    margin: 0 0 16px 4px;
    color: var(--text);
  }
  .suite-nav { font-size: 12px; margin: 0 0 10px 4px; }
  .suite-nav a { color: var(--muted); text-decoration: none; }
  .suite-nav a:hover { color: var(--primary); }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 1px 3px rgba(20, 20, 40, 0.06);
    padding: 20px;
  }
  #login input {
    width: 100%;
    padding: 11px 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    font-size: 15px;
    outline: none;
    margin-bottom: 10px;
  }
  #login input:focus { border-color: var(--primary); }
  button {
    font-family: inherit;
    cursor: pointer;
    border: none;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 600;
    transition: opacity 0.15s;
  }
  button:hover { opacity: 0.85; }
  #join {
    width: 100%;
    padding: 11px;
    background: var(--primary);
    color: var(--primary-text);
    font-size: 15px;
  }
  #loginError { color: var(--danger); margin-top: 10px; font-size: 13px; line-height: 1.4; }
  #board-wrap { display: none; flex-direction: column; }
  #login { display: flex; flex-direction: column; justify-content: center; }
  #expiryBanner {
    display: none;
    padding: 8px 12px;
    margin-bottom: 12px;
    font-size: 12.5px;
    border-radius: 999px;
    background: #eaf0ff;
    color: #33447a;
    text-align: center;
  }
  #adminPanel {
    display: none;
    background: #fbfaf3;
    border: 1px solid #ecdfa0;
    border-radius: 12px;
    padding: 12px 14px;
    margin-bottom: 12px;
    font-size: 13px;
  }
  #adminPanel .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
  #adminPanel button {
    padding: 6px 10px;
    background: #fff;
    border: 1px solid #d8cc80;
    color: #6b5b0f;
    font-size: 12.5px;
  }
  #adminPanel button.danger { border-color: #e0a0a0; color: #a02020; }
  #modeLabel { font-weight: 700; }
  #inviteList div, #adminLink {
    font-size: 11.5px;
    word-break: break-all;
    color: #445;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 6px;
    margin-top: 4px;
    display: block;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
    flex-wrap: wrap;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }
  .swatch {
    width: 26px; height: 26px;
    border-radius: 50%;
    border: 2px solid transparent;
    cursor: pointer;
    padding: 0;
    box-shadow: 0 1px 2px rgba(0,0,0,0.08);
  }
  .swatch.active { border-color: var(--text); transform: scale(1.12); }
  .toolbar-sep { width: 1px; align-self: stretch; background: var(--border); margin: 0 2px; }
  #widthRange { width: 90px; accent-color: var(--primary); }
  .toolbar-actions { display: flex; gap: 6px; margin-left: auto; flex-wrap: wrap; }
  .tool-btn {
    background: var(--card);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 7px 12px;
    font-size: 13px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .tool-btn:hover { background: #f2f4f8; opacity: 1; }
  #canvas-holder {
    position: relative;
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    background: #fff;
    touch-action: none;
  }
  canvas { display: block; width: 100%; height: 440px; touch-action: none; }
  #log {
    max-height: 90px;
    overflow-y: auto;
    font-size: 12px;
    color: var(--muted);
    margin-top: 8px;
    font-style: italic;
  }

  @media (max-width: 700px) {
    body { padding: 0; align-items: stretch; }
    .app { max-width: 100%; height: 100dvh; display: flex; flex-direction: column; }
    h1 { margin: 14px 16px 10px; flex-shrink: 0; }
    #login, #board-wrap {
      flex: 1; min-height: 0;
      border-radius: 0; border-left: none; border-right: none; border-bottom: none; box-shadow: none;
    }
    #expiryBanner, #adminPanel, .toolbar { flex-shrink: 0; }
    #canvas-holder { flex: 1; min-height: 0; border-radius: 0; }
    canvas { height: 100%; }
    #log { flex-shrink: 0; }
  }
</style>
</head>
<body>
<div class="app">
  <h1>🎨 Pizarra efímera</h1>
  <div class="suite-nav"><a href="/">← suite</a> · <a href="/chat">chat</a> · <a href="/drop">airdrop</a></div>

  <div id="login" class="card">
    <input id="name" placeholder="tu nombre">
    <button id="join">entrar</button>
    <div id="loginError"></div>
  </div>

  <div id="board-wrap" class="card">
    <div id="expiryBanner"></div>
    <div id="adminPanel">
      <div class="row"><b>Panel admin</b> · modo: <span id="modeLabel">-</span></div>
      <div class="row">
        <button id="toggleMode">cambiar a...</button>
        <button id="createInvite">generar invitación</button>
        <button id="clearBoardBtn" class="danger">borrar pizarra</button>
      </div>
      <div id="inviteList"></div>
      <div style="color:#8a7c2a; font-size:11px; margin-top:6px;">Guardá este link para volver como admin:</div>
      <a id="adminLink" href="#"></a>
    </div>

    <div class="toolbar">
      ${BOARD_COLORS.map((c, i) => `<button class="swatch${i === 0 ? " active" : ""}" data-color="${c}" style="background:${c}"></button>`).join("")}
      <input type="range" id="widthRange" min="1" max="16" value="3" title="grosor del trazo">
      <div class="toolbar-sep"></div>
      <div class="toolbar-actions">
        <button id="downloadPngBtn" class="tool-btn" title="Descarga la pizarra como imagen PNG">📷 PNG</button>
        <button id="exportJsonBtn" class="tool-btn" title="Descarga el dibujo como JSON para poder retomarlo después">💾 Exportar</button>
        <button id="importJsonBtn" class="tool-btn" title="Cargá un JSON exportado antes para continuar el dibujo">📂 Importar</button>
        <input type="file" id="importJsonInput" accept="application/json" style="display:none;">
        <button id="clearBtn" class="tool-btn" title="borra solo tu vista, no la pizarra">🧹 Mi vista</button>
      </div>
    </div>

    <div id="canvas-holder">
      <canvas id="canvas"></canvas>
    </div>
    <div id="log"></div>
  </div>
</div>

<script>
  const params = new URLSearchParams(location.search);
  const adminParam = params.get('admin');
  const inviteParam = params.get('invite');

  let ws;
  let myClientId = null;
  let myName = '';
  let currentColor = ${JSON.stringify(BOARD_COLORS[0])};
  let currentWidth = 3;
  let currentMode = 'open';
  let expiryInterval = null;

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const holder = document.getElementById('canvas-holder');
  const logEl = document.getElementById('log');
  let history = [];

  function resizeCanvas() {
    const rect = holder.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redrawAll();
  }
  window.addEventListener('resize', resizeCanvas);

  function drawSegment(color, width, p1, p2) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(p1[0] * canvas.clientWidth, p1[1] * canvas.clientHeight);
    ctx.lineTo(p2[0] * canvas.clientWidth, p2[1] * canvas.clientHeight);
    ctx.stroke();
  }

  function drawStroke(stroke) {
    for (let i = 1; i < stroke.points.length; i++) {
      drawSegment(stroke.color, stroke.width, stroke.points[i - 1], stroke.points[i]);
    }
    if (stroke.points.length === 1) {
      drawSegment(stroke.color, stroke.width, stroke.points[0], stroke.points[0]);
    }
  }

  function redrawAll() {
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    history.forEach(drawStroke);
  }

  function logMsg(text) {
    const div = document.createElement('div');
    div.textContent = text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function startExpiryCountdown(expiresAt) {
    const banner = document.getElementById('expiryBanner');
    banner.style.display = 'block';
    if (expiryInterval) clearInterval(expiryInterval);
    function tick() {
      const remainingMs = expiresAt - Date.now();
      if (remainingMs <= 0) {
        banner.textContent = '⏳ Esta pizarra efímera ya debería haber desaparecido (cuenta temporal vencida).';
        banner.style.background = '#fdd'; banner.style.color = '#a00';
        clearInterval(expiryInterval);
        return;
      }
      const mins = Math.floor(remainingMs / 60000);
      const secs = Math.floor((remainingMs % 60000) / 1000);
      banner.textContent = '⏳ Pizarra efímera: se autodestruye en ~' + mins + ':' + String(secs).padStart(2, '0');
      if (remainingMs < 5 * 60000) { banner.style.background = '#fee'; banner.style.color = '#a40'; }
    }
    tick();
    expiryInterval = setInterval(tick, 1000);
  }

  function updateModeUI() {
    document.getElementById('modeLabel').textContent = currentMode;
    document.getElementById('toggleMode').textContent = currentMode === 'open' ? 'cambiar a CERRADA' : 'cambiar a ABIERTA';
  }

  function connect(name) {
    myName = name;
    const loginError = document.getElementById('loginError');
    loginError.textContent = '';

    let wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host +
      '/board/room/test?name=' + encodeURIComponent(name);
    if (adminParam) wsUrl += '&admin=' + encodeURIComponent(adminParam);
    if (inviteParam) wsUrl += '&invite=' + encodeURIComponent(inviteParam);
    ws = new WebSocket(wsUrl);

    let hasOpened = false;
    ws.onopen = () => {
      hasOpened = true;
      document.getElementById('login').style.display = 'none';
      document.getElementById('board-wrap').style.display = 'flex';
      requestAnimationFrame(resizeCanvas);
    };
    ws.onclose = () => {
      if (!hasOpened) {
        loginError.textContent = 'No se pudo entrar: la pizarra es privada y necesitás un enlace de invitación válido (o el tuyo ya se usó).';
      }
    };

    const liveStrokes = {};

    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);
      if (d.history) {
        history = d.history;
        redrawAll();
      } else if (d.status) {
        myClientId = d.clientId;
        currentMode = d.mode;
        if (d.createdTs && d.expiryMs) startExpiryCountdown(d.createdTs + d.expiryMs);
        if (d.isAdmin) {
          document.getElementById('adminPanel').style.display = 'block';
          updateModeUI();
          if (d.adminToken) {
            const link = location.origin + location.pathname + '?admin=' + d.adminToken;
            const a = document.getElementById('adminLink');
            a.href = link; a.textContent = link;
          }
        }
      } else if (d.inviteToken) {
        const link = location.origin + location.pathname + '?invite=' + d.inviteToken;
        const div = document.createElement('div');
        div.textContent = 'Invitación: ' + link;
        document.getElementById('inviteList').appendChild(div);
      } else if (d.draw) {
        if (d.clientId === myClientId) return;
        const key = d.clientId + ':' + d.strokeId;
        const prev = liveStrokes[key];
        const pts = d.points;
        if (prev && pts.length) drawSegment(d.color, d.width, prev, pts[0]);
        for (let i = 1; i < pts.length; i++) drawSegment(d.color, d.width, pts[i - 1], pts[i]);
        if (pts.length) liveStrokes[key] = pts[pts.length - 1];
      } else if (d.clear) {
        history = [];
        redrawAll();
        logMsg(d.text);
      } else if (d.system) {
        logMsg(d.text);
        if (d.text.includes('pizarra ahora es')) {
          currentMode = d.text.includes('CERRADA') ? 'closed' : 'open';
          updateModeUI();
        }
      }
    };
  }

  function join() {
    const n = document.getElementById('name');
    const name = (n.value || 'anónimo').trim();
    if (!name) return;
    localStorage.setItem('boardName', name);
    connect(name);
  }
  document.getElementById('join').onclick = join;
  document.getElementById('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  const saved = localStorage.getItem('boardName');
  if (saved) document.getElementById('name').value = saved;

  document.querySelectorAll('.swatch').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.swatch').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentColor = btn.dataset.color;
    });
  });
  document.getElementById('widthRange').addEventListener('input', (e) => {
    currentWidth = Number(e.target.value);
  });
  document.getElementById('clearBtn').onclick = () => { redrawAll(); };

  function downloadBlob(filename, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  document.getElementById('downloadPngBtn').onclick = () => {
    canvas.toBlob((blob) => {
      if (blob) downloadBlob('pizarra-' + Date.now() + '.png', blob);
    }, 'image/png');
  };

  document.getElementById('exportJsonBtn').onclick = () => {
    const payload = { exportedAt: Date.now(), strokes: history };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    downloadBlob('pizarra-' + Date.now() + '.json', blob);
  };

  document.getElementById('importJsonBtn').onclick = () => {
    document.getElementById('importJsonInput').click();
  };

  document.getElementById('importJsonInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try {
        data = JSON.parse(reader.result);
      } catch {
        alert('El archivo no es un JSON válido.');
        return;
      }
      const strokes = Array.isArray(data) ? data : data.strokes;
      if (!Array.isArray(strokes)) {
        alert('El JSON no tiene el formato esperado (falta "strokes").');
        return;
      }
      const connected = ws && ws.readyState === 1;
      strokes.forEach((s) => {
        if (!s || !Array.isArray(s.points) || !s.points.length) return;
        const stroke = {
          name: s.name || myName,
          color: typeof s.color === 'string' ? s.color : currentColor,
          width: Number(s.width) || 3,
          points: s.points,
          ts: Date.now(),
        };
        history.push(stroke);
        drawStroke(stroke);
        if (connected) {
          ws.send(JSON.stringify({ strokeEnd: true, color: stroke.color, width: stroke.width, points: stroke.points }));
        }
      });
      logMsg((connected ? myName + ' importó' : 'Se importaron') + ' ' + strokes.length + ' trazo(s)' + (connected ? '' : ' (sin conexión: no se guardaron en el servidor)'));
    };
    reader.readAsText(file);
  });

  document.getElementById('toggleMode').onclick = () => {
    const next = currentMode === 'open' ? 'closed' : 'open';
    ws.send(JSON.stringify({ cmd: 'setMode', mode: next }));
  };
  document.getElementById('createInvite').onclick = () => {
    ws.send(JSON.stringify({ cmd: 'createInvite' }));
  };
  document.getElementById('clearBoardBtn').onclick = () => {
    ws.send(JSON.stringify({ cmd: 'clearBoard' }));
  };

  // Drawing
  let drawing = false;
  let strokeId = null;
  let strokePoints = [];
  let pendingBatch = [];

  function toNorm(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return [(clientX - rect.left) / rect.width, (clientY - rect.top) / rect.height];
  }

  function pointerDown(clientX, clientY) {
    drawing = true;
    strokeId = crypto.randomUUID();
    const p = toNorm(clientX, clientY);
    strokePoints = [p];
    pendingBatch = [p];
    drawSegment(currentColor, currentWidth, p, p);
  }
  function pointerMove(clientX, clientY) {
    if (!drawing) return;
    const p = toNorm(clientX, clientY);
    const last = strokePoints[strokePoints.length - 1];
    drawSegment(currentColor, currentWidth, last, p);
    strokePoints.push(p);
    pendingBatch.push(p);
    if (pendingBatch.length >= 4) flushBatch();
  }
  function flushBatch() {
    if (!pendingBatch.length || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ draw: true, strokeId, color: currentColor, width: currentWidth, points: pendingBatch }));
    pendingBatch = [];
  }
  function pointerUp() {
    if (!drawing) return;
    drawing = false;
    flushBatch();
    if (ws && ws.readyState === 1 && strokePoints.length) {
      ws.send(JSON.stringify({ strokeEnd: true, color: currentColor, width: currentWidth, points: strokePoints }));
      history.push({ name: myName, color: currentColor, width: currentWidth, points: strokePoints, ts: Date.now() });
    }
    strokeId = null; strokePoints = [];
  }

  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); pointerDown(e.clientX, e.clientY); });
  canvas.addEventListener('pointermove', (e) => pointerMove(e.clientX, e.clientY));
  canvas.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('pointercancel', pointerUp);
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// AIRDROP (Drop)
// ---------------------------------------------------------------------------
const CHUNK_SIZE = 1024 * 1024;
const MAX_FILE_SIZE = 20 * 1024 * 1024;

export class Drop {
  constructor(state, env) {
    this.state = state;
    this.sql = state.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        filename TEXT NOT NULL,
        mimetype TEXT NOT NULL,
        size INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        created_ts INTEGER NOT NULL,
        downloads INTEGER NOT NULL DEFAULT 0
      )`
    );
    this.sql.exec(`CREATE TABLE IF NOT EXISTS chunks (idx INTEGER PRIMARY KEY, data BLOB NOT NULL)`);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/store") return this.handleStore(request);
    if (request.method === "GET" && url.pathname === "/meta") return this.handleMeta();
    if (request.method === "GET" && url.pathname === "/download") return this.handleDownload();
    return new Response("not found", { status: 404 });
  }

  async handleStore(request) {
    const filename = decodeURIComponent(request.headers.get("x-filename") || "archivo");
    const mimetype = request.headers.get("x-mimetype") || "application/octet-stream";
    const buf = await request.arrayBuffer();

    if (buf.byteLength === 0) {
      return new Response(JSON.stringify({ error: "Archivo vacío" }), { status: 400, headers: { "content-type": "application/json" } });
    }
    if (buf.byteLength > MAX_FILE_SIZE) {
      return new Response(JSON.stringify({ error: "Archivo demasiado grande (máx 20MB)" }), { status: 413, headers: { "content-type": "application/json" } });
    }

    const bytes = new Uint8Array(buf);
    const chunkCount = Math.max(1, Math.ceil(bytes.length / CHUNK_SIZE));

    this.sql.exec(`DELETE FROM chunks`);
    for (let i = 0; i < chunkCount; i++) {
      const chunk = bytes.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, bytes.length));
      this.sql.exec(`INSERT INTO chunks (idx, data) VALUES (?, ?)`, i, chunk);
    }

    this.sql.exec(
      `INSERT OR REPLACE INTO meta (id, filename, mimetype, size, chunk_count, created_ts, downloads)
       VALUES (1, ?, ?, ?, ?, ?, 0)`,
      filename, mimetype, bytes.length, chunkCount, Date.now()
    );

    return new Response(JSON.stringify({ ok: true, size: bytes.length, filename }), { headers: { "content-type": "application/json" } });
  }

  async handleMeta() {
    const rows = [...this.sql.exec(`SELECT filename, mimetype, size, created_ts, downloads FROM meta WHERE id = 1`)];
    if (!rows.length) {
      return new Response(JSON.stringify({ exists: false }), { headers: { "content-type": "application/json" } });
    }
    const row = rows[0];
    return new Response(JSON.stringify({
      exists: true,
      filename: row.filename,
      mimetype: row.mimetype,
      size: row.size,
      downloads: row.downloads,
      createdTs: row.created_ts,
      expiryMs: TEMP_ACCOUNT_LIFETIME_MS,
    }), { headers: { "content-type": "application/json" } });
  }

  async handleDownload() {
    const metaRows = [...this.sql.exec(`SELECT filename, mimetype, size FROM meta WHERE id = 1`)];
    if (!metaRows.length) return new Response("No encontrado", { status: 404 });
    const meta = metaRows[0];

    const chunkRows = [...this.sql.exec(`SELECT data FROM chunks ORDER BY idx ASC`)];
    const total = new Uint8Array(meta.size);
    let offset = 0;
    for (const row of chunkRows) {
      const arr = new Uint8Array(row.data);
      total.set(arr, offset);
      offset += arr.length;
    }

    this.sql.exec(`UPDATE meta SET downloads = downloads + 1 WHERE id = 1`);

    const safeName = meta.filename.replace(/[\r\n"]/g, "_");
    return new Response(total, {
      headers: {
        "content-type": meta.mimetype || "application/octet-stream",
        "content-disposition": `attachment; filename="${safeName}"`,
        "content-length": String(meta.size),
        "cache-control": "no-store",
      },
    });
  }
}

const DROP_STYLE = `
  :root {
    --bg: #eef0f4; --card: #ffffff; --border: #e2e5ea; --text: #1c1f26; --muted: #7a8091;
    --primary: #3b6bf5; --primary-text: #ffffff; --danger: #c0392b; --radius: 14px;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg); color: var(--text); margin: 0; padding: 32px 16px;
    display: flex; justify-content: center;
  }
  .app { width: 100%; max-width: 460px; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 8px 4px; }
  .suite-nav { font-size: 12px; margin: 0 0 10px 4px; }
  .suite-nav a { color: var(--muted); text-decoration: none; }
  .suite-nav a:hover { color: var(--primary); }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: 0 1px 3px rgba(20,20,40,0.06); padding: 24px; text-align: center;
  }
  #expiryBanner {
    display: none; padding: 8px 12px; margin-bottom: 16px; font-size: 12.5px; border-radius: 999px;
    background: #eaf0ff; color: #33447a; text-align: center;
  }
  .dropzone {
    border: 2px dashed var(--border); border-radius: 12px; padding: 40px 16px; cursor: pointer;
    color: var(--muted); font-size: 14px; transition: border-color .15s, background .15s;
  }
  .dropzone.drag { border-color: var(--primary); background: #f2f6ff; }
  button {
    font-family: inherit; cursor: pointer; border: none; border-radius: 10px; font-size: 14px;
    font-weight: 600; padding: 11px 20px; transition: opacity .15s;
  }
  button:hover { opacity: .85; }
  button:disabled { opacity: .5; cursor: default; }
  .btn-primary { background: var(--primary); color: var(--primary-text); width: 100%; margin-top: 14px; }
  .btn-ghost { background: #f2f4f8; color: var(--text); }
  #fileInput { display: none; }
  #error { color: var(--danger); font-size: 13px; margin-top: 10px; }
  #qrWrap { display: none; }
  .filemeta { font-size: 13px; color: var(--muted); margin-bottom: 4px; }
  .filemeta b { color: var(--text); }
  .linkbox {
    display: flex; gap: 8px; margin-top: 14px;
  }
  .linkbox input {
    flex: 1; font-size: 12px; padding: 9px 10px; border: 1px solid var(--border); border-radius: 8px;
    color: var(--text); background: #fafbfc;
  }
  .progress { height: 6px; background: #eee; border-radius: 999px; overflow: hidden; margin-top: 14px; display: none; }
  .progress-bar { height: 100%; width: 0%; background: var(--primary); transition: width .15s; }
`;

function dropUploadPage() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Airdrop efímero</title>
<script src="https://cdn.jsdelivr.net/gh/davidshimjs/qrcodejs/qrcode.min.js"></script>
<style>${DROP_STYLE}</style>
</head>
<body>
<div class="app">
  <h1>📦 Airdrop efímero</h1>
  <div class="suite-nav"><a href="/">← suite</a> · <a href="/chat">chat</a> · <a href="/board">pizarra</a></div>
  <div class="card">
    <div id="expiryBanner"></div>

    <div id="uploadView">
      <div class="dropzone" id="dropzone">
        Arrastrá un archivo acá, o hacé click para elegirlo<br>
        <span style="font-size:11px;">máx 20MB</span>
      </div>
      <input type="file" id="fileInput">
      <div class="progress" id="progress"><div class="progress-bar" id="progressBar"></div></div>
      <div id="error"></div>
    </div>

    <div id="qrWrap">
      <div class="filemeta"><b id="resFilename"></b></div>
      <div class="filemeta" id="resSize"></div>
      <div id="qrCanvas" style="display:flex; justify-content:center; margin:8px 0 16px;"></div>
      <div class="linkbox">
        <input id="resLink" readonly>
        <button class="btn-ghost" id="copyBtn">copiar</button>
      </div>
      <button class="btn-primary" id="resetBtn">subir otro archivo</button>
    </div>
  </div>
</div>

<script>
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const errorEl = document.getElementById('error');
  const progress = document.getElementById('progress');
  const progressBar = document.getElementById('progressBar');
  const uploadView = document.getElementById('uploadView');
  const qrWrap = document.getElementById('qrWrap');

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
    if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) uploadFile(fileInput.files[0]);
  });

  function humanSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function uploadFile(file) {
    errorEl.textContent = '';
    progress.style.display = 'block';
    progressBar.style.width = '0%';

    const xhr = new XMLHttpRequest();
    const q = '?name=' + encodeURIComponent(file.name) + '&type=' + encodeURIComponent(file.type || 'application/octet-stream');
    xhr.open('POST', '/drop/upload' + q);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) progressBar.style.width = Math.round((e.loaded / e.total) * 100) + '%';
    };
    xhr.onload = () => {
      progress.style.display = 'none';
      let data;
      try { data = JSON.parse(xhr.responseText); } catch { data = null; }
      if (xhr.status >= 200 && xhr.status < 300 && data && data.url) {
        showResult(data);
      } else {
        errorEl.textContent = (data && data.error) ? data.error : 'Error al subir el archivo.';
      }
    };
    xhr.onerror = () => { progress.style.display = 'none'; errorEl.textContent = 'Error de red al subir.'; };
    xhr.send(file);
  }

  function showResult(data) {
    uploadView.style.display = 'none';
    qrWrap.style.display = 'block';
    document.getElementById('resFilename').textContent = data.filename;
    document.getElementById('resSize').textContent = humanSize(data.size);
    document.getElementById('resLink').value = data.url;
    new QRCode(document.getElementById('qrCanvas'), { text: data.url, width: 200, height: 200 });
    startExpiryCountdown(Date.now(), 60 * 60 * 1000);
  }

  document.getElementById('copyBtn').onclick = () => {
    const input = document.getElementById('resLink');
    input.select();
    navigator.clipboard && navigator.clipboard.writeText(input.value);
  };
  document.getElementById('resetBtn').onclick = () => location.reload();

  function startExpiryCountdown(createdTs, expiryMs) {
    const banner = document.getElementById('expiryBanner');
    banner.style.display = 'block';
    const expiresAt = createdTs + expiryMs;
    function tick() {
      const remainingMs = expiresAt - Date.now();
      if (remainingMs <= 0) {
        banner.textContent = '⏳ Este archivo ya debería haber desaparecido (cuenta temporal vencida).';
        banner.style.background = '#fdd'; banner.style.color = '#a00';
        return;
      }
      const m = Math.floor(remainingMs / 60000);
      const s = Math.floor((remainingMs % 60000) / 1000);
      banner.textContent = '⏳ El link se autodestruye en ~' + m + ':' + String(s).padStart(2, '0');
      if (remainingMs < 5 * 60000) { banner.style.background = '#fee'; banner.style.color = '#a40'; }
      setTimeout(tick, 1000);
    }
    tick();
  }
</script>
</body>
</html>`;
}

function dropFilePage(token) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Descargar archivo — Airdrop efímero</title>
<style>${DROP_STYLE}</style>
</head>
<body>
<div class="app">
  <h1>📦 Airdrop efímero</h1>
  <div class="card">
    <div id="expiryBanner"></div>
    <div id="loading">Cargando...</div>
    <div id="content" style="display:none;">
      <div class="filemeta"><b id="filename"></b></div>
      <div class="filemeta" id="size"></div>
      <a id="downloadBtn" class="btn-primary" style="display:block; text-decoration:none;" href="#">⬇️ Descargar archivo</a>
    </div>
    <div id="notfound" style="display:none; color:#c0392b; font-size:14px;">
      Este archivo no existe o ya expiró (la cuenta temporal que lo alojaba se borró).
    </div>
  </div>
</div>
<script>
  const token = ${JSON.stringify(token)};
  function humanSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }
  fetch('/drop/file/' + token + '/meta').then((r) => r.json()).then((data) => {
    document.getElementById('loading').style.display = 'none';
    if (!data.exists) {
      document.getElementById('notfound').style.display = 'block';
      return;
    }
    document.getElementById('content').style.display = 'block';
    document.getElementById('filename').textContent = data.filename;
    document.getElementById('size').textContent = humanSize(data.size) + ' · ' + data.downloads + ' descarga(s)';
    document.getElementById('downloadBtn').href = '/drop/file/' + token + '/raw';

    const banner = document.getElementById('expiryBanner');
    banner.style.display = 'block';
    const expiresAt = data.createdTs + data.expiryMs;
    function tick() {
      const remainingMs = expiresAt - Date.now();
      if (remainingMs <= 0) {
        banner.textContent = '⏳ Este archivo ya debería haber desaparecido (cuenta temporal vencida).';
        banner.style.background = '#fdd'; banner.style.color = '#a00';
        return;
      }
      const m = Math.floor(remainingMs / 60000);
      const s = Math.floor((remainingMs % 60000) / 1000);
      banner.textContent = '⏳ Se autodestruye en ~' + m + ':' + String(s).padStart(2, '0');
      if (remainingMs < 5 * 60000) { banner.style.background = '#fee'; banner.style.color = '#a40'; }
      setTimeout(tick, 1000);
    }
    tick();
  }).catch(() => {
    document.getElementById('loading').style.display = 'none';
    document.getElementById('notfound').style.display = 'block';
  });
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// HUB
// ---------------------------------------------------------------------------
function hubPage() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ephemeral Suite</title>
<style>
  :root { --bg: #eef0f4; --card: #ffffff; --border: #e2e5ea; --text: #1c1f26; --muted: #7a8091; --radius: 14px; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg); color: var(--text); margin: 0; padding: 40px 16px;
    display: flex; justify-content: center;
  }
  .app { width: 100%; max-width: 480px; }
  h1 { font-size: 20px; margin: 0 0 6px 4px; }
  p.sub { color: var(--muted); font-size: 13.5px; margin: 0 0 24px 4px; }
  .card {
    display: block; text-decoration: none; color: var(--text);
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: 0 1px 3px rgba(20,20,40,0.06); padding: 20px; margin-bottom: 14px;
    display: flex; align-items: center; gap: 14px;
    transition: transform .1s;
  }
  .card:hover { transform: translateY(-2px); }
  .card .icon { font-size: 28px; }
  .card .title { font-weight: 700; font-size: 15.5px; margin-bottom: 2px; }
  .card .desc { color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<div class="app">
  <h1>🧰 Ephemeral Suite</h1>
  <p class="sub">Chat, pizarra y airdrop en un solo deploy — comparten la misma cuenta temporal de Cloudflare.</p>
  <a class="card" href="/chat">
    <span class="icon">💬</span>
    <div><div class="title">Chat efímero</div><div class="desc">Mensajes en tiempo real, admin e invitaciones</div></div>
  </a>
  <a class="card" href="/board">
    <span class="icon">🎨</span>
    <div><div class="title">Pizarra efímera</div><div class="desc">Dibujo colaborativo en vivo</div></div>
  </a>
  <a class="card" href="/drop">
    <span class="icon">📦</span>
    <div><div class="title">Airdrop efímero</div><div class="desc">Compartí un archivo por QR/link</div></div>
  </a>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// ROUTING
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Chat
    if (path.startsWith("/chat/room/")) {
      const roomName = path.split("/")[3] || "default";
      const id = env.CHAT_ROOM.idFromName(roomName);
      return env.CHAT_ROOM.get(id).fetch(request);
    }
    if (path === "/chat") {
      return new Response(CHAT_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // Pizarra
    if (path.startsWith("/board/room/")) {
      const roomName = path.split("/")[3] || "default";
      const id = env.BOARD.idFromName(roomName);
      return env.BOARD.get(id).fetch(request);
    }
    if (path === "/board") {
      return new Response(BOARD_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // Airdrop
    if (request.method === "POST" && path === "/drop/upload") {
      const filename = url.searchParams.get("name") || "archivo";
      const mimetype = url.searchParams.get("type") || "application/octet-stream";
      const token = crypto.randomUUID();
      const id = env.DROP.idFromName(token);
      const stub = env.DROP.get(id);

      const storeReq = new Request("https://drop/store", {
        method: "POST",
        body: request.body,
        headers: {
          "x-filename": encodeURIComponent(filename),
          "x-mimetype": mimetype,
        },
      });
      const res = await stub.fetch(storeReq);
      if (!res.ok) return res;
      const data = await res.json();
      return new Response(JSON.stringify({ ...data, token, url: `${url.origin}/drop/file/${token}` }), {
        headers: { "content-type": "application/json" },
      });
    }
    const dropFileMatch = path.match(/^\/drop\/file\/([a-zA-Z0-9-]+)(?:\/(raw|meta))?$/);
    if (dropFileMatch) {
      const token = dropFileMatch[1];
      const sub = dropFileMatch[2];
      const id = env.DROP.idFromName(token);
      const stub = env.DROP.get(id);
      if (sub === "raw") return stub.fetch("https://drop/download");
      if (sub === "meta") return stub.fetch("https://drop/meta");
      return new Response(dropFilePage(token), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (path === "/drop") {
      return new Response(dropUploadPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (path === "/") {
      return new Response(hubPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    return new Response("Not found", { status: 404 });
  },
};
