const { getSocket, emit, createSocketInstance } = require("./socket");
const { BOT_USERNAME, BOT_NAME, BOT_IMAGE_URL, OWNER_USERNAME, ROOM_DESC, ROOM_NAME, ROOM_GENRE } = require("../config/constants");
const { askAi } = require("./ask");
const { getRoomDetails, getActivePublicRooms } = require("./api");
const { getToken } = require("./auth");
const fs = require("fs");
const path = require("path");

const BOT_USERNAME_NORMALIZED = (BOT_USERNAME && BOT_USERNAME.trim()) 
  ? BOT_USERNAME.trim().toLowerCase() 
  : OWNER_USERNAME.trim().toLowerCase();


function encodeUUID(uuid) {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) return "";

  return hex.split("").map(char => {
    const num = parseInt(char, 16);
    return num.toString(2).padStart(4, "0")
      .replace(/0/g, "\u200C")
      .replace(/1/g, "\u200D");
  }).join("");
}

function decodeUUID(encodedStr) {
  if (!encodedStr) return null;
  // Match any zero-width characters (including U+200C, U+200D, and U+200B)
  const match = encodedStr.match(/[\u200C\u200D\u200B]+/g);
  if (!match) return null;

  // Combine all matches and strip out zero-width spaces (U+200B)
  const combined = match.join("").replace(/\u200B/g, "");
  if (combined.length < 128) return null;

  // Slice the last 128 characters representing the most recent UUID
  const bits = combined.substring(combined.length - 128);
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    const chunk = bits.substring(i, i + 4);
    const binary = chunk.replace(/\u200C/g, "0").replace(/\u200D/g, "1");
    hex += parseInt(binary, 2).toString(16);
  }

  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`;
}

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
  const envBlobId = process.env.ALLOWED_ADMINS_BLOB_ID;
  if (envBlobId) {
    console.log(`[Handlers] Syncing allowed admins using env blob ID: ${envBlobId}`);
    try {
      const axios = require("axios");
      const res = await axios.get(`https://jsonblob.com/api/jsonBlob/${envBlobId}`, { timeout: 10000, proxy: false });
      if (Array.isArray(res.data)) {
        const fromCloud = res.data.map(u => u.toLowerCase().trim());
        saveAllowedAdmins(fromCloud);
        console.log("[Handlers] Successfully synced allowed admins from cloud:", fromCloud);
      }
    } catch (err) {
      console.error(`[Handlers] Failed to read env JSON Blob ${envBlobId}:`, err.message);
    }
    return;
  }

  try {
    const details = await getRoomDetails(roomUid);
    if (!details) return;

    const desc = details.roomDesc || "";
    let blobId = decodeUUID(desc);

    const countryVal = (details.roomCountry || "").trim();
    const countryIsUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(countryVal);

    if (!blobId && countryIsUuid) {
      blobId = countryVal;
      console.log(`[Handlers] Migrating legacy JSON Blob ID from roomCountry: ${blobId}`);
    }

    const axios = require("axios");
    const VALID_GENRES = ["pop", "popular", "rock", "hip hop", "dance", "jazz", "classical", "metal", "country", "r&b", "electronic", "acoustic", "indie"];
    const cleanGenres = (ROOM_GENRE || []).filter(g => typeof g === "string" && VALID_GENRES.includes(g.toLowerCase().trim()));
    if (cleanGenres.length === 0) cleanGenres.push("Popular");

    if (blobId) {
      console.log(`[Handlers] Found JSON Blob ID: ${blobId}`);
      try {
        const res = await axios.get(`https://jsonblob.com/api/jsonBlob/${blobId}`, { timeout: 10000, proxy: false });
        if (Array.isArray(res.data)) {
          const fromCloud = res.data.map(u => u.toLowerCase().trim());
          saveAllowedAdmins(fromCloud);
          console.log("[Handlers] Successfully synced allowed admins from cloud:", fromCloud);

          const baseDesc = desc.replace(/[\u200C\u200D\u200B]+/g, "").trim();
          const targetDesc = ROOM_DESC || baseDesc;
          const newDesc = `${targetDesc}\n\n${encodeUUID(blobId)}`.trim();

          const needsDescUpdate = (desc !== newDesc);
          const needsNameUpdate = (details.roomName !== ROOM_NAME);
          const needsGenreUpdate = JSON.stringify(details.roomGenre) !== JSON.stringify(cleanGenres);
          const needsCountryRestore = (details.roomCountry !== "IN");

          if (needsDescUpdate || needsNameUpdate || needsGenreUpdate || needsCountryRestore) {
            const payload = {
              roomName: ROOM_NAME,
              roomDesc: newDesc,
              roomGenre: cleanGenres,
              roomCountry: "IN",
              maxParticipants: details.maxParticipants || 50
            };
            const { getGroicHeaders } = require("./api");
            await axios.patch(`https://api.groic.in/api/room/${roomUid}`, payload, {
              headers: getGroicHeaders(),
              timeout: 10000
            });
            console.log("[Handlers] Updated room details, description with invisible JSON Blob ID, and restored country database.");
          }
          return;
        }
      } catch (getErr) {
        console.error(`[Handlers] Failed to read JSON Blob ${blobId}:`, getErr.message);
      }
    }

    // If no UUID found, create a new JSON Blob
    console.log("[Handlers] Creating a new cloud JSON Blob for allowed admins...");
    const localList = loadAllowedAdmins();
    const createRes = await axios.post("https://jsonblob.com/api/jsonBlob", localList, {
      headers: { "Content-Type": "application/json" },
      timeout: 10000,
      proxy: false
    });

    const location = createRes.headers["location"] || "";
    const newBlobId = location.split("/").pop();
    if (!newBlobId) {
      throw new Error("Failed to retrieve new JSON Blob ID from location header");
    }

    console.log(`[Handlers] New JSON Blob ID created: ${newBlobId}`);

    const baseDesc = desc.replace(/[\u200C\u200D\u200B]+/g, "").trim();
    const targetDesc = ROOM_DESC || baseDesc;
    const newDesc = `${targetDesc}\n\n${encodeUUID(newBlobId)}`.trim();

    const payload = {
      roomName: ROOM_NAME,
      roomDesc: newDesc,
      roomGenre: cleanGenres,
      roomCountry: "IN",
      maxParticipants: details.maxParticipants || 50
    };

    const { getGroicHeaders } = require("./api");
    await axios.patch(`https://api.groic.in/api/room/${roomUid}`, payload, {
      headers: getGroicHeaders(),
      timeout: 10000
    });
    console.log("[Handlers] Registered JSON Blob ID in room description invisibly.");
  } catch (err) {
    if (err.response) {
      console.error("[Handlers] Cloud sync failed response status:", err.response.status);
      console.error("[Handlers] Cloud sync failed response data:", JSON.stringify(err.response.data));
    } else {
      console.error("[Handlers] Cloud sync failed:", err.message);
    }
  }
}

async function saveAllowedAdminsAndSync(list, roomUid) {
  saveAllowedAdmins(list);
  const envBlobId = process.env.ALLOWED_ADMINS_BLOB_ID;
  if (envBlobId) {
    console.log(`[Handlers] Syncing allowed admins to env blob ID: ${envBlobId}`);
    try {
      const axios = require("axios");
      await axios.put(`https://jsonblob.com/api/jsonBlob/${envBlobId}`, list, {
        headers: { "Content-Type": "application/json" },
        timeout: 10000,
        proxy: false
      });
      console.log(`[Handlers] Successfully updated cloud JSON Blob ${envBlobId} with allowed admins.`);
    } catch (err) {
      console.error("[Handlers] Failed to update cloud allowed admins:", err.message);
    }
    return;
  }

  try {
    const details = await getRoomDetails(roomUid);
    if (!details) return;

    const desc = details.roomDesc || "";
    let blobId = decodeUUID(desc);

    const countryVal = (details.roomCountry || "").trim();
    const countryIsUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(countryVal);

    if (!blobId && countryIsUuid) {
      blobId = countryVal;
    }

    if (!blobId) {
      console.log("[Handlers] No JSON Blob found in roomDesc during save. Triggering sync to create one...");
      await syncAllowedAdminsFromCloud(roomUid);
      return;
    }

    const axios = require("axios");
    await axios.put(`https://jsonblob.com/api/jsonBlob/${blobId}`, list, {
      headers: { "Content-Type": "application/json" },
      timeout: 10000,
      proxy: false
    });
    console.log(`[Handlers] Successfully updated cloud JSON Blob ${blobId} with allowed admins.`);
  } catch (err) {
    console.error("[Handlers] Failed to update cloud allowed admins:", err.message);
  }
}

let keepAliveInterval = null;
let knownUsers = new Set();
let initialized = false; // true after first presenceUpdate processed
let botJoinedOnce = false; // true after bot is found in active users at least once
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
  const formatted = message.replace(/^KD\s*:\s*/i, "");
  emit("sendChat", { message: formatted, roomUid });
}

function isBotUser(user) {
  const username = (user.username || "").trim().toLowerCase();
  const name = (user.name || "").trim().toLowerCase();
  const imageUrl = user.imageUrl || "";

  // Fallback for empty username (old behavior)
  if (username === "") return true;

  const botUsernameConfig = (BOT_USERNAME || "").trim().toLowerCase();
  const ownerUsernameConfig = (OWNER_USERNAME || "").trim().toLowerCase();

  // If configured bot username matches the user
  if (botUsernameConfig && username === botUsernameConfig) return true;

  // If username matches the owner (since bot runs under owner's account)
  if (username === ownerUsernameConfig) {
    // If the bot is configured to run under a separate account, the owner is NOT the bot
    if (botUsernameConfig && botUsernameConfig !== ownerUsernameConfig) {
      return false;
    }
    // Distinguish bot by image URL or name prefix
    if (BOT_IMAGE_URL && imageUrl === BOT_IMAGE_URL) {
      return true;
    }
    const botNameConfig = (BOT_NAME || "").trim().toLowerCase();
    if (botNameConfig && name === botNameConfig) {
      return true;
    }
    // Fallback if no custom BOT_IMAGE_URL config is provided
    if (!BOT_IMAGE_URL) {
      return true;
    }
  }

  return false;
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
  botJoinedOnce = false;

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
      console.log("=== RECEIVED CHAT EVENT ===");
      console.log(JSON.stringify(data, null, 2));
      console.log("===========================");
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

      if (message.toLowerCase().startsWith("!ask") || message.toLowerCase().startsWith("! ask")) {
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


        getActivePublicRooms().then(async (rooms) => {
          if (!rooms || rooms.length === 0) {
            return;
          }

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

              emitKickUserForRoom(currentRoomUid, targetUser, true);
              kickedCount++;
            } catch (err) {
              console.error(`Failed to kick ${targetUser} in room ${currentRoomUid}:`, err.message);
            }
            if (i < rooms.length - 1) {
              await new Promise(r => setTimeout(r, 1000));
            }
          }
        }).catch((err) => {
          console.error(`Failed to retrieve active public rooms:`, err.message);
        });
      } else if (message.toLowerCase().startsWith("!unkick_all rooms ")) {
        if (senderUsername.toLowerCase().trim() !== OWNER_USERNAME.toLowerCase().trim()) {
          return;
        }

        const targetUser = message.slice("!unkick_all rooms ".length).trim();
        if (!targetUser) return;

        getActivePublicRooms().then(async (rooms) => {
          if (!rooms || rooms.length === 0) {
            return;
          }

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

              emitKickUserForRoom(currentRoomUid, targetUser, false);
              unkickedCount++;
            } catch (err) {
              console.error(`Failed to unkick ${targetUser} in room ${currentRoomUid}:`, err.message);
            }
            if (i < rooms.length - 1) {
              await new Promise(r => setTimeout(r, 1000));
            }
          }
        }).catch((err) => {
          console.error(`Failed to retrieve active public rooms:`, err.message);
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
          return;
        }

        emitKickUserForRoom(targetRoomUid, targetUser, true);
      } else if (message.toLowerCase().startsWith("!kick ")) {
        if (!isAllowedAdminUser(senderUsername)) {
          return;
        }

        const targetUser = message.slice("!kick ".length).trim();
        if (!targetUser) return;

        // Protection: Only room owner can kick allowed admins
        const normalizedTarget = targetUser.toLowerCase().trim();
        if (loadAllowedAdmins().includes(normalizedTarget) && senderUsername.toLowerCase().trim() !== OWNER_USERNAME.toLowerCase().trim()) {
          return;
        }

        emitKickUserForRoom(roomUid, targetUser, true);
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

        emitKickUserForRoom(targetRoomUid, targetUser, false);
      } else if (message.toLowerCase().startsWith("!unkick ")) {
        if (!isAllowedAdminUser(senderUsername)) {
          return;
        }

        const targetUser = message.slice("!unkick ".length).trim();
        if (!targetUser) return;

        emitKickUserForRoom(roomUid, targetUser, false);
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

        emitAddAdminForRoom(targetRoomUid, targetUser, true);
      } else if (message.toLowerCase() === "!admin" || message.toLowerCase().startsWith("!admin ")) {
        if (!isAllowedAdminUser(senderUsername)) {
          return;
        }

        const targetUser = message.toLowerCase() === "!admin"
          ? senderUsername
          : message.slice("!admin ".length).trim();

        if (!targetUser || targetUser === "someone") return;

        emitAddAdminForRoom(roomUid, targetUser, true);
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
          return;
        }

        emitAddAdminForRoom(targetRoomUid, targetUser, false);
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
          return;
        }

        emitAddAdminForRoom(roomUid, targetUser, false);
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
          emitAdminControlForRoom(roomUid, true);
        } else {
          emitAdminControlForRoom(targetRoomUid, true);
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
          emitAdminControlForRoom(roomUid, false);
        } else {
          emitAdminControlForRoom(targetRoomUid, false);
        }
      } else {
        // If it is NOT a command, and NOT the bot's own message, save it to history
        const isBotResponse = message.startsWith("KD :") || 
                              message.startsWith("KD:") || 
                              senderUsername === " " || 
                              senderUsername === BOT_USERNAME || 
                              senderUsername.toLowerCase().trim() === BOT_USERNAME_NORMALIZED;
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
