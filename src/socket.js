const { io } = require("socket.io-client");
const { getToken } = require("./auth");

let socket = null;

function connectSocket(url, onConnect, onDisconnect, onError) {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  socket = io(url, {
    transports: ["polling", "websocket"], // polling first so Cloudflare doesn't block WS upgrade
    auth: {
      Authorization: getToken()
    },
    extraHeaders: {
      "Origin": "https://groic.in",
      "Referer": "https://groic.in/",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
    },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 3000,
    timeout: 30000
  });

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
