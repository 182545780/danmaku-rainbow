import { app, BrowserWindow, Menu, shell } from "electron";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { deserialize, serialize, WS_OP } from "tiny-bilibili-ws";

const PORT = 19190;
const HOST = "127.0.0.1";
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const staticRoot = join(__dirname, "..", "dist-web");
const MIXIN_KEY_TABLE = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/138 Safari/537.36";
const DEFAULT_SETTINGS = {
  roomId: "",
  speed: 14,
  fontSize: 28,
  opacity: 94,
  panelWidth: 440,
  panelSide: "right",
  colorMode: "rainbow",
  showNames: true,
  showShadow: true,
  showGifts: true,
  keywords: "",
};
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

let mainWindow = null;
let server = null;
let settings = { ...DEFAULT_SETTINGS };
let settingsPath = "";
let liveSocket = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let connectionGeneration = 0;
let messageSequence = 0;
let lastStatus = { state: "idle", message: "等待输入房间号" };
const eventClients = new Set();

function json(response, data, status = 200) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of eventClients) client.write(payload);
}

function updateStatus(status) {
  lastStatus = status;
  broadcast("status", status);
}

function saveSettings() {
  try {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  } catch (error) {
    console.error("保存设置失败", error);
  }
}

function loadSettings() {
  settingsPath = join(app.getPath("userData"), "settings.json");
  if (!existsSync(settingsPath)) return;
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(settingsPath, "utf8")) };
  } catch (error) {
    console.error("读取设置失败", error);
  }
}

function sanitizeSettings(input) {
  const next = { ...settings };
  if (typeof input.roomId === "string") next.roomId = input.roomId.replace(/\D/g, "").slice(0, 16);
  if (Number.isFinite(input.speed)) next.speed = Math.max(8, Math.min(30, Math.round(input.speed)));
  if (Number.isFinite(input.fontSize)) next.fontSize = Math.max(20, Math.min(44, Math.round(input.fontSize)));
  if (Number.isFinite(input.opacity)) next.opacity = Math.max(40, Math.min(100, Math.round(input.opacity)));
  if (Number.isFinite(input.panelWidth)) next.panelWidth = Math.max(320, Math.min(620, Math.round(input.panelWidth / 10) * 10));
  if (["left", "right"].includes(input.panelSide)) next.panelSide = input.panelSide;
  if (["rainbow", "source", "white"].includes(input.colorMode)) next.colorMode = input.colorMode;
  for (const key of ["showNames", "showShadow", "showGifts"]) {
    if (typeof input[key] === "boolean") next[key] = input[key];
  }
  if (typeof input.keywords === "string") next.keywords = input.keywords.slice(0, 2000);
  return next;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function getWbiKey(url) {
  return url.slice(url.lastIndexOf("/") + 1, url.lastIndexOf("."));
}

function signWbi(params, imgKey, subKey) {
  const rawKey = imgKey + subKey;
  const mixinKey = MIXIN_KEY_TABLE.map((index) => rawKey[index]).join("").slice(0, 32);
  const values = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(values)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(values[key]).replace(/[!'()*]/g, ""))}`)
    .join("&");
  const wRid = createHash("md5").update(query + mixinKey).digest("hex");
  return `${query}&w_rid=${wRid}`;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, ...options.headers },
    });
    if (!response.ok) throw new Error(`B 站接口返回 HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function getConnectionInfo(roomInput) {
  const room = await fetchJson(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomInput}`, {
    headers: { Referer: `https://live.bilibili.com/${roomInput}` },
  });
  if (room.code !== 0 || !room.data?.room_id) throw new Error(room.message || "直播间不存在");
  if (room.data.is_hidden || room.data.is_locked) throw new Error("该直播间当前不可访问");
  const roomId = Number(room.data.room_id);

  const nav = await fetchJson("https://api.bilibili.com/x/web-interface/nav", {
    headers: { Referer: "https://www.bilibili.com/" },
  });
  const imgUrl = nav.data?.wbi_img?.img_url;
  const subUrl = nav.data?.wbi_img?.sub_url;
  if (!imgUrl || !subUrl) throw new Error("无法取得 B 站 WBI 签名信息");
  const query = signWbi({ id: roomId, type: 0 }, getWbiKey(imgUrl), getWbiKey(subUrl));
  const danmu = await fetchJson(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`, {
    headers: {
      Referer: `https://live.bilibili.com/blanc/${roomId}?liteVersion=true`,
      Origin: "https://live.bilibili.com",
    },
  });
  if (danmu.code !== 0 || !danmu.data?.token || !danmu.data?.host_list?.length) {
    throw new Error(danmu.message === "-352" ? "B 站风控拦截，请稍后重试" : danmu.message || "无法获取弹幕线路");
  }
  return { roomId, token: danmu.data.token, hosts: danmu.data.host_list };
}

function colorFromNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `#${number.toString(16).padStart(6, "0").slice(-6)}` : "#ffffff";
}

function emitDanmu(data) {
  const info = data.info;
  if (!Array.isArray(info)) return;
  const user = Array.isArray(info[2]) ? String(info[2][1] || "匿名观众") : "匿名观众";
  const content = String(info[1] || "").trim();
  if (!content) return;
  broadcast("danmu", {
    id: `${Date.now()}-${messageSequence += 1}`,
    kind: "danmu",
    user,
    content,
    sourceColor: colorFromNumber(info[0]?.[3]),
    guardLevel: Number(info[2]?.[7] || 0),
  });
}

function emitSuperChat(data) {
  const body = data.data || {};
  broadcast("superchat", {
    id: `${Date.now()}-${messageSequence += 1}`,
    kind: "superchat",
    user: String(body.user_info?.uname || "醒目留言"),
    content: String(body.message || "发送了一条醒目留言"),
    sourceColor: body.background_color || "#ffb21c",
    price: Number(body.price || 0),
  });
}

function emitGift(data) {
  const body = data.data || {};
  const amount = Number(body.num || 1);
  broadcast("gift", {
    id: `${Date.now()}-${messageSequence += 1}`,
    kind: "gift",
    user: String(body.uname || "匿名观众"),
    content: `送出 ${body.giftName || "礼物"}${amount > 1 ? ` × ${amount}` : ""}`,
    sourceColor: "#ff5ca8",
  });
}

async function handleSocketData(raw, generation) {
  if (generation !== connectionGeneration) return;
  let packets;
  try {
    packets = await deserialize(new Uint8Array(raw));
  } catch (error) {
    console.error("弹幕包解析失败", error);
    return;
  }
  for (const packet of packets) {
    if (packet.meta.op === WS_OP.CONNECT_SUCCESS) {
      if (packet.data?.code && packet.data.code !== 0) throw new Error(`弹幕认证失败 ${packet.data.code}`);
      updateStatus({ ...lastStatus, state: "connected", message: "实时接收中" });
      liveSocket?.send(serialize(WS_OP.HEARTBEAT));
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (liveSocket?.readyState === WebSocket.OPEN) liveSocket.send(serialize(WS_OP.HEARTBEAT));
      }, 30000);
      continue;
    }
    if (packet.meta.op === WS_OP.HEARTBEAT_REPLY) {
      updateStatus({ ...lastStatus, state: "connected", message: "实时接收中", online: Number(packet.data || 0) });
      continue;
    }
    if (packet.meta.op !== WS_OP.MESSAGE || !packet.data) continue;
    const command = String(packet.data.cmd || packet.data.msg?.cmd || "");
    if (command.startsWith("DANMU_MSG")) emitDanmu(packet.data);
    else if (command === "SUPER_CHAT_MESSAGE" || command === "SUPER_CHAT_MESSAGE_JPN") emitSuperChat(packet.data);
    else if (command === "SEND_GIFT") emitGift(packet.data);
  }
}

function stopConnection() {
  connectionGeneration += 1;
  clearInterval(heartbeatTimer);
  clearTimeout(reconnectTimer);
  heartbeatTimer = null;
  reconnectTimer = null;
  if (liveSocket) {
    liveSocket.removeAllListeners();
    liveSocket.close();
    liveSocket = null;
  }
}

async function connectRoom(isReconnect = false) {
  const requestedRoom = settings.roomId;
  stopConnection();
  const generation = connectionGeneration;
  if (!requestedRoom) {
    updateStatus({ state: "idle", message: "等待输入房间号" });
    return;
  }
  updateStatus({ state: isReconnect ? "reconnecting" : "connecting", message: isReconnect ? "正在重新连接" : "正在获取直播间信息" });
  try {
    const info = await getConnectionInfo(requestedRoom);
    if (generation !== connectionGeneration || requestedRoom !== settings.roomId) return;
    const host = info.hosts[Math.floor(Math.random() * info.hosts.length)];
    const url = `wss://${host.host}:${host.wss_port}/sub`;
    updateStatus({ state: "connecting", message: "正在连接弹幕服务器", roomId: info.roomId });
    liveSocket = new WebSocket(url, {
      origin: "https://live.bilibili.com",
      headers: { "User-Agent": USER_AGENT },
      handshakeTimeout: 10000,
    });
    liveSocket.binaryType = "arraybuffer";
    liveSocket.on("open", () => {
      liveSocket?.send(serialize(WS_OP.USER_AUTHENTICATION, {
        uid: 0,
        roomid: info.roomId,
        protover: 2,
        platform: "web",
        type: 2,
        key: info.token,
      }));
    });
    liveSocket.on("message", (data) => {
      handleSocketData(data, generation).catch((error) => {
        updateStatus({ state: "error", message: error.message, roomId: info.roomId });
      });
    });
    liveSocket.on("error", (error) => {
      console.error("弹幕连接错误", error.message);
    });
    liveSocket.on("close", () => {
      clearInterval(heartbeatTimer);
      if (generation !== connectionGeneration || requestedRoom !== settings.roomId) return;
      updateStatus({ state: "reconnecting", message: "连接断开，5 秒后重试", roomId: info.roomId });
      reconnectTimer = setTimeout(() => connectRoom(true), 5000);
    });
  } catch (error) {
    if (generation !== connectionGeneration) return;
    const message = error.name === "AbortError" ? "连接 B 站超时" : error.message || "连接失败";
    updateStatus({ state: "error", message });
    reconnectTimer = setTimeout(() => {
      if (requestedRoom === settings.roomId) connectRoom(true);
    }, 10000);
  }
}

function serveStatic(requestUrl, response) {
  let pathname = decodeURIComponent(new URL(requestUrl, `http://${HOST}:${PORT}`).pathname);
  if (pathname === "/" || pathname === "/overlay") pathname = "/index.html";
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(staticRoot, safePath);
  if (!filePath.startsWith(staticRoot) || !existsSync(filePath)) filePath = join(staticRoot, "index.html");
  try {
    const contents = readFileSync(filePath);
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(filePath)] || "application/octet-stream",
      "Cache-Control": extname(filePath) === ".html" ? "no-store" : "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    response.end(contents);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

function startServer() {
  server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);
    try {
      if (url.pathname === "/events" && request.method === "GET") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        response.write(`event: settings\ndata: ${JSON.stringify(settings)}\n\n`);
        response.write(`event: status\ndata: ${JSON.stringify(lastStatus)}\n\n`);
        eventClients.add(response);
        const ping = setInterval(() => response.write(": ping\n\n"), 15000);
        request.on("close", () => {
          clearInterval(ping);
          eventClients.delete(response);
        });
        return;
      }
      if (url.pathname === "/api/settings" && request.method === "GET") return json(response, settings);
      if (url.pathname === "/api/status" && request.method === "GET") return json(response, lastStatus);
      if (url.pathname === "/api/settings" && request.method === "PUT") {
        const beforeRoom = settings.roomId;
        settings = sanitizeSettings(await readBody(request));
        saveSettings();
        broadcast("settings", settings);
        if (beforeRoom !== settings.roomId) connectRoom();
        return json(response, settings);
      }
      if (url.pathname === "/api/reconnect" && request.method === "POST") {
        connectRoom();
        return json(response, { ok: true });
      }
      if (url.pathname === "/api/test" && request.method === "POST") {
        broadcast("test", {
          id: `${Date.now()}-${messageSequence += 1}`,
          kind: "test",
          user: "彩虹测试员",
          content: "这是一条来自彩虹弹幕机的测试消息，文字较长时会像 Twitch 聊天一样自然换行显示。",
          sourceColor: "#8b5cf6",
        });
        return json(response, { ok: true });
      }
      if (url.pathname.startsWith("/api/")) return json(response, { error: "Not found" }, 404);
      serveStatic(request.url || "/", response);
    } catch (error) {
      console.error("本地服务请求失败", error);
      json(response, { error: error.message || "请求失败" }, 500);
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, resolve);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 880,
    minHeight: 680,
    backgroundColor: "#090b12",
    title: "彩虹弹幕机",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 22, y: 29 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL(`http://${HOST}:${PORT}/`);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "彩虹弹幕机",
      submenu: [
        { role: "about", label: "关于彩虹弹幕机" },
        { type: "separator" },
        { role: "hide", label: "隐藏彩虹弹幕机" },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "全部显示" },
        { type: "separator" },
        { role: "quit", label: "退出彩虹弹幕机" },
      ],
    },
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "窗口", submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }] },
  ]));
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    app.setName("彩虹弹幕机");
    loadSettings();
    installMenu();
    await startServer();
    createWindow();
    if (settings.roomId) connectRoom();
  }).catch((error) => {
    console.error("应用启动失败", error);
    app.quit();
  });

  app.on("activate", () => {
    if (!mainWindow) createWindow();
  });
  app.on("before-quit", () => {
    stopConnection();
    for (const client of eventClients) client.end();
    server?.close();
  });
  app.on("window-all-closed", () => {
    // macOS 关闭窗口后继续保留本地服务，让 OBS 浏览器源不中断。
  });
}
