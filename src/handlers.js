const { getSocket, emit, createSocketInstance } = require("./socket");
const { BOT_USERNAME, BOT_NAME, OWNER_USERNAME } = require("../config/constants");
const { translateToEnglish, translateArrayOfTexts } = require("./translate");
const { askAi } = require("./ask");
const { updateRoomKickList, updateRoomAdminList, getRoomDetails, updateRoomAdminControl, getActivePublicRooms } = require("./api");
const { getToken } = require("./auth");
const fs = require("fs");
const path = require("path");

const ALLOWED_ADMINS_FILE = path.join(__dirname, "../allowed_admins.json");

let allowedAdminsCache = [];

const WELCOME_MESSAGES = [
  "KD : Hey @{username}! Welcome to the room! Grab your headphones and vibe with us! 🎧✨",
  "KD : Welcome @{username}! Let's listen to some sweet tunes and chat together! 🎶💃",
  "KD : Look who joined! Welcome @{username}! Feel the music, drop a message, and enjoy! 🎵❤️",
  "KD : Yay, @{username} is here! Welcome to our musical cozy corner! Let the good vibes roll! 🎸🌟",
  "KD : Hello @{username}! Welcome to the ultimate music & chat lounge! What's your jam today? 🎙️🎉",
  "KD : Welcome @{username}! We've got the beats, we've got the chat, all we needed was you! 🔊🥳",
  "KD : Hey @{username}, welcome aboard! Let the music play and the conversations flow! 🎹✨",
  "KD : Welcome @{username}! Step in, tune in, and let's make some memories together! 🎷🌈",
  "KD : Woohoo! @{username} has entered the chat! Let the bass drop and the fun begin! 🎛️🚀",
  "KD : Welcome @{username}! Grab a drink 🥤, request a song, and join the party! 🥳✨",
  "KD : Look who's here! Welcome @{username}! Time to tune in to the good times! 📻🎉",
  "KD : Hey @{username}! Your arrival just increased the vibe level by 100%! 📈🔥",
  "KD : Welcome @{username}! Ready to rock, roll, and chat? Let's make this day awesome! 🎸💬",
  "KD : Boom! 💥 @{username} is in the house! Turn up the volume and enjoy the session! 🎵🎧",
  "KD : Welcome @{username}! A new friend has joined our musical family! Introduce yourself! 🥰🎶",
  "KD : Hey there @{username}! The playlist just got a little brighter because of you! 🌟🎶",
  "KD : Welcome @{username}! Let the melody guide your soul and the chat keep you smiling! 💫🎹",
  "KD : Welcome @{username}! You are officially invited to vibe, chat, and relax with us! 🍹🎶",
  "KD : Welcome @{username}! Turn the music UP, forget the worries, and chat away! 🔊💃",
  "KD : Hey @{username}! The beat goes on, and we're so glad you're here to share it! 🥁❤️",
  "KD : Warm welcome to @{username}! Tell us, what kind of music makes you wanna dance? 🕺🎶",
  "KD : Ahoy @{username}! Welcome to our harbor of smooth tracks and great chats! 🚢🎵",
  "KD : Hello @{username}! You've just stepped into the happiest music room on Groic! Enjoy! 🌈🎶",
  "KD : Welcome @{username}! Ready to lose yourself in the music and find friends in the chat? 🗺️✨",
  "KD : Hey @{username}! Life is better when we listen together. Welcome to the vibe tribe! 🎧🌾"
];

function loadAllowedAdmins() {
  if (allowedAdminsCache.length === 0) {
    const defaultAdmins = ["_darth_vader_", "dedsec_404", "_its_shru_"];
    if (!fs.existsSync(ALLOWED_ADMINS_FILE)) {
      allowedAdminsCache = defaultAdmins.map(u => u.toLowerCase().trim());
    } else {
      try {
        const list = JSON.parse(fs.readFileSync(ALLOWED_ADMINS_FILE, "utf8"));
        if (Array.isArray(list)) {
          allowedAdminsCache = list.map(u => u.toLowerCase().trim());
        }
      } catch (err) {
        console.error("Failed to load allowed_admins.json, using defaults", err);
        allowedAdminsCache = defaultAdmins.map(u => u.toLowerCase().trim());
      }
    }
  }
  return allowedAdminsCache;
}

function saveAllowedAdmins(adminsList) {
  allowedAdminsCache = adminsList.map(u => u.toLowerCase().trim());
  try {
    fs.writeFileSync(ALLOWED_ADMINS_FILE, JSON.stringify(allowedAdminsCache, null, 2));
  } catch (err) {
    console.error("Failed to save allowed_admins.json", err);
  }
}

async function syncAllowedAdminsFromCloud(roomUid) {
  try {
    const details = await getRoomDetails(roomUid);
    if (!details) return;

    const countryVal = (details.roomCountry || "").trim();
    // A JSON Blob ID is a UUID (36 chars: 8-4-4-4-12 hex chars)
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(countryVal);
    const axios = require("axios");

    // Clean up any old jsonblob: or co-owner: tags from genres if present
    const cleanGenres = (details.roomGenre || []).filter(g => !g.startsWith("jsonblob:") && !g.startsWith("co-owner:"));

    if (isUuid) {
      const blobId = countryVal;
      console.log(`[Handlers] Found JSON Blob ID in roomCountry: ${blobId}`);
      try {
        const res = await axios.get(`https://jsonblob.com/api/jsonBlob/${blobId}`, { timeout: 10000 });
        if (Array.isArray(res.data)) {
          const fromCloud = res.data.map(u => u.toLowerCase().trim());
          saveAllowedAdmins(fromCloud);
          console.log("[Handlers] Successfully synced allowed admins from cloud:", fromCloud);

          // If we had old genres to clean, do a patch now
          if (details.roomGenre && details.roomGenre.length !== cleanGenres.length) {
            const payload = {
              roomOwner: details.roomOwner,
              username: details.username,
              roomName: details.roomName,
              roomDesc: details.roomDesc,
              roomGenre: cleanGenres,
              roomCountry: blobId,
              maxParticipants: details.maxParticipants,
              isPublicRoom: details.isPublicRoom
            };
            const { getGroicHeaders } = require("./api");
            await axios.patch(`https://api.groic.in/api/room/${roomUid}`, payload, {
              headers: getGroicHeaders(),
              timeout: 10000
            });
            console.log("[Handlers] Cleaned up legacy tags from room genres.");
          }
          return;
        }
      } catch (getErr) {
        console.error(`[Handlers] Failed to read JSON Blob ${blobId}:`, getErr.message);
      }
    }

    // If no UUID found in roomCountry, create a new JSON Blob
    console.log("[Handlers] Creating a new cloud JSON Blob for allowed admins...");
    const localList = loadAllowedAdmins();
    const createRes = await axios.post("https://jsonblob.com/api/jsonBlob", localList, {
      headers: { "Content-Type": "application/json" },
      timeout: 10000
    });

    const location = createRes.headers["location"] || "";
    const newBlobId = location.split("/").pop();
    if (!newBlobId) {
      throw new Error("Failed to retrieve new JSON Blob ID from location header");
    }

    console.log(`[Handlers] New JSON Blob ID created: ${newBlobId}`);

    // Register the new blob ID in roomCountry and clear genres tags
    const payload = {
      roomOwner: details.roomOwner,
      username: details.username,
      roomName: details.roomName,
      roomDesc: details.roomDesc,
      roomGenre: cleanGenres,
      roomCountry: newBlobId,
      maxParticipants: details.maxParticipants,
      isPublicRoom: details.isPublicRoom
    };

    const { getGroicHeaders } = require("./api");
    await axios.patch(`https://api.groic.in/api/room/${roomUid}`, payload, {
      headers: getGroicHeaders(),
      timeout: 10000
    });
    console.log("[Handlers] Registered JSON Blob ID in roomCountry on Groic.");
  } catch (err) {
    console.error("[Handlers] Cloud sync failed:", err.message);
  }
}

async function saveAllowedAdminsAndSync(list, roomUid) {
  saveAllowedAdmins(list);
  try {
    const details = await getRoomDetails(roomUid);
    if (!details) return;

    const countryVal = (details.roomCountry || "").trim();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(countryVal);
    const axios = require("axios");

    let blobId = isUuid ? countryVal : null;

    if (!blobId) {
      console.log("[Handlers] No JSON Blob found in roomCountry during save. Triggering sync to create one...");
      await syncAllowedAdminsFromCloud(roomUid);
      return;
    }

    await axios.put(`https://jsonblob.com/api/jsonBlob/${blobId}`, list, {
      headers: { "Content-Type": "application/json" },
      timeout: 10000
    });
    console.log(`[Handlers] Successfully updated cloud JSON Blob ${blobId} with allowed admins.`);
  } catch (err) {
    console.error("[Handlers] Failed to update cloud allowed admins:", err.message);
  }
}

let keepAliveInterval = null;
let knownUsers = new Set();
let initialized = false; // true after first presenceUpdate processed
let chatHistory = []; // Stores rolling { username, message } recent messages
let currentAdmins = [];
const userStatuses = {};

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

function emitAdminControlForRoom(roomUid, enableAdminControl) {
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

  socket.on("presenceUpdate", () => {
    socket.emit("adminControl", enableAdminControl);
    setTimeout(() => {
      socket.disconnect();
    }, 1000);
  });

  socket.on("connect_error", () => {
    socket.disconnect();
  });
}

function sendChatMessage(message, roomUid) {
  emit("sendChat", { message, roomUid });
}

function isBotUser(user) {
  const username = (user.username || "").trim();
  const name = (user.name || "").trim();
  return username === "" ||
    (username === BOT_USERNAME.trim() && name === BOT_NAME.trim());
}

// ─── Socket-event-based user detection (no HTTP polling) ───────────────────
//
// Groic emits "presenceUpdate" whenever someone joins or leaves a room.
// Data shape: { activeUsers: [...], typing: [...], admins: [...] }
// We listen to this event instead of polling api.groic.in every 10 seconds,
// which was being blocked by Cloudflare when hosted on cloud servers.

function processUserList(activeUsers, roomUid) {
  const currentActiveKeys = new Set();
  const activeUsernames = new Set();
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

    const cleanUsername = username.trim() || "user";
    activeUsernames.add(cleanUsername);

    // Initialize default status to AVL if not already set
    if (!userStatuses[cleanUsername]) {
      userStatuses[cleanUsername] = "AVL";
    }

    if (!knownUsers.has(userKey)) {
      knownUsers.add(userKey);
      if (initialized) {
        if (cleanUsername.toLowerCase() === OWNER_USERNAME.toLowerCase().trim()) {
          sendChatMessage(`KD : Welcome back @${cleanUsername}!`, roomUid);
        } else {
          const randomIndex = Math.floor(Math.random() * WELCOME_MESSAGES.length);
          const template = WELCOME_MESSAGES[randomIndex];
          const message = template.replace("{username}", cleanUsername);
          sendChatMessage(message, roomUid);
        }
      }
    }
  }

  // Remove users who left so they get welcomed again on re-join
  for (const knownKey of knownUsers) {
    if (!currentActiveKeys.has(knownKey)) {
      knownUsers.delete(knownKey);
    }
  }

  // Clean up statuses of users who left
  for (const username of Object.keys(userStatuses)) {
    if (!activeUsernames.has(username)) {
      delete userStatuses[username];
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

  for (const key of Object.keys(userStatuses)) {
    delete userStatuses[key];
  }

  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

function setupChatHandler(roomUid) {
  // Sync allowed admins from cloud
  syncAllowedAdminsFromCloud(roomUid);

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

      const lowerMsg = message.toLowerCase();

      // ─── User Status Commands ───────────────────────────────────────
      if (lowerMsg === "!afk") {
        userStatuses[senderUsername] = "AFK";
        sendChatMessage(`KD: @${senderUsername} is now AFK 📵\n(Use !status to view all user statuses)`, roomUid);
        return;
      } else if (lowerMsg === "!slp") {
        userStatuses[senderUsername] = "SLP";
        sendChatMessage(`KD: @${senderUsername} is now SLP 💤\n(Use !status to view all user statuses)`, roomUid);
        return;
      } else if (lowerMsg === "!avl") {
        userStatuses[senderUsername] = "AVL";
        sendChatMessage(`KD: @${senderUsername} is now AVL 🙋\n(Use !status to view all user statuses)`, roomUid);
        return;
      } else if (lowerMsg.startsWith("!status")) {
        const parts = message.trim().split(/\s+/);
        if (parts.length === 1) {
          const users = Object.keys(userStatuses);
          if (users.length === 0) {
            sendChatMessage(`KD: No active users in the room.`, roomUid);
          } else {
            let reply = "KD: User Statuses:";
            for (const u of users) {
              const status = userStatuses[u];
              let emoji = "🙋";
              if (status === "AFK") emoji = "📵";
              if (status === "SLP") emoji = "💤";
              reply += `\n@${u} - ${status} ${emoji}`;
            }
            sendChatMessage(reply, roomUid);
          }
        } else {
          let target = parts.slice(1).join(" ").trim();
          if (target.startsWith("@")) {
            target = target.substring(1);
          }
          const targetLower = target.toLowerCase();
          const keys = Object.keys(userStatuses);
          let matchedUser = keys.find(
            (u) => u.toLowerCase() === targetLower
          );
          if (!matchedUser) {
            matchedUser = keys.find(
              (u) => u.toLowerCase().startsWith(targetLower)
            );
          }
          if (matchedUser) {
            const status = userStatuses[matchedUser];
            let emoji = "🙋";
            if (status === "AFK") emoji = "📵";
            if (status === "SLP") emoji = "💤";
            sendChatMessage(`KD: @${matchedUser} - ${status} ${emoji}`, roomUid);
          } else {
            sendChatMessage(`KD: @${target} is not in the room.`, roomUid);
          }
        }
        return;
      }

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
      } else if (message.toLowerCase().startsWith("!kick_all rooms ")) {
        if (senderUsername.toLowerCase().trim() !== OWNER_USERNAME.toLowerCase().trim()) {
          return;
        }

        const targetUser = message.slice("!kick_all rooms ".length).trim();
        if (!targetUser) return;

        sendChatMessage(`KD: Finding all public rooms to kick @${targetUser}...`, roomUid);

        getActivePublicRooms().then(async (rooms) => {
          if (!rooms || rooms.length === 0) {
            sendChatMessage(`KD: No active public rooms found.`, roomUid);
            return;
          }
          sendChatMessage(`KD: Found ${rooms.length} active public rooms. Kicking @${targetUser}...`, roomUid);

          let kickedCount = 0;
          for (let i = 0; i < rooms.length; i++) {
            const currentRoom = rooms[i];
            const currentRoomUid = currentRoom.roomUid;

            try {
              const details = await getRoomDetails(currentRoomUid);
              if (!details) continue;

              const kickedList = details.kicked || [];
              if (kickedList.includes(targetUser)) {
                continue;
              }

              const res = await updateRoomKickList(currentRoomUid, targetUser, true);
              if (res && !res.error) {
                emitKickUserForRoom(currentRoomUid, targetUser, true);
                kickedCount++;
              }
            } catch (err) {
              console.error(`Failed to kick ${targetUser} in room ${currentRoomUid}:`, err.message);
            }
            if (i < rooms.length - 1) {
              await new Promise(r => setTimeout(r, 1000));
            }
          }
          sendChatMessage(`KD: Finished processing all rooms. Kicked @${targetUser} from ${kickedCount} new rooms.`, roomUid);
        }).catch((err) => {
          sendChatMessage(`KD: Failed to retrieve active public rooms: ${err.message}`, roomUid);
        });
      } else if (message.toLowerCase().startsWith("!unkick_all rooms ")) {
        if (senderUsername.toLowerCase().trim() !== OWNER_USERNAME.toLowerCase().trim()) {
          return;
        }

        const targetUser = message.slice("!unkick_all rooms ".length).trim();
        if (!targetUser) return;

        sendChatMessage(`KD: Finding all public rooms to unkick @${targetUser}...`, roomUid);

        getActivePublicRooms().then(async (rooms) => {
          if (!rooms || rooms.length === 0) {
            sendChatMessage(`KD: No active public rooms found.`, roomUid);
            return;
          }
          sendChatMessage(`KD: Found ${rooms.length} active public rooms. Unkicking @${targetUser}...`, roomUid);

          let unkickedCount = 0;
          for (let i = 0; i < rooms.length; i++) {
            const currentRoom = rooms[i];
            const currentRoomUid = currentRoom.roomUid;

            try {
              const details = await getRoomDetails(currentRoomUid);
              if (!details) continue;

              const kickedList = details.kicked || [];
              if (!kickedList.includes(targetUser)) {
                continue;
              }

              const res = await updateRoomKickList(currentRoomUid, targetUser, false);
              if (res && !res.error) {
                emitKickUserForRoom(currentRoomUid, targetUser, false);
                unkickedCount++;
              }
            } catch (err) {
              console.error(`Failed to unkick ${targetUser} in room ${currentRoomUid}:`, err.message);
            }
            if (i < rooms.length - 1) {
              await new Promise(r => setTimeout(r, 1000));
            }
          }
          sendChatMessage(`KD: Finished processing all rooms. Unkicked @${targetUser} from ${unkickedCount} rooms.`, roomUid);
        }).catch((err) => {
          sendChatMessage(`KD: Failed to retrieve active public rooms: ${err.message}`, roomUid);
        });
      } else if (message.toLowerCase().startsWith("!kick room ")) {
        if (!isAllowedAdminUser(senderUsername)) {
          return;
        }

        const argsStr = message.slice("!kick room ".length).trim();
        if (!argsStr) return;

        const parts = argsStr.split(/\s+/);
        const targetRoomUid = parts[0];
        const targetUser = parts[1];

        if (!targetRoomUid || !targetUser || targetUser === "someone") return;

        if (targetUser.toLowerCase().trim() === senderUsername.toLowerCase().trim()) return;

        // Protection: Only room owner can kick allowed admins
        const normalizedTarget = targetUser.toLowerCase().trim();
        if (loadAllowedAdmins().includes(normalizedTarget) && senderUsername.toLowerCase().trim() !== OWNER_USERNAME.toLowerCase().trim()) {
          sendChatMessage(`KD: Cant perform this on co-owners`, roomUid);
          return;
        }

        updateRoomKickList(targetRoomUid, targetUser, true).then(res => {
          if (res && !res.error) {
            emitKickUserForRoom(targetRoomUid, targetUser, true);
          }
        }).catch(() => { });
      } else if (message.toLowerCase().startsWith("!kick ")) {
        if (!isAllowedAdminUser(senderUsername)) {
          return;
        }

        const targetUser = message.slice("!kick ".length).trim();
        if (!targetUser) return;

        // Protection: Only room owner can kick allowed admins
        const normalizedTarget = targetUser.toLowerCase().trim();
        if (loadAllowedAdmins().includes(normalizedTarget) && senderUsername.toLowerCase().trim() !== OWNER_USERNAME.toLowerCase().trim()) {
          sendChatMessage(`KD: Cant perform this on co-owner of the room`, roomUid);
          return;
        }

        emit("kickUser", {
          username: targetUser,
          addOrRemove: true
        });
      } else if (message.toLowerCase().startsWith("!unkick room ")) {
        if (!isAllowedAdminUser(senderUsername)) {
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
          return;
        }

        const argsStr = message.slice("!unadmin room ".length).trim();
        if (!argsStr) return;

        const parts = argsStr.split(/\s+/);
        const targetRoomUid = parts[0];
        const targetUser = parts[1] ? parts[1] : senderUsername;

        if (!targetRoomUid || !targetUser || targetUser === "someone") return;

        // Protection: Only room owner can unadmin allowed admins
        const normalizedTarget = targetUser.toLowerCase().trim();
        if (loadAllowedAdmins().includes(normalizedTarget) && senderUsername.toLowerCase().trim() !== OWNER_USERNAME.toLowerCase().trim()) {
          sendChatMessage(`KD: Cant perform this on co-owner of the room`, roomUid);
          return;
        }

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
          return;
        }

        const targetUser = message.toLowerCase() === "!unadmin"
          ? senderUsername
          : message.slice("!unadmin ".length).trim();

        if (!targetUser || targetUser === "someone") return;

        // Protection: Only room owner can unadmin allowed admins
        const normalizedTarget = targetUser.toLowerCase().trim();
        if (loadAllowedAdmins().includes(normalizedTarget) && senderUsername.toLowerCase().trim() !== OWNER_USERNAME.toLowerCase().trim()) {
          sendChatMessage(`KD: Cant perform this on co-owner of the room`, roomUid);
          return;
        }

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
        saveAllowedAdminsAndSync(currentAdminsList, roomUid);
      } else if (message.toLowerCase().startsWith("!revoke ") || message.toLowerCase().startsWith("! revoke ")) {
        if (senderUsername.toLowerCase().trim() !== OWNER_USERNAME.toLowerCase().trim()) {
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
        saveAllowedAdminsAndSync(updatedAdmins, roomUid);
      } else if (message.toLowerCase() === "!allowed" || message.toLowerCase() === "! allowed") {
        if (senderUsername.toLowerCase().trim() !== OWNER_USERNAME.toLowerCase().trim()) {
          return;
        }

        const list = loadAllowedAdmins();
        if (list.length === 0) {
          sendChatMessage(`KD: No users have allowed admin permissions except the room owner (@${OWNER_USERNAME}).`, roomUid);
        } else {
          const listStr = list.map(u => `@${u}`).join(", ");
          sendChatMessage(`KD: Allowed users: ${listStr}`, roomUid);
        }
      } else if (lowerMsg === "!enable admin" || lowerMsg.startsWith("!enable admin ")) {
        if (!isAllowedAdminUser(senderUsername)) {
          return;
        }
        let targetRoomUid = roomUid;
        const parts = message.split(/\s+/);
        if (parts.length > 2) {
          targetRoomUid = parts.slice(2).join(" ").trim();
        }

        if (targetRoomUid === roomUid) {
          emit("adminControl", true);
          updateRoomAdminControl(roomUid, true).catch(() => { });
        } else {
          emitAdminControlForRoom(targetRoomUid, true);
          updateRoomAdminControl(targetRoomUid, true).catch(() => { });
        }
      } else if (lowerMsg === "!disable admin" || lowerMsg.startsWith("!disable admin ")) {
        if (!isAllowedAdminUser(senderUsername)) {
          return;
        }
        let targetRoomUid = roomUid;
        const parts = message.split(/\s+/);
        if (parts.length > 2) {
          targetRoomUid = parts.slice(2).join(" ").trim();
        }

        if (targetRoomUid === roomUid) {
          emit("adminControl", false);
          updateRoomAdminControl(roomUid, false).catch(() => { });
        } else {
          emitAdminControlForRoom(targetRoomUid, false);
          updateRoomAdminControl(targetRoomUid, false).catch(() => { });
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
  sendChatMessage,
  startUserJoinWatcher,
  startKeepAlive,
  stopHandlers,
  setupChatHandler
};
