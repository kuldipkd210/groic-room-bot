const { getSocket, emit } = require("./socket");
const { SONG, BOT_USERNAME, BOT_NAME, OWNER_USERNAME } = require("../config/constants");

let keepAliveInterval = null;
let knownUsers = new Set();
let initialized = false; // true after first presenceUpdate processed

function autoPlaySong() {
  setTimeout(() => {
    emit("playSong", SONG);
    // console.log("Auto playSong sent:", SONG.title);
  }, 8000);
}

function sendChatMessage(message, roomUid) {
  emit("sendChat", { message, roomUid });
}

function isBotUser(user) {
  const username = user.username || "";
  const name = user.name || "";
  const imageUrl = user.imageUrl || null;
  return (username === "" && name === "") ||
    (username === BOT_USERNAME && name === BOT_NAME);
}

// ─── Socket-event-based user detection (no HTTP polling) ───────────────────
//
// Groic emits "presenceUpdate" whenever someone joins or leaves a room.
// Data shape: { activeUsers: [...], typing: [...], admins: [...] }
// We listen to this event instead of polling api.groic.in every 10 seconds,
// which was being blocked by Cloudflare when hosted on cloud servers.

function processUserList(activeUsers, roomUid) {
  const currentActiveKeys = new Set();

  for (const user of activeUsers) {
    const username = user.username || "";
    const name = user.name || "";
    const imageUrl = user.imageUrl || null;
    const userKey = user._id || `${username}-${name}-${imageUrl}`;

    currentActiveKeys.add(userKey);

    if (isBotUser(user)) {
      knownUsers.add(userKey);
      continue;
    }

    if (!knownUsers.has(userKey)) {
      knownUsers.add(userKey);
      if (initialized) {
        const cleanUsername = username.trim() || "user";
        sendChatMessage(`KD : Welcome ${cleanUsername}! Enjoy the music 🎶`, roomUid);
      }
    }
  }

  // Remove users who left so they get welcomed again on re-join
  for (const knownKey of knownUsers) {
    if (!currentActiveKeys.has(knownKey)) {
      knownUsers.delete(knownKey);
    }
  }
}

function startUserJoinWatcher(roomUid) {
  const socket = getSocket();
  if (!socket) return;

  // Remove old listener first to prevent duplicates on reconnect
  socket.off("presenceUpdate");

  // presenceUpdate fires whenever room membership changes (join / leave)
  socket.on("presenceUpdate", (data) => {
    const activeUsers = data?.activeUsers || [];
    processUserList(activeUsers, roomUid);
    if (!initialized) initialized = true;
  });
}

function startKeepAlive(roomUid) {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
  }

  keepAliveInterval = setInterval(() => {
    emit("requestSync", { roomUid });
  }, 30000);
}

function stopHandlers() {
  const socket = getSocket();
  if (socket) {
    socket.off("chat");
    socket.off("presenceUpdate");
  }

  knownUsers.clear();
  initialized = false;

  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

function setupChatHandler(roomUid) {
  const socket = getSocket();
  if (socket) {
    socket.off("chat"); // remove old listener before re-adding (prevents duplicates on reconnect)
    socket.on("chat", (data) => {
      // console.log("CHAT RECEIVED:", JSON.stringify(data));
    });
  }
}

module.exports = {
  autoPlaySong,
  sendChatMessage,
  startUserJoinWatcher,
  startKeepAlive,
  stopHandlers,
  setupChatHandler
};
