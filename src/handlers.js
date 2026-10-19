const { getSocket, emit, createSocketInstance } = require("./socket");
const { BOT_NAME, BOT_IMAGE_URL, OWNER_USERNAME, ROOM_DESC, ROOM_NAME, ROOM_GENRE, OWNER_NOTIFY_TRIGGERS, EXPLICIT_CALL_COMMANDS, FRIEND_CALL_COMMANDS } = require("../config/constants");
const { askAi } = require("./ask");
const { getRoomDetails, getActivePublicRooms } = require("./api");
const { getToken } = require("./auth");
const { sendOwnerNotification, sendUserNotification } = require("./notifier");
const fs = require("fs");
const path = require("path");

const ALLOWED_ADMINS_FILE = path.join(__dirname, "../allowed_admins.json");

let allowedAdminsCache = [];



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

function getUserStatusObj(username) {
  const val = userStatuses[username];
  if (!val) {
    return { status: "AVL", reason: "" };
  }
  if (typeof val === "string") {
    return { status: val, reason: "" };
  }
  return {
    status: val.status || "AVL",
    reason: val.reason || ""
  };
}

const pendingAutoAdmins = new Set();
let activeRoomUid = null;

function isAllowedAdminUser(username) {
  const normalized = (username || "").toLowerCase().trim();
  if (normalized === OWNER_USERNAME.toLowerCase().trim()) return true;
  const list = loadAllowedAdmins();
  return list.includes(normalized);
}

function emitAddAdminForRoom(roomUid, targetUsername, targetIsAdmin) {
  if (roomUid === activeRoomUid) {
    const mainSocket = getSocket();
    if (mainSocket && mainSocket.connected) {
      mainSocket.emit("addAdmin", targetUsername);
      return;
    }
  }

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
  if (roomUid === activeRoomUid) {
    const mainSocket = getSocket();
    if (mainSocket && mainSocket.connected) {
      mainSocket.emit("kickUser", {
        username: targetUsername,
        addOrRemove: isKick
      });
      return;
    }
  }

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

function sendChatMessage(message, roomUid) {
  const formatted = message.replace(/^KD\s*:\s*/i, "");
  emit("sendChat", { message: formatted, roomUid });
}

function splitMessage(text, maxLength = 900) {
  if (!text || text.length <= maxLength) return [text];
  const paragraphs = text.split("\n\n");
  const chunks = [];
  let currentChunk = "";

  for (const para of paragraphs) {
    if ((currentChunk ? currentChunk + "\n\n" + para : para).length <= maxLength) {
      currentChunk = currentChunk ? currentChunk + "\n\n" + para : para;
    } else {
      if (currentChunk) chunks.push(currentChunk);
      if (para.length > maxLength) {
        const lines = para.split("\n");
        currentChunk = "";
        for (const line of lines) {
          if ((currentChunk ? currentChunk + "\n" + line : line).length <= maxLength) {
            currentChunk = currentChunk ? currentChunk + "\n" + line : line;
          } else {
            if (currentChunk) chunks.push(currentChunk);
            currentChunk = line;
          }
        }
      } else {
        currentChunk = para;
      }
    }
  }
  if (currentChunk) chunks.push(currentChunk);
  return chunks;
}


function isBotUsername(username) {
  if (!username) return true;
  const clean = username.trim().toLowerCase();
  if (clean === "" || clean === "xaix" || clean === "xai") return true;
  const botNameConfig = (BOT_NAME || "").trim().toLowerCase();
  if (botNameConfig && clean === botNameConfig) return true;
  return false;
}

function isBotUser(user) {
  const username = (user.username || "").trim().toLowerCase();
  const name = (user.name || "").trim().toLowerCase();
  const imageUrl = user.imageUrl || "";

  if (username === "") return true;

  if (isBotUsername(username) || isBotUsername(name)) {
    return true;
  }

  const ownerUsernameConfig = (OWNER_USERNAME || "").trim().toLowerCase();

  if (username === ownerUsernameConfig) {
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
    if (isBotUsername(cleanUsername)) {
      continue;
    }
    activeUsernames.add(cleanUsername);

    // Initialize default status to AVL if not already set
    if (!userStatuses[cleanUsername]) {
      userStatuses[cleanUsername] = {
        status: "AVL",
        reason: ""
      };
    }

    // Instant auto-admin: Whenever an allowed_admin joins/is in the room, grant them admin status instantly
    const isAllowed = isAllowedAdminUser(cleanUsername);
    if (isAllowed && cleanUsername.toLowerCase() !== OWNER_USERNAME.toLowerCase().trim()) {
      const isAlreadyAdmin = (currentAdmins || []).some(a => {
        if (typeof a === "string") return a.toLowerCase() === cleanUsername.toLowerCase();
        return a?.username && a.username.toLowerCase() === cleanUsername.toLowerCase();
      });

      if (isAlreadyAdmin) {
        pendingAutoAdmins.delete(cleanUsername.toLowerCase());
      } else if (!pendingAutoAdmins.has(cleanUsername.toLowerCase())) {
        pendingAutoAdmins.add(cleanUsername.toLowerCase());
        const mainSocket = getSocket();
        if (mainSocket && mainSocket.connected) {
          console.log(`[AutoAdmin] Automatically granting admin to allowed admin @${cleanUsername}`);
          mainSocket.emit("addAdmin", cleanUsername);
        }
      }
    }

    if (!knownUsers.has(userKey)) {
      knownUsers.add(userKey);
      if (initialized) {
        if (cleanUsername.toLowerCase() === OWNER_USERNAME.toLowerCase().trim()) {
          sendChatMessage(`Welcome back @${cleanUsername}! 👑`, roomUid);
        } else if (isAllowedAdminUser(cleanUsername)) {
          sendChatMessage(`Welcome back @${cleanUsername}! 🛡️`, roomUid);
        } else {
          sendChatMessage(`Welcome @${cleanUsername}! Enjoy the tunes 🎶`, roomUid);
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
      pendingAutoAdmins.delete(username.toLowerCase());
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

  pendingAutoAdmins.clear();

  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

function setupChatHandler(roomUid) {
  activeRoomUid = roomUid;
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

      // ─── Owner Notification Triggers ──────────────────────────────────
      if (!isBotUsername(senderUsername)) {
        const isExplicitCmd = (EXPLICIT_CALL_COMMANDS || []).some(
          (cmd) => lowerMsg === cmd.toLowerCase() || lowerMsg.startsWith(cmd.toLowerCase() + " ")
        );
        const isMentionTrigger = (OWNER_NOTIFY_TRIGGERS || []).some(
          (trigger) => lowerMsg.includes(trigger.toLowerCase())
        );

        if (isExplicitCmd || isMentionTrigger) {
          sendOwnerNotification({
            senderUsername,
            messageText: rawMessage,
            roomUid,
            isExplicitCall: isExplicitCmd
          })
            .then((sent) => {
              if (sent && isExplicitCmd) {
                sendChatMessage(`@${senderUsername}, I've sent a phone notification to the owner! 🔔`, roomUid);
              }
            })
            .catch((err) => console.error("Notification trigger error:", err));
        }

        // ─── Friend Notification Triggers ─────────────────────────────────
        for (const friend of (FRIEND_CALL_COMMANDS || [])) {
          const isFriendCmd = (friend.commands || []).some(
            (cmd) => lowerMsg === cmd.toLowerCase() || lowerMsg.startsWith(cmd.toLowerCase() + " ")
          );

          if (isFriendCmd) {
            sendUserNotification({
              topic: friend.topic,
              targetName: friend.username,
              senderUsername,
              messageText: rawMessage,
              roomUid,
              isExplicitCall: true
            })
              .then((sent) => {
                if (sent) {
                  sendChatMessage(`@${senderUsername}, I've sent a phone notification to ${friend.username}! 🔔`, roomUid);
                }
              })
              .catch((err) => console.error("Friend notification trigger error:", err));
          }
        }
      }

      // ─── User Status Commands ───────────────────────────────────────
      if (lowerMsg === "!afk" || lowerMsg.startsWith("!afk ") || lowerMsg.startsWith("! afk")) {
        if (!isBotUsername(senderUsername)) {
          let reason = "";
          if (lowerMsg.startsWith("!afk ")) {
            reason = message.slice("!afk ".length).trim();
          } else if (lowerMsg.startsWith("! afk ")) {
            reason = message.slice("! afk ".length).trim();
          } else if (lowerMsg.startsWith("! afk")) {
            reason = message.slice("! afk".length).trim();
          }

          reason = reason.replace(/^["']|["']$/g, "").trim();

          userStatuses[senderUsername] = {
            status: "AFK",
            reason: reason
          };

          if (reason) {
            sendChatMessage(`@${senderUsername} is now AFK 📵 "${reason}"\n(Use !status to view all user statuses)`, roomUid);
          } else {
            sendChatMessage(`@${senderUsername} is now AFK 📵\n(Use !status to view all user statuses)`, roomUid);
          }
        }
        return;
      } else if (lowerMsg === "!avl" || lowerMsg.startsWith("!avl ") || lowerMsg.startsWith("! avl")) {
        if (!isBotUsername(senderUsername)) {
          let reason = "";
          if (lowerMsg.startsWith("!avl ")) {
            reason = message.slice("!avl ".length).trim();
          } else if (lowerMsg.startsWith("! avl ")) {
            reason = message.slice("! avl ".length).trim();
          }
          reason = reason.replace(/^["']|["']$/g, "").trim();

          userStatuses[senderUsername] = {
            status: "AVL",
            reason: reason
          };
          if (reason) {
            sendChatMessage(`@${senderUsername} is now AVL 🙋 "${reason}"\n(Use !status to view all user statuses)`, roomUid);
          } else {
            sendChatMessage(`@${senderUsername} is now AVL 🙋\n(Use !status to view all user statuses)`, roomUid);
          }
        }
        return;
      } else if (lowerMsg === "!status" || lowerMsg.startsWith("!status") || lowerMsg.startsWith("! status")) {
        const users = Object.keys(userStatuses).filter(u => !isBotUsername(u));
        if (users.length === 0) {
          sendChatMessage(`No active users in the room.`, roomUid);
        } else {
          let reply = "Member Statuses:";
          for (const u of users) {
            const info = getUserStatusObj(u);
            if (info.status === "AFK" && info.reason) {
              reply += `\n@${u} - AFK 📵 "${info.reason}"`;
            } else if (info.status === "AFK") {
              reply += `\n@${u} - AFK 📵`;
            } else if (info.reason) {
              reply += `\n@${u} - AVL 🙋 "${info.reason}"`;
            } else {
              reply += `\n@${u} - AVL 🙋`;
            }
          }
          sendChatMessage(reply, roomUid);
        }
        return;
      }

      if (lowerMsg.replace(/^!\s*/, "!").replace(/\s+/g, " ").trim() === "!help") {
        const helpMessage = [
          "Available Public Commands:",
          "",
          "1. Set your status:",
          "   > !afk [reason] — Away from keyboard 📵",
          "   > !avl — Available 🙋",
          "",
          "2. !status — View all members' status with reasons.",
          "",
          "3. !pick dj — Randomly pick a member to play the next song.",
          "",
          "4. !xai <prompt> — Witty, funny & sarcastic AI companion.",
          "",
          "5. !ask <prompt> — Professional & informative AI answer.",
          "",
          "6. !callowner / !kd — Send phone alert to the room owner.",
          "",
          "7. !ded / !404 — Send phone alert to dedsec_404."
        ].join("\n");
        sendChatMessage(helpMessage, roomUid);
        return;
      }

      if (lowerMsg.replace(/^!\s*/, "!").replace(/\s+/g, " ").trim() === "!ahelp") {
        if (!isAllowedAdminUser(senderUsername)) {
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
          return;
        }

        const ahelpMessage = [
          "🛡️ Admin Commands:",
          "• !look <user> — Find which public room a user is in and who is with them.",
          "• !admin [user] — Grant admin to yourself or target user in this room.",
          "• !unadmin [user] — Revoke admin from yourself or target user in this room.",
          "• !admin room <roomUid> [user] — Grant admin in a remote room.",
          "• !unadmin room <roomUid> [user] — Revoke admin in a remote room.",
          "• !kick <user> — Kick a user from this room.",
          "• !unkick <user> — Unkick a user in this room.",
          "• !kick room <roomUid> <user> — Kick a user in a remote room.",
          "• !unkick room <roomUid> <user> — Unkick a user in a remote room.",
          "",
          "👑 Owner-Only Commands:",
          "• !allow <user> — Add a user to allowed admins list.",
          "• !revoke <user> — Remove a user from allowed admins list.",
          "• !allowed — View all allowed admin users.",
          "• !kick_all rooms <user> — Sweep & kick user across ALL public rooms.",
          "• !unkick_all rooms <user> — Sweep & unkick user across ALL public rooms."
        ].join("\n");

        sendChatMessage(ahelpMessage, roomUid);
        return;
      }

      if (lowerMsg.startsWith("!look") || lowerMsg.startsWith("! look")) {
        if (!isAllowedAdminUser(senderUsername)) {
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
          return;
        }

        const cmdName = lowerMsg.startsWith("!look") ? "!look" : "! look";
        let targetUser = message.slice(cmdName.length).trim();

        if (targetUser.startsWith("@")) {
          targetUser = targetUser.slice(1).trim();
        }

        if (!targetUser) {
          sendChatMessage(`Please specify a username. Usage: !look <username>`, roomUid);
          return;
        }

        const targetLower = targetUser.toLowerCase();

        try {
          const rooms = await getActivePublicRooms();
          if (!rooms || rooms.length === 0) {
            sendChatMessage(`Could not find any active public rooms.`, roomUid);
            return;
          }

          let foundRooms = [];

          for (const room of rooms) {
            const activeUsers = room.activeUsers || [];
            const isOnline = activeUsers.some(u =>
              (u.username && u.username.toLowerCase() === targetLower) ||
              (u.name && u.name.toLowerCase() === targetLower)
            );

            if (isOnline) {
              const roomName = room.roomName || "Unnamed Room";
              const roomUidVal = room.roomUid || room._id || "";
              const ownerName = room.username || room.ownerUid || "Unknown";

              const otherUsers = activeUsers.filter(u =>
                (!u.username || u.username.toLowerCase() !== targetLower) &&
                (!u.name || u.name.toLowerCase() !== targetLower)
              );

              const otherUsersList = otherUsers
                .map(u => u.username ? `@${u.username}` : (u.name || "Unknown"));

              foundRooms.push({
                roomName,
                roomUidVal,
                ownerName,
                otherUsersList
              });
            }
          }

          if (foundRooms.length > 0) {
            for (const item of foundRooms) {
              const roomDisplay = item.roomUidVal ? `"${item.roomName}" (${item.roomUidVal})` : `"${item.roomName}"`;
              if (item.otherUsersList.length > 0) {
                const userListStr = item.otherUsersList.join("\n");
                sendChatMessage(`@${targetUser} is in room ${roomDisplay} owned by @${item.ownerName} with \n${userListStr}`, roomUid);
              } else {
                sendChatMessage(`@${targetUser} is in room ${roomDisplay} owned by @${item.ownerName}`, roomUid);
              }
            }
          } else {
            sendChatMessage(`@${targetUser} is not online in any public room.`, roomUid);
          }
        } catch (err) {
          console.error("[!look] Error searching public rooms:", err.message);
          sendChatMessage(`Error searching public rooms for @${targetUser}.`, roomUid);
        }
        return;
      }

      if (lowerMsg.replace(/^!\s*/, "!").replace(/\s+/g, " ").trim() === "!pick dj") {
        const usersArray = Object.keys(userStatuses).filter(u => !isBotUsername(u));
        const candidates = usersArray.filter(u => u.toLowerCase() !== senderUsername.toLowerCase());

        if (candidates.length === 0) {
          sendChatMessage(`🎵 @${senderUsername} you're the DJ! Pick the next song! 🎧`, roomUid);
        } else {
          const picked = candidates[Math.floor(Math.random() * candidates.length)];
          sendChatMessage(`🎵 @${picked} is chosen to play the next song! 🎧 Pick a track! 🎶`, roomUid);
        }
        return;
      }

      if (message.toLowerCase().startsWith("!ask") || message.toLowerCase().startsWith("! ask") || message.toLowerCase().startsWith("!xai") || message.toLowerCase().startsWith("! xai")) {
        const isXai = message.toLowerCase().startsWith("!xai") || message.toLowerCase().startsWith("! xai");
        const cmdName = isXai ? (message.toLowerCase().startsWith("!xai") ? "!xai" : "! xai") : (message.toLowerCase().startsWith("!ask") ? "!ask" : "! ask");
        const arg = message.slice(cmdName.length).trim();

        if (!arg) {
          sendChatMessage(`Please provide a question or prompt after ${cmdName.trim()}.`, roomUid);
        } else {
          sendChatMessage(`⏳ Thinking...`, roomUid);
          const answer = await askAi(arg, isXai ? "xai" : "ask", roomUid, senderUsername);
          if (answer) {
            sendChatMessage(answer, roomUid);
          } else {
            sendChatMessage(`I couldn't get an answer right now.`, roomUid);
          }
        }
      } else if (message.toLowerCase().startsWith("!kick_all rooms ")) {
        if (senderUsername.toLowerCase().trim() !== OWNER_USERNAME.toLowerCase().trim()) {
          sendChatMessage(`@${senderUsername} only the owner can use !kick_all rooms.`, roomUid);
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
          sendChatMessage(`@${senderUsername} only the owner can use !unkick_all rooms.`, roomUid);
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
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
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
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
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
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
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
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
          return;
        }

        const targetUser = message.slice("!unkick ".length).trim();
        if (!targetUser) return;

        emitKickUserForRoom(roomUid, targetUser, false);
      } else if (message.toLowerCase().startsWith("!admin room ")) {
        if (!isAllowedAdminUser(senderUsername)) {
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
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
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
          return;
        }

        const targetUser = message.toLowerCase() === "!admin"
          ? senderUsername
          : message.slice("!admin ".length).trim();

        if (!targetUser || targetUser === "someone") return;

        emitAddAdminForRoom(roomUid, targetUser, true);
      } else if (message.toLowerCase().startsWith("!unadmin room ")) {
        if (!isAllowedAdminUser(senderUsername)) {
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
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
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
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
          sendChatMessage(`@${senderUsername} only the owner can use !allow.`, roomUid);
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
          sendChatMessage(`@${senderUsername} only the owner can use !revoke.`, roomUid);
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
          sendChatMessage(`@${senderUsername} only the owner can use !allowed.`, roomUid);
          return;
        }

        const list = loadAllowedAdmins();
        if (list.length === 0) {
          sendChatMessage(`No users have allowed admin permissions except the room owner (@${OWNER_USERNAME}).`, roomUid);
        } else {
          const listStr = list.map(u => `@${u}`).join(", ");
          sendChatMessage(`Allowed users: ${listStr}`, roomUid);
        }

      } else {
        // If it is NOT a command, and NOT the bot's own message, save it to history
        const isBotResponse = isBotUsername(senderUsername) ||
          senderUsername === " " ||
          senderUsername.toLowerCase().trim() === OWNER_USERNAME.toLowerCase().trim();
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
