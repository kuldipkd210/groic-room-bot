const { getSocket, emit } = require("./socket");
const { SONG, BOT_USERNAME, BOT_NAME, OWNER_USERNAME } = require("../config/constants");
const { translateToEnglish, translateArrayOfTexts } = require("./translate");
const { askAi } = require("./ask");

let keepAliveInterval = null;
let knownUsers = new Set();
let initialized = false; // true after first presenceUpdate processed
let chatHistory = []; // Stores rolling { username, message } recent messages

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
      const message = (data?.message || "").trim();
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
