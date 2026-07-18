const { getSocket, emit } = require("./socket");
const { BOT_USERNAME, BOT_NAME, BOT_IMAGE_URL, OWNER_USERNAME } = require("../config/constants");

let keepAliveInterval = null;
let botJoinedOnce = false;

function isBotUser(user) {
  const username = (user.username || "").trim().toLowerCase();
  const name = (user.name || "").trim().toLowerCase();
  const imageUrl = user.imageUrl || "";

  if (username === "") return true;

  const botUsernameConfig = (BOT_USERNAME || "").trim().toLowerCase();
  const ownerUsernameConfig = (OWNER_USERNAME || "").trim().toLowerCase();

  if (botUsernameConfig && username === botUsernameConfig) return true;

  if (username === ownerUsernameConfig) {
    if (botUsernameConfig && botUsernameConfig !== ownerUsernameConfig) {
      return false;
    }
    if (BOT_IMAGE_URL && imageUrl === BOT_IMAGE_URL) {
      return true;
    }
    const botNameConfig = (BOT_NAME || "").trim().toLowerCase();
    if (botNameConfig && name === botNameConfig) {
      return true;
    }
    if (!BOT_IMAGE_URL) {
      return true;
    }
  }

  return false;
}

function processUserList(activeUsers, roomUid) {
  let selfFound = false;

  for (const user of activeUsers) {
    if (isBotUser(user)) {
      selfFound = true;
      break;
    }
  }

  if (selfFound) {
    botJoinedOnce = true;
  }

  // Self-healing: If the bot has been successfully joined once but is no longer found in the active users list,
  // it has been disconnected or removed. Re-join!
  if (botJoinedOnce && !selfFound) {
    console.log("[Handlers] Bot is not in active users list. Attempting to rejoin room...");
    const socket = getSocket();
    if (socket && socket.connected) {
      socket.emit("joinRoom", {
        roomUid: roomUid,
        username: BOT_USERNAME,
        name: BOT_NAME,
        imageUrl: BOT_IMAGE_URL,
        isBot: false
      });
    }
  }
}

function startUserJoinWatcher(roomUid) {
  const socket = getSocket();
  if (!socket) return;

  socket.off("presenceUpdate");

  socket.on("presenceUpdate", (data) => {
    const activeUsers = data?.activeUsers || [];
    processUserList(activeUsers, roomUid);
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
    socket.off("presenceUpdate");
  }

  botJoinedOnce = false;

  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

function setupChatHandler(roomUid) {
  // Commands are completely removed
}

module.exports = {
  startUserJoinWatcher,
  startKeepAlive,
  stopHandlers,
  setupChatHandler
};
