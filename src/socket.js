const { io } = require("socket.io-client");
const { getToken } = require("./auth");
const { OWNER_USERNAME } = require("../config/constants");
const { HttpsProxyAgent } = require("https-proxy-agent");

let socket = null;

function createSocketInstance(url, token) {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

  return io(url, {
    transports: ["websocket", "polling"],
    auth: {
      Authorization: token
    },
    extraHeaders: {
      "Origin": "https://groic.in",
      "Referer": "https://groic.in/",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
    },
    ...(agent ? { agent } : {}),
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 3000,
    timeout: 30000
  });
}

function connectSocket(url, onConnect, onDisconnect, onError) {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  // Use proxy if HTTPS_PROXY env var is set (required on cloud hosts like Render
  // where Cloudflare blocks direct connections to groic's servers)
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

  socket = io(url, {
    transports: ["websocket", "polling"],
    auth: {
      Authorization: getToken()
    },
    extraHeaders: {
      "Origin": "https://groic.in",
      "Referer": "https://groic.in/",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
      "Authorization": getToken(),
      "x-app-version": "web",
      "x-device-type": "web"
    },
    ...(agent ? { agent } : {}),
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 3000,
    timeout: 30000,
    pingTimeout: 60000,
    pingInterval: 25000
  });

  if (proxyUrl) console.log("Socket using proxy:", proxyUrl.replace(/:([^@]+)@/, ":***@"));
  else console.log("Socket connecting directly (no proxy)");

  socket.on("connect", () => onConnect(socket));
  socket.on("disconnect", (reason) => onDisconnect(reason));
  socket.on("connect_error", (err) => onError(err));

  return socket;
}

function getSocket() {
  return socket;
}

function emit(event, data) {
  if (socket && socket.connected) {
    socket.emit(event, data);
  } else {
    console.log(`Cannot emit ${event}: socket not connected`);
  }
}

function updateSocketAuth(token) {
  if (socket) {
    socket.auth = { Authorization: token };
    if (socket.io && socket.io.opts && socket.io.opts.extraHeaders) {
      socket.io.opts.extraHeaders.Authorization = token;
    }
  }
}

async function fetchRoomState(roomUid) {
  return new Promise((resolve) => {
    const token = getToken();
    const s = createSocketInstance("https://socket-v2.groic.in", token);

    let finished = false;
    const finish = (res) => {
      if (!finished) {
        finished = true;
        s.disconnect();
        resolve(res);
      }
    };

    s.on("connect", () => {
      s.emit("joinRoom", {
        roomUid,
        username: OWNER_USERNAME,
        name: OWNER_USERNAME,
        imageUrl: "",
        isBot: false
      });
    });

    s.on("roomState", (data) => {
      finish(data);
    });

    s.on("connect_error", () => finish(null));
    setTimeout(() => finish(null), 5000);
  });
}

module.exports = {
  connectSocket,
  getSocket,
  emit,
  updateSocketAuth,
  createSocketInstance,
  fetchRoomState
};
