const { getSocket, emit, createSocketInstance } = require("./socket");
const { SONG, BOT_USERNAME, BOT_NAME, OWNER_USERNAME } = require("../config/constants");
const { translateToEnglish, translateArrayOfTexts } = require("./translate");
const { askAi } = require("./ask");
const { updateRoomKickList, updateRoomAdminList, getRoomDetails } = require("./api");
const { getToken } = require("./auth");
const fs = require("fs");
const path = require("path");

const ALLOWED_ADMINS_FILE = path.join(__dirname, "../allowed_admins.json");

function loadAllowedAdmins() {
  const defaultAdmins = ["_darth_vader_", "dedsec_404", "_its_shru_"];
  if (!fs.existsSync(ALLOWED_ADMINS_FILE)) {
    return defaultAdmins.map(u => u.toLowerCase().trim());
  }
  try {
    const list = JSON.parse(fs.readFileSync(ALLOWED_ADMINS_FILE, "utf8"));
    if (Array.isArray(list)) {
      return list.map(u => u.toLowerCase().trim());
    }
  } catch (err) {
    console.error("Failed to load allowed_admins.json, using defaults", err);
  }
  return defaultAdmins.map(u => u.toLowerCase().trim());
}

function saveAllowedAdmins(adminsList) {
  try {
    fs.writeFileSync(ALLOWED_ADMINS_FILE, JSON.stringify(adminsList, null, 2));
  } catch (err) {
    console.error("Failed to save allowed_admins.json", err);
  }
}

let keepAliveInterval = null;
let knownUsers = new Set();
let initialized = false; // true after first presenceUpdate processed
let chatHistory = []; // Stores rolling { username, message } recent messages
let currentAdmins = [];

function isAllowedAdminUser(username) {
  const normalized = (username || "").toLowerCase().trim();
  if (normalized === OWNER_USERNAME.toLowerCase().trim()) return true;
  const list = loadAllowedAdmins();
  return list.includes(normalized);
}

function emitAddAdminForRoom(roomUid, targetUsername, targetIsAdmin) {
  const token = getToken();
  const socket = createSocketInstance("https://socket-v2.groic.in", token);

  socket.on("connect", () => {
    socket.emit("joinRoom", {
      roomUid,
      username: " ",
      name: " ",
      imageUrl: "",
      isBot: false
    });
  });

  socket.on("presenceUpdate", (data) => {
    const activeAdmins = data?.admins || [];
    const isCurrentlySocketAdmin = activeAdmins.includes(targetUsername);

    if (targetIsAdmin !== isCurrentlySocketAdmin) {
      socket.emit("addAdmin", targetUsername);
    }
    setTimeout(() => {
      socket.disconnect();
    }, 1000);
  });

  socket.on("connect_error", () => {
    socket.disconnect();
  });
}

function emitKickUserForRoom(roomUid, targetUsername, isKick) {
  const token = getToken();
  const socket = createSocketInstance("https://socket-v2.groic.in", token);

  socket.on("connect", () => {
    socket.emit("joinRoom", {
      roomUid,
      username: " ",
      name: " ",
      imageUrl: "",
      isBot: false
    });
  });

  socket.on("presenceUpdate", (data) => {
    socket.emit("kickUser", {
      username: targetUsername,
      addOrRemove: isKick
    });
    setTimeout(() => {
      socket.disconnect();
    }, 1000);
  });

  socket.on("connect_error", () => {
    socket.disconnect();
  });
}

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
  let selfFound = false;

  for (const user of activeUsers) {
    const username = user.username || "";
    const name = user.name || "";
    const imageUrl = user.imageUrl || null;
    const userKey = user._id || `${username}-${name}-${imageUrl}`;

    currentActiveKeys.add(userKey);

    if (isBotUser(user)) {
      selfFound = true;
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

  // Self-healing: If the bot has been initialized but is no longer found in the active users list,
  // it has been disconnected or removed (e.g. due to an old Render instance shutting down). Re-join!
  if (initialized && !selfFound) {
    console.log("[Handlers] Bot is not in active users list. Attempting to rejoin room...");
    const socket = getSocket();
    if (socket && socket.connected) {
      socket.emit("joinRoom", {
        roomUid: roomUid,
        username: BOT_USERNAME,
        name: BOT_NAME,
        imageUrl: "",
        isBot: true
      });
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
    currentAdmins = data?.admins || [];
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
    socket.on("chat", async (data) => {
      const rawMessage = (data?.message || "").trim();
      let message = rawMessage;
      if (message.startsWith("!")) {
        const afterExcl = message.slice(1).trim();
        message = "!" + afterExcl;
      }
      const senderUsername = data?.username || data?.user?.username || "someone";

      // Ignore empty messages
      if (!message) return;

      // ─── !eng command ───────────────────────────────────────────────
      // Usage:
      // 1. "!eng <your text>" -> Translates the typed text
      // 2. "!eng <number>"    -> Translates the last N chat messages in the room (e.g. !eng 5)
      // 3. "!eng" (alone)     -> Translates the last 1 chat message
      const isEngCommand = message.toLowerCase().startsWith("!eng") || message.toLowerCase().startsWith("! eng");

      if (isEngCommand) {
        let arg = "";
        if (message.toLowerCase().startsWith("!eng")) {
          arg = message.slice("!eng".length).trim();
        } else {
          arg = message.slice("! eng".length).trim();
        }

        const isNumber = /^\d+$/.test(arg);

        // A. If empty or a number -> Translate recent chat history
        if (!arg || isNumber) {
          let N = 1;
          if (isNumber) {
            N = parseInt(arg, 10);
            if (N < 1) N = 1;
            if (N > 10) N = 10; // Safe guard: limit to max 10 to avoid massive output or rate limits
          }

          if (chatHistory.length === 0) {
            sendChatMessage(`KD : @${senderUsername} No recent messages to translate yet!`, roomUid);
            return;
          }

          const selectedMessages = chatHistory.slice(-N);
          sendChatMessage(`KD : ⏳ Translating last ${selectedMessages.length} message(s)...`, roomUid);

          // Extract just the raw messages to translate in a batch
          const rawTexts = selectedMessages.map(m => m.message);
          const translatedList = await translateArrayOfTexts(rawTexts);

          if (translatedList && Array.isArray(translatedList)) {
            // Send each translation as a separate message with the format "KD : @username, translation"
            for (let i = 0; i < selectedMessages.length; i++) {
              const original = selectedMessages[i];
              const translation = translatedList[i];
              if (translation) {
                sendChatMessage(`KD : @${original.username}, ${translation}`, roomUid);
              }
            }
          } else {
            sendChatMessage(`KD : Translation Unavailable`, roomUid);
          }
          return;
        }

        // B. If it has plain text -> Translate the typed text directly
        sendChatMessage(`KD : Translating...`, roomUid);
        const translated = await translateToEnglish(arg);

        if (translated) {
          sendChatMessage(`KD : ${translated}`, roomUid);
        } else {
          sendChatMessage(`KD : Translation Unavailable`, roomUid);
        }
      } else if (message.toLowerCase().startsWith("!ask") || message.toLowerCase().startsWith("! ask")) {
        let arg = "";
        if (message.toLowerCase().startsWith("!ask")) {
          arg = message.slice("!ask".length).trim();
        } else {
          arg = message.slice("! ask".length).trim();
        }

        if (!arg) {
          sendChatMessage(`KD : @${senderUsername} Please provide a question or prompt after !ask.`, roomUid);
        } else {
          sendChatMessage(`KD : ⏳ Thinking...`, roomUid);
          const answer = await askAi(arg);
          if (answer) {
            sendChatMessage(`KD : ${answer}`, roomUid);
          } else {
            sendChatMessage(`KD : I couldn't get an answer right now.`, roomUid);
          }
        }
      } else if (message.toLowerCase().startsWith("!kick room ")) {
        if (!isAllowedAdminUser(senderUsername)) {
          sendChatMessage(`KD: You are not allowed to perform this action.`, roomUid);
          return;
        }

        const argsStr = message.slice("!kick room ".length).trim();
        if (!argsStr) return;

        const parts = argsStr.split(/\s+/);
        const targetRoomUid = parts[0];
        const targetUser = parts[1];

        if (!targetRoomUid || !targetUser || targetUser === "someone") return;

        if (targetUser.toLowerCase().trim() === senderUsername.toLowerCase().trim()) return;

        updateRoomKickList(targetRoomUid, targetUser, true).then(res => {
          if (res && !res.error) {
            emitKickUserForRoom(targetRoomUid, targetUser, true);
          }
        }).catch(() => { });
      } else if (message.toLowerCase().startsWith("!kick ")) {
        if (!isAllowedAdminUser(senderUsername)) {
          sendChatMessage(`KD: You are not allowed to perform this action.`, roomUid);
          return;
        }

        const targetUser = message.slice("!kick ".length).trim();
        if (!targetUser) return;

        emit("kickUser", {
          username: targetUser,
          addOrRemove: true
        });
      } else if (message.toLowerCase().startsWith("!unkick room ")) {
        if (!isAllowedAdminUser(senderUsername)) {
          sendChatMessage(`KD: You are not allowed to perform this action.`, roomUid);
          return;
        }

        const argsStr = message.slice("!unkick room ".length).trim();
        if (!argsStr) return;

        const parts = argsStr.split(/\s+/);
        const targetRoomUid = parts[0];
        const targetUser = parts[1];

        if (!targetRoomUid || !targetUser || targetUser === "someone") return;

        updateRoomKickList(targetRoomUid, targetUser, false).then(res => {
          if (res && !res.error) {
            emitKickUserForRoom(targetRoomUid, targetUser, false);
          }
        }).catch(() => { });
      } else if (message.toLowerCase().startsWith("!unkick ")) {
        if (!isAllowedAdminUser(senderUsername)) {
          sendChatMessage(`KD: You are not allowed to perform this action.`, roomUid);
          return;
        }

        const targetUser = message.slice("!unkick ".length).trim();
        if (!targetUser) return;

        emit("kickUser", {
          username: targetUser,
          addOrRemove: false
        });
      } else if (message.toLowerCase().startsWith("!admin room ")) {
        if (!isAllowedAdminUser(senderUsername)) {
          sendChatMessage(`KD: You are not allowed to perform this action.`, roomUid);
          return;
        }

        const argsStr = message.slice("!admin room ".length).trim();
        if (!argsStr) return;

        const parts = argsStr.split(/\s+/);
        const targetRoomUid = parts[0];
        const targetUser = parts[1] ? parts[1] : senderUsername;

        if (!targetRoomUid || !targetUser || targetUser === "someone") return;

        getRoomDetails(targetRoomUid).then(details => {
          if (!details) return;

          const adminsList = details.admins || [];
          if (adminsList.includes(targetUser)) return;

          updateRoomAdminList(targetRoomUid, targetUser, true).then(res => {
            if (res && !res.error) {
              emitAddAdminForRoom(targetRoomUid, targetUser, true);
            }
          });
        }).catch(() => { });
      } else if (message.toLowerCase() === "!admin" || message.toLowerCase().startsWith("!admin ")) {
        if (!isAllowedAdminUser(senderUsername)) {
          sendChatMessage(`KD: You are not allowed to perform this action.`, roomUid);
          return;
        }

        const targetUser = message.toLowerCase() === "!admin"
          ? senderUsername
          : message.slice("!admin ".length).trim();

        if (!targetUser || targetUser === "someone") return;

        getRoomDetails(roomUid).then(details => {
          const adminsList = details?.admins || [];
          if (adminsList.includes(targetUser)) return;

          updateRoomAdminList(roomUid, targetUser, true).then(res => {
            if (res && !res.error) {
              const isCurrentlySocketAdmin = currentAdmins.includes(targetUser);
              if (!isCurrentlySocketAdmin) {
                emit("addAdmin", targetUser);
              }
            }
          });
        }).catch(() => { });
      } else if (message.toLowerCase().startsWith("!unadmin room ")) {
        if (!isAllowedAdminUser(senderUsername)) {
          sendChatMessage(`KD: You are not allowed to perform this action.`, roomUid);
          return;
        }

        const argsStr = message.slice("!unadmin room ".length).trim();
        if (!argsStr) return;

        const parts = argsStr.split(/\s+/);
        const targetRoomUid = parts[0];
        const targetUser = parts[1] ? parts[1] : senderUsername;

        if (!targetRoomUid || !targetUser || targetUser === "someone") return;

        getRoomDetails(targetRoomUid).then(details => {
          if (!details) return;

          const adminsList = details.admins || [];
          if (!adminsList.includes(targetUser)) return;

          updateRoomAdminList(targetRoomUid, targetUser, false).then(res => {
            if (res && !res.error) {
              emitAddAdminForRoom(targetRoomUid, targetUser, false);
            }
          });
        }).catch(() => { });
      } else if (message.toLowerCase() === "!unadmin" || message.toLowerCase().startsWith("!unadmin ")) {
        if (!isAllowedAdminUser(senderUsername)) {
          sendChatMessage(`KD: You are not allowed to perform this action.`, roomUid);
          return;
        }

        const targetUser = message.toLowerCase() === "!unadmin"
          ? senderUsername
          : message.slice("!unadmin ".length).trim();

        if (!targetUser || targetUser === "someone") return;

        getRoomDetails(roomUid).then(details => {
          const adminsList = details?.admins || [];
          if (!adminsList.includes(targetUser)) return;

          updateRoomAdminList(roomUid, targetUser, false).then(res => {
            if (res && !res.error) {
              const isCurrentlySocketAdmin = currentAdmins.includes(targetUser);
              if (isCurrentlySocketAdmin) {
                emit("addAdmin", targetUser);
              }
            }
          });
        }).catch(() => { });
      } else if (message.toLowerCase().startsWith("!allow ") || message.toLowerCase().startsWith("! allow ")) {
        if (senderUsername.toLowerCase().trim() !== OWNER_USERNAME.toLowerCase().trim()) {
          sendChatMessage(`KD: You are not allowed to perform this action.`, roomUid);
          return;
        }

        let targetUser = "";
        if (message.toLowerCase().startsWith("!allow ")) {
          targetUser = message.slice("!allow ".length).trim();
        } else {
          targetUser = message.slice("! allow ".length).trim();
        }

        if (!targetUser) return;
        const normalizedTarget = targetUser.toLowerCase().trim();

        const currentAdminsList = loadAllowedAdmins();
        if (currentAdminsList.includes(normalizedTarget)) return;

        currentAdminsList.push(normalizedTarget);
        saveAllowedAdmins(currentAdminsList);
      } else if (message.toLowerCase().startsWith("!revoke ") || message.toLowerCase().startsWith("! revoke ")) {
        if (senderUsername.toLowerCase().trim() !== OWNER_USERNAME.toLowerCase().trim()) {
          sendChatMessage(`KD: You are not allowed to perform this action.`, roomUid);
          return;
        }

        let targetUser = "";
        if (message.toLowerCase().startsWith("!revoke ")) {
          targetUser = message.slice("!revoke ".length).trim();
        } else {
          targetUser = message.slice("! revoke ".length).trim();
        }

        if (!targetUser) return;
        const normalizedTarget = targetUser.toLowerCase().trim();

        const currentAdminsList = loadAllowedAdmins();
        if (!currentAdminsList.includes(normalizedTarget)) return;

        const updatedAdmins = currentAdminsList.filter(u => u !== normalizedTarget);
        saveAllowedAdmins(updatedAdmins);
      } else if (message.toLowerCase() === "!allowed" || message.toLowerCase() === "! allowed") {
        if (senderUsername.toLowerCase().trim() !== OWNER_USERNAME.toLowerCase().trim()) {
          sendChatMessage(`KD: You are not allowed to perform this action.`, roomUid);
          return;
        }

        const list = loadAllowedAdmins();
        if (list.length === 0) {
          sendChatMessage(`KD: No users have allowed admin permissions except the room owner (@${OWNER_USERNAME}).`, roomUid);
        } else {
          const listStr = list.map(u => `@${u}`).join(", ");
          sendChatMessage(`KD: Allowed users: ${listStr}`, roomUid);
        }
      } else {
        // If it is NOT a command, and NOT the bot's own message, save it to history
        const isBotResponse = message.startsWith("KD :") || senderUsername === " " || senderUsername === BOT_USERNAME;
        const isCommand = message.startsWith("!");

        if (!isBotResponse && !isCommand) {
          chatHistory.push({
            username: senderUsername,
            message: message
          });
          // Limit rolling window size to 10 (highly optimized for memory)
          if (chatHistory.length > 10) {
            chatHistory.shift();
          }
        }
      }
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
