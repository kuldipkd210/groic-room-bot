const { io } = require("socket.io-client");
const { getToken } = require("./auth");
const { HttpsProxyAgent } = require("https-proxy-agent");

let socket = null;

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
    transports: ["websocket", "polling"], // prefer websocket to avoid polling→upgrade blip
    auth: {
      Authorization: getToken()
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
    // console.log("Socket auth token updated for future reconnections");
  }
}

module.exports = {
  connectSocket,
  getSocket,
  emit,
  updateSocketAuth
};
