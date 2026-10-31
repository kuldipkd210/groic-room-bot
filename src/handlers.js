const { getSocket, emit, createSocketInstance, fetchRoomState } = require("./socket");
const { BOT_NAME, BOT_IMAGE_URL, OWNER_USERNAME, OWNER_NOTIFY_TRIGGERS, EXPLICIT_CALL_COMMANDS, FRIEND_CALL_COMMANDS, DEFAULT_ALLOWED_ADMINS } = require("../config/constants");
const { askAi } = require("./ask");
const { getRoomDetails, getActivePublicRooms } = require("./api");
const { getToken } = require("./auth");
const { sendOwnerNotification, sendUserNotification } = require("./notifier");
const fs = require("fs");
const path = require("path");
const player = require("./services/player");
const { findPlaylist, formatPlaylistList, addSavedPlaylist, removeSavedPlaylist, syncPlaylistsFromCloud } = require("./services/playlists");
const {
  loadAllowedUsers,
  isAllowedUser,
  addAllowedUser,
  removeAllowedUser,
  syncAllowedUsersFromCloud,
  isRoomLocked,
  setRoomLocked
} = require("./services/allowedUsers");

const ALLOWED_ADMINS_FILE = path.join(__dirname, "../allowed_admins.json");

let allowedAdminsCache = [];

const pendingLockEjections = new Map();

function handleUnauthorizedJoin(username, roomUid) {
  const clean = username.toLowerCase().trim();
  if (pendingLockEjections.has(clean)) return;

  sendChatMessage(
    `@${username}, This Room is locked for now ,\nyou'll be auto kick in 5 sec but dont worry you can join later ,\nsorry for inconvinet`,
    roomUid
  );

  const timer = setTimeout(() => {
    pendingLockEjections.delete(clean);
    if (!isRoomLocked()) return;

    console.log(`[RoomLock] Kicking unauthorized user @${username} in locked room ${roomUid}...`);
    emitKickUserForRoom(roomUid, username, true);

    setTimeout(() => {
      console.log(`[RoomLock] Instantly unkicking @${username} so they can re-enter when unlocked.`);
      emitKickUserForRoom(roomUid, username, false);
    }, 1000);
  }, 5000);

  pendingLockEjections.set(clean, timer);
}



function loadAllowedAdmins() {
  const defaults = DEFAULT_ALLOWED_ADMINS.map(u => u.toLowerCase().trim());
  if (!fs.existsSync(ALLOWED_ADMINS_FILE)) {
    saveAllowedAdmins(defaults);
    return allowedAdminsCache;
  }
  try {
    const list = JSON.parse(fs.readFileSync(ALLOWED_ADMINS_FILE, "utf8"));
    let fromFile = [];
    if (Array.isArray(list)) {
      fromFile = list.map(u => u.toLowerCase().trim());
    }
    const merged = Array.from(new Set([...defaults, ...fromFile]));
    saveAllowedAdmins(merged);
  } catch (err) {
    console.error("Failed to load allowed_admins.json, using defaults", err);
    saveAllowedAdmins(defaults);
  }
  return allowedAdminsCache;
}

function saveAllowedAdmins(adminsList) {
  const defaults = DEFAULT_ALLOWED_ADMINS.map(u => u.toLowerCase().trim());
  const cleanList = (adminsList || []).map(u => u.toLowerCase().trim());
  allowedAdminsCache = Array.from(new Set([...defaults, ...cleanList]));
  try {
    fs.writeFileSync(ALLOWED_ADMINS_FILE, JSON.stringify(allowedAdminsCache, null, 2));
  } catch (err) {
    console.error("Failed to save allowed_admins.json", err);
  }
}

const { getBasket: getPantryBasket, setBasket: setPantryBasket } = require("./services/pantry");

async function syncAllowedAdminsFromCloud() {
  console.log("[Handlers] Syncing allowed admins from Pantry cloud basket: 'allowed_admins'");
  const cloudData = await getPantryBasket("allowed_admins");
  const defaults = DEFAULT_ALLOWED_ADMINS.map(u => u.toLowerCase().trim());

  if (cloudData && Array.isArray(cloudData.admins)) {
    const fromCloud = cloudData.admins.map(u => u.toLowerCase().trim());
    const merged = Array.from(new Set([...defaults, ...fromCloud]));
    saveAllowedAdmins(merged);
    console.log(`[Handlers] Successfully synced ${merged.length} allowed admins from Pantry.`);

    // If cloud was missing any hardcoded admins, update Pantry
    if (merged.length !== fromCloud.length) {
      await setPantryBasket("allowed_admins", { admins: merged });
    }
    return;
  }

  // If Pantry basket is empty, push local admins (including hardcoded) to Pantry
  const local = loadAllowedAdmins();
  console.log(`[Handlers] Pantry basket empty. Pushing ${local.length} local allowed admins to Pantry...`);
  await setPantryBasket("allowed_admins", { admins: local });
}

async function saveAllowedAdminsAndSync(list) {
  saveAllowedAdmins(list);
  console.log("[Handlers] Uploading allowed admins to Pantry cloud basket: 'allowed_admins'");
  await setPantryBasket("allowed_admins", { admins: allowedAdminsCache });
}

let keepAliveInterval = null;
let knownUsers = new Set();
const userWelcomeTimestamps = new Map();
const WELCOME_COOLDOWN_MS = 90 * 1000; // 1 minute 30 seconds
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
const localKickedUsersByRoom = new Map(); // roomUid -> Set of kicked usernames
let activeRoomUid = null;

function isAllowedAdminUser(username, userIsAdmin = false) {
  if (userIsAdmin === true) return true;
  const normalized = (username || "").toLowerCase().trim();
  if (normalized === OWNER_USERNAME.toLowerCase().trim()) return true;
  const list = loadAllowedAdmins();
  return list.includes(normalized);
}

function emitAddAdminForRoom(roomUid, targetUsername, targetIsAdmin) {
  const cleanTarget = (targetUsername || "").replace(/^@/, "").trim();
  if (!cleanTarget) return;

  if (roomUid === activeRoomUid) {
    const mainSocket = getSocket();
    if (mainSocket && mainSocket.connected) {
      mainSocket.emit("addAdmin", cleanTarget);
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
    const isCurrentlySocketAdmin = activeAdmins.includes(cleanTarget);

    if (targetIsAdmin !== isCurrentlySocketAdmin) {
      socket.emit("addAdmin", cleanTarget);
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
  const cleanTarget = (targetUsername || "").replace(/^@/, "").trim();
  if (!cleanTarget) return;

  // Track kicked state locally
  if (!localKickedUsersByRoom.has(roomUid)) {
    localKickedUsersByRoom.set(roomUid, new Set());
  }
  const kickedSet = localKickedUsersByRoom.get(roomUid);
  if (isKick) {
    kickedSet.add(cleanTarget.toLowerCase());
  } else {
    kickedSet.delete(cleanTarget.toLowerCase());
  }

  if (roomUid === activeRoomUid) {
    const mainSocket = getSocket();
    if (mainSocket && mainSocket.connected) {
      mainSocket.emit("kickUser", {
        username: cleanTarget,
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
      username: cleanTarget,
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
        const isAuthorized = cleanUsername.toLowerCase() === OWNER_USERNAME.toLowerCase().trim() ||
          isAllowedAdminUser(cleanUsername) ||
          isAllowedUser(cleanUsername);

        if (isRoomLocked() && !isAuthorized) {
          handleUnauthorizedJoin(cleanUsername, roomUid);
          continue;
        }

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
      if (pendingLockEjections.has(username.toLowerCase())) {
        clearTimeout(pendingLockEjections.get(username.toLowerCase()));
        pendingLockEjections.delete(username.toLowerCase());
      }
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

    if (Array.isArray(data?.kicked)) {
      if (!localKickedUsersByRoom.has(roomUid)) {
        localKickedUsersByRoom.set(roomUid, new Set());
      }
      const set = localKickedUsersByRoom.get(roomUid);
      data.kicked.forEach((u) => {
        const name = typeof u === "string" ? u : (u?.username || u?.name);
        if (name) set.add(name.toLowerCase());
      });
    }

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
    socket.off("playbackUpdate");
  }

  player.stop();

  knownUsers.clear();
  initialized = false;
  botJoinedOnce = false;

  for (const key of Object.keys(userStatuses)) {
    delete userStatuses[key];
  }

  pendingAutoAdmins.clear();

  for (const timer of pendingLockEjections.values()) {
    clearTimeout(timer);
  }
  pendingLockEjections.clear();

  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

function setupChatHandler(roomUid) {
  activeRoomUid = roomUid;
  player.setRoomUid(roomUid);
  player.setChatNotifier(sendChatMessage);

  // Sync allowed admins, playlists, and allowed users from cloud sequentially
  (async () => {
    try {
      await syncAllowedAdminsFromCloud(roomUid);
      await syncPlaylistsFromCloud();
      await syncAllowedUsersFromCloud(roomUid);
    } catch (err) {
      console.error("[Handlers] Error during initial room sync:", err.message);
    }
  })();

  const socket = getSocket();
  if (socket) {
    socket.off("roomState");
    socket.on("roomState", (data) => {
      if (data && Array.isArray(data.kicked)) {
        if (!localKickedUsersByRoom.has(roomUid)) {
          localKickedUsersByRoom.set(roomUid, new Set());
        }
        const set = localKickedUsersByRoom.get(roomUid);
        data.kicked.forEach((u) => {
          const name = typeof u === "string" ? u : (u?.username || u?.name);
          if (name) set.add(name.toLowerCase());
        });
        console.log(`[Handlers] Cached ${set.size} kicked users for room ${roomUid} from roomState`);
      }
    });

    socket.off("playbackUpdate");
    socket.on("playbackUpdate", (data) => {
      player.handlePlaybackUpdate(data);
    });

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
      const senderIsAdmin = Boolean(data?.user?.isAdmin);

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
                sendChatMessage(`@${senderUsername}, I've sent a phone notification to the owner!`, roomUid);
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
                  sendChatMessage(`@${senderUsername}, I've sent a phone notification to ${friend.username}!`, roomUid);
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
          sendChatMessage("No active users in the room.", roomUid);
        } else {
          let reply = "Member Statuses:";
          for (const u of users) {
            const info = getUserStatusObj(u);
            if (info.status === "AFK" && info.reason) {
              reply += `\n• @${u} - AFK 📵 "${info.reason}"`;
            } else if (info.status === "AFK") {
              reply += `\n• @${u} - AFK 📵`;
            } else if (info.reason) {
              reply += `\n• @${u} - AVL 🙋 "${info.reason}"`;
            } else {
              reply += `\n• @${u} - AVL 🙋`;
            }
          }
          sendChatMessage(reply, roomUid);
        }
        return;
      }

      if (lowerMsg.replace(/^!\s*/, "!").replace(/\s+/g, " ").trim() === "!help") {
        const botTitle = (BOT_NAME || "XAIX").toUpperCase();
        const helpMessage = [
          `╭── ✨ ${botTitle} COMMANDS ───╮`,
          "│",
          "│ ✦ Playback ctrl:",
          "│ • !mhelp   • Music Menu",
          "│ • !pick dj • Next DJ",
          "│",
          "│ ✦ Calling & Alerting:",
          "│ • !kd [msg] / !callowner",
          "│ • !ded [msg] / !404",
          "│",
          "│ ✦ Status & AFK:",
          "│ • !afk [reason]",
          "│ • !avl ",
          "│ • !status",
          "│",
          "│ ✦ AI & Utilities:",
          "│ • !xai [prompt] (Witty AI)",
          "│ • !ask [prompt] (Smart AI)",
          "│",
          "│ ✦ Management:",
          "│ • !ahelp (Admin Console)",
          "│ • !ohelp (Owner Console)",
          "╰─────────────────────╯"
        ].join("\n");
        sendChatMessage(helpMessage, roomUid);
        return;
      }

      if (lowerMsg.replace(/^!\s*/, "!").replace(/\s+/g, " ").trim() === "!mhelp") {
        const botTitle = (BOT_NAME || "XAIX").toUpperCase();
        const mhelpMessage = [
          `╭── 🎧 ${botTitle} MUSIC MENU ─────╮`,
          "│",
          "│ ✦ Playback Commands:",
          "│ • !pl list               • show playlists",
          "│ • !pl play [name] • play playlist",
          "│ • !shuffle             • shuffle queue",
          "│ • !stop                 • stop playback",
          "│",
          "│ ✦ Library Management(Admin Only):",
          "│ • !pl save [name] [link] • Add PL",
          "│ • !pl del [name]             • delete PL",
          "╰───────────────────────╯"
        ].join("\n");
        sendChatMessage(mhelpMessage, roomUid);
        return;
      }

      if (lowerMsg.replace(/^!\s*/, "!").replace(/\s+/g, " ").trim() === "!ahelp") {
        if (!isAllowedAdminUser(senderUsername)) {
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
          return;
        }

        const botTitle = (BOT_NAME || "XAIX").toUpperCase();
        const ahelpMessage = [
          `╭── 🛡️ ${botTitle} ADMIN CONSOLE ───╮`,
          "│",
          "│ ✦ Room Moderation:",
          "│ • !admin [user]      • grant admin",
          "│ • !unadmin [user] • revoke admin",
          "│ • !kick [user]         • kick user",
          "│ • !unkick [user]    • unkick user",
          "│ • !klist                  • kicked list",
          "│ • !look [user]        • find user",
          "│",
          "│ ✦ Security & Defense:",
          "│ • !lock            • auto-kick guests",
          "│ • !unlock         • open for all",
          "│ • !auth list        • view authorized",
          "│ • !auth [user]     • authorize user",
          "│ • !unauth [user]  • revoke access",
          "│",
          "│ ✦ Remote Room Control:",
          "│ • !admin room [roomUid] [user]",
          "│ • !unadmin room [roomUid] [user]",
          "│ • !kick room [roomUid] [user]",
          "│ • !unkick room [roomUid] [user]",
          "╰───────────────────────╯"
        ].join("\n");

        sendChatMessage(ahelpMessage, roomUid);
        return;
      }

      if (lowerMsg.replace(/^!\s*/, "!").replace(/\s+/g, " ").trim() === "!ohelp") {
        if (senderUsername.toLowerCase().trim() !== OWNER_USERNAME.toLowerCase().trim()) {
          return;
        }

        const botTitle = (BOT_NAME || "XAIX").toUpperCase();
        const ohelpMessage = [
          `╭── 👑 ${botTitle} OWNER CONSOLE ────╮`,
          "│",
          "│ ✦ Superuser Authority:",
          "│ • !allow [user]  • add allowed admin",
          "│ • !revoke [user] • remove admin",
          "│ • !allowed       • view allowed admins",
          "│",
          "│ ✦ Global Room Sweep:",
          "│ • !kick_all rooms [user]",
          "│ • !unkick_all rooms [user]",
          "╰───────────────────────────────╯"
        ].join("\n");

        sendChatMessage(ohelpMessage, roomUid);
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
          sendChatMessage(`@${senderUsername} you're the DJ! Pick the next song!`, roomUid);
        } else {
          const picked = candidates[Math.floor(Math.random() * candidates.length)];
          sendChatMessage(`@${picked} is chosen to play the next song! Pick a track!`, roomUid);
        }
        return;
      }

      // ─── Music & Spotify Commands ──────────────────────────────────────────
      const normalizedCmd = lowerMsg.replace(/^!\s*/, "!");

      if (normalizedCmd === "!pl list" || normalizedCmd === "!lists" || normalizedCmd === "!playlists" || normalizedCmd === "!playlist list" || normalizedCmd === "!spotify list") {
        sendChatMessage(formatPlaylistList(), roomUid);
        return;
      }

      if (normalizedCmd.startsWith("!pl save ") || normalizedCmd.startsWith("!addlist ") || normalizedCmd.startsWith("!addplaylist ") || normalizedCmd.startsWith("!saveplaylist ")) {
        if (!isAllowedAdminUser(senderUsername, senderIsAdmin)) {
          sendChatMessage(`@${senderUsername} only admins can add saved playlists.`, roomUid);
          return;
        }
        let rest = "";
        if (normalizedCmd.startsWith("!pl save ")) rest = message.slice("!pl save ".length).trim();
        else if (normalizedCmd.startsWith("!addlist ")) rest = message.slice("!addlist ".length).trim();
        else if (normalizedCmd.startsWith("!addplaylist ")) rest = message.slice("!addplaylist ".length).trim();
        else rest = message.slice("!saveplaylist ".length).trim();

        const parts = rest.split(/\s+/);
        if (parts.length < 2) {
          sendChatMessage("Usage: !pl save [name] [link]", roomUid);
          return;
        }
        const shortName = parts[0];
        const playlistUrl = parts[1];

        const { getSpotifyTracks } = require("./services/spotify");
        sendChatMessage(`Fetching details for playlist "${shortName}"...`, roomUid);
        try {
          const info = await getSpotifyTracks(playlistUrl);
          const saved = await addSavedPlaylist(shortName, playlistUrl, senderUsername);
          const syncStatus = saved.cloudSynced ? "Synced to cloud ☁️" : `Saved locally (Cloud sync: ${saved.cloudError || "check logs"})`;
          sendChatMessage(
            `Saved "${saved.name}" (${info.trackCount} tracks)!\n${syncStatus}. Play with: !pl play ${saved.name}`,
            roomUid
          );
        } catch (err) {
          const saved = await addSavedPlaylist(shortName, playlistUrl, senderUsername);
          const syncStatus = saved.cloudSynced ? "Synced to cloud ☁️" : `Saved locally (Cloud sync: ${saved.cloudError || "check logs"})`;
          sendChatMessage(
            `Saved playlist "${saved.name}"!\n${syncStatus}. Play with: !pl play ${saved.name}`,
            roomUid
          );
        }
        return;
      }

      if (normalizedCmd.startsWith("!pl del ") || normalizedCmd.startsWith("!delist ") || normalizedCmd.startsWith("!delplaylist ") || normalizedCmd.startsWith("!deleteplaylist ") || normalizedCmd.startsWith("!removeplaylist ")) {
        if (!isAllowedAdminUser(senderUsername, senderIsAdmin)) {
          sendChatMessage(`@${senderUsername} only admins can delete saved playlists.`, roomUid);
          return;
        }
        let targetName = "";
        if (normalizedCmd.startsWith("!pl del ")) targetName = message.slice("!pl del ".length).trim();
        else if (normalizedCmd.startsWith("!delist ")) targetName = message.slice("!delist ".length).trim();
        else if (normalizedCmd.startsWith("!delplaylist ")) targetName = message.slice("!delplaylist ".length).trim();
        else if (normalizedCmd.startsWith("!deleteplaylist ")) targetName = message.slice("!deleteplaylist ".length).trim();
        else targetName = message.slice("!removeplaylist ".length).trim();

        if (!targetName) {
          sendChatMessage("Usage: !pl del [name]", roomUid);
          return;
        }

        const removed = await removeSavedPlaylist(targetName);
        if (removed) {
          sendChatMessage(`Removed playlist "${removed.name}".`, roomUid);
        } else {
          sendChatMessage(`@${senderUsername} playlist "${targetName}" was not found in saved playlists.`, roomUid);
        }
        return;
      }

      if (
        normalizedCmd === "!pl play" ||
        normalizedCmd.startsWith("!pl play ") ||
        normalizedCmd.startsWith("!load") ||
        normalizedCmd.startsWith("!playlist") ||
        normalizedCmd.startsWith("!spotify")
      ) {
        let arg = "";
        if (normalizedCmd.startsWith("!pl play ")) {
          arg = message.slice("!pl play ".length).trim();
        } else if (normalizedCmd === "!pl play") {
          arg = "";
        } else {
          let prefix = "!load";
          if (normalizedCmd.startsWith("!playlist")) prefix = "!playlist";
          else if (normalizedCmd.startsWith("!spotify")) prefix = "!spotify";
          arg = message.slice(message.toLowerCase().indexOf(prefix) + prefix.length).trim();
        }

        if (!arg || arg.toLowerCase() === "list") {
          sendChatMessage(formatPlaylistList(), roomUid);
          return;
        }

        const found = findPlaylist(arg);
        if (found && found.isUrl) {
          sendChatMessage(
            `@${senderUsername} Direct URLs are disabled. Please save it to playlists.json first:\n> !pl save [name] ${found.url}\nThen play with: !pl play [name]`,
            roomUid
          );
          return;
        }

        if (!found) {
          sendChatMessage(
            `@${senderUsername} playlist "${arg}" is not saved in playlists.json.\n\n${formatPlaylistList()}`,
            roomUid
          );
          return;
        }

        const targetUrl = found.url;
        const targetDisplayName = found.name;

        sendChatMessage(`Shuffling & loading saved playlist "${targetDisplayName}"...`, roomUid);
        try {
          const current = await player.loadSpotifyPlaylist(targetUrl, { autoPlay: true, shuffle: true });
          if (current) {
            sendChatMessage(
              `Shuffled & loaded "${player.playlistName}" (${player.playlist.length} tracks)!\nNow playing: "${current.title}" by ${current.artist}`,
              roomUid
            );
          } else {
            sendChatMessage(`Shuffled & loaded "${player.playlistName}" (${player.playlist.length} tracks).`, roomUid);
          }
        } catch (err) {
          console.error("[Handlers] Spotify playlist error:", err.message);
          sendChatMessage(`Could not load playlist: ${err.message}`, roomUid);
        }
        return;
      }

      if (lowerMsg === "!shuffle" || lowerMsg === "! shuffle") {
        if (!isAllowedAdminUser(senderUsername, senderIsAdmin)) {
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
          return;
        }
        const ok = player.shuffle();
        if (ok) {
          sendChatMessage("Upcoming playlist queue has been shuffled.", roomUid);
        } else {
          sendChatMessage("No active playlist queue to shuffle.", roomUid);
        }
        return;
      }

      if (lowerMsg === "!stop" || lowerMsg === "! stop") {
        if (!isAllowedAdminUser(senderUsername, senderIsAdmin)) {
          sendChatMessage(`@${senderUsername} you do not have admin permissions to stop playback.`, roomUid);
          return;
        }
        player.stop();
        sendChatMessage("Playback stopped and playlist queue cleared.", roomUid);
        return;
      }

      if (message.toLowerCase().startsWith("!ask") || message.toLowerCase().startsWith("! ask") || message.toLowerCase().startsWith("!xai") || message.toLowerCase().startsWith("! xai")) {
        const isXai = message.toLowerCase().startsWith("!xai") || message.toLowerCase().startsWith("! xai");
        const cmdName = isXai ? (message.toLowerCase().startsWith("!xai") ? "!xai" : "! xai") : (message.toLowerCase().startsWith("!ask") ? "!ask" : "! ask");
        const arg = message.slice(cmdName.length).trim();

        if (!arg) {
          sendChatMessage(`Please provide a question or prompt after ${cmdName.trim()}.`, roomUid);
        } else {
          sendChatMessage("Thinking...", roomUid);
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

        const targetUser = message.slice("!kick_all rooms ".length).trim().replace(/^@/, "");
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

        const targetUser = message.slice("!unkick_all rooms ".length).trim().replace(/^@/, "");
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
        if (!isAllowedAdminUser(senderUsername, senderIsAdmin)) {
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
          return;
        }

        const argsStr = message.slice("!kick room ".length).trim();
        if (!argsStr) return;

        const parts = argsStr.split(/\s+/);
        const targetRoomUid = parts[0];
        const targetUser = (parts[1] || "").replace(/^@/, "").trim();

        if (!targetRoomUid || !targetUser || targetUser === "someone") return;

        if (targetUser.toLowerCase().trim() === senderUsername.toLowerCase().trim()) return;

        // Protection: Only room owner can kick allowed admins
        const normalizedTarget = targetUser.toLowerCase().trim();
        if (loadAllowedAdmins().includes(normalizedTarget) && senderUsername.toLowerCase().trim() !== OWNER_USERNAME.toLowerCase().trim()) {
          return;
        }

        emitKickUserForRoom(targetRoomUid, targetUser, true);
      } else if (message.toLowerCase().startsWith("!kick ")) {
        if (!isAllowedAdminUser(senderUsername, senderIsAdmin)) {
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
          return;
        }

        const targetUser = message.slice("!kick ".length).trim().replace(/^@/, "");
        if (!targetUser) return;

        // Protection: Only room owner can kick allowed admins
        const normalizedTarget = targetUser.toLowerCase().trim();
        if (loadAllowedAdmins().includes(normalizedTarget) && senderUsername.toLowerCase().trim() !== OWNER_USERNAME.toLowerCase().trim()) {
          return;
        }

        emitKickUserForRoom(roomUid, targetUser, true);
      } else if (message.toLowerCase().startsWith("!unkick room ")) {
        if (!isAllowedAdminUser(senderUsername, senderIsAdmin)) {
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
          return;
        }

        const argsStr = message.slice("!unkick room ".length).trim();
        if (!argsStr) return;

        const parts = argsStr.split(/\s+/);
        const targetRoomUid = parts[0];
        const targetUser = (parts[1] || "").replace(/^@/, "").trim();

        if (!targetRoomUid || !targetUser || targetUser === "someone") return;

        emitKickUserForRoom(targetRoomUid, targetUser, false);
      } else if (message.toLowerCase().startsWith("!unkick ")) {
        if (!isAllowedAdminUser(senderUsername, senderIsAdmin)) {
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
          return;
        }

        const targetUser = message.slice("!unkick ".length).trim().replace(/^@/, "");
        if (!targetUser) return;

        emitKickUserForRoom(roomUid, targetUser, false);
      } else if (lowerMsg.trim() === "!klist" || lowerMsg.trim() === "! klist") {
        if (!isAllowedAdminUser(senderUsername, senderIsAdmin)) {
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
          return;
        }

        try {
          let kickedUsersSet = null;

          // For current active room, use local cache if populated
          if (roomUid === activeRoomUid && localKickedUsersByRoom.has(roomUid)) {
            const cached = localKickedUsersByRoom.get(roomUid);
            if (cached && cached.size > 0) {
              kickedUsersSet = cached;
            }
          }

          // If local tracking is empty, fetch live roomState
          if (!kickedUsersSet) {
            const state = await fetchRoomState(roomUid);
            if (!state) {
              sendChatMessage(`Room "${roomUid}" not found or inaccessible.`, roomUid);
              return;
            }
            if (Array.isArray(state.kicked)) {
              if (!localKickedUsersByRoom.has(roomUid)) {
                localKickedUsersByRoom.set(roomUid, new Set());
              }
              const set = localKickedUsersByRoom.get(roomUid);
              set.clear();
              state.kicked.forEach((u) => {
                const name = typeof u === "string" ? u : (u?.username || u?.name);
                if (name) set.add(name.toLowerCase());
              });
              kickedUsersSet = set;
            }
          }

          const kicked = kickedUsersSet ? Array.from(kickedUsersSet) : [];
          const header = `╭──  KICKED USERS [${kicked.length}] ──╮`;

          if (kicked.length === 0) {
            sendChatMessage(`${header}\n \n  (No users currently kicked)\n╰─────────────────────╯`, roomUid);
          } else {
            let lines = [
              header,
              " "
            ];
            kicked.slice(0, 25).forEach((u, i) => {
              lines.push(`  ${i + 1}. @${u}`);
            });
            if (kicked.length > 25) {
              lines.push(`  ...and ${kicked.length - 25} more`);
            }
            lines.push(" ");
            lines.push("╰────────────────────╯");
            sendChatMessage(lines.join("\n"), roomUid);
          }
        } catch (err) {
          console.error(`Failed to fetch kick list for ${roomUid}:`, err.message);
          sendChatMessage(`Failed to retrieve kicked list.`, roomUid);
        }
      } else if (lowerMsg === "!lock") {
        if (!isAllowedAdminUser(senderUsername)) {
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
          return;
        }
        setRoomLocked(true, roomUid);
        sendChatMessage("Room is now LOCKED. Only authorized users can enter. Unauthorized joiners will be auto-kicked.", roomUid);
      } else if (lowerMsg === "!unlock") {
        if (!isAllowedAdminUser(senderUsername)) {
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
          return;
        }
        setRoomLocked(false, roomUid);
        for (const timer of pendingLockEjections.values()) {
          clearTimeout(timer);
        }
        pendingLockEjections.clear();
        sendChatMessage("Room is now UNLOCKED. Everyone can now enter!", roomUid);
      } else if (lowerMsg === "!auth list" || lowerMsg === "!auth_list" || lowerMsg === "!a_users" || lowerMsg === "!ausers") {
        if (!isAllowedAdminUser(senderUsername, senderIsAdmin)) {
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
          return;
        }
        const users = loadAllowedUsers();
        const lockStatus = isRoomLocked() ? "LOCKED" : "UNLOCKED";
        let lines = [
          `╭── 🛡️ AUTH USERS [${lockStatus}] ──╮`,
          " "
        ];
        if (users.length === 0) {
          lines.push("  (No authorized users listed)");
        } else {
          users.forEach((u, i) => {
            lines.push(`  ${i + 1}. @${u}`);
          });
        }
        lines.push(" ");
        lines.push(`  Total: ${users.length} authorized`);
        lines.push("╰────────────────────────╯");
        sendChatMessage(lines.join("\n"), roomUid);
      } else if (lowerMsg.startsWith("!auth ") || lowerMsg.startsWith("!a_user ") || lowerMsg.startsWith("!auser ")) {
        if (!isAllowedAdminUser(senderUsername, senderIsAdmin)) {
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
          return;
        }
        const target = message.replace(/^!(auth|a_user|auser)\s+/i, "").trim().replace(/^@/, "");
        if (!target) {
          sendChatMessage("Usage: !auth [user]", roomUid);
          return;
        }
        const added = await addAllowedUser(target, roomUid);
        if (added) {
          sendChatMessage(`Added @${target} to authorized users list.`, roomUid);
        } else {
          sendChatMessage(`@${target} is already in the authorized users list.`, roomUid);
        }
      } else if (lowerMsg.startsWith("!unauth ") || lowerMsg.startsWith("!un_user ") || lowerMsg.startsWith("!uauser ")) {
        if (!isAllowedAdminUser(senderUsername, senderIsAdmin)) {
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
          return;
        }
        const target = message.replace(/^!(unauth|un_user|uauser)\s+/i, "").trim().replace(/^@/, "");
        if (!target) {
          sendChatMessage("Usage: !unauth [user]", roomUid);
          return;
        }
        if (target.toLowerCase() === OWNER_USERNAME.toLowerCase()) {
          sendChatMessage("Cannot remove room owner from authorized users.", roomUid);
          return;
        }
        const removed = await removeAllowedUser(target, roomUid);
        if (removed) {
          sendChatMessage(`Removed @${target} from authorized users list.`, roomUid);
        } else {
          sendChatMessage(`@${target} was not found in authorized users list.`, roomUid);
        }
      } else if (message.toLowerCase().startsWith("!admin room ")) {
        if (!isAllowedAdminUser(senderUsername, senderIsAdmin)) {
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
          return;
        }

        const argsStr = message.slice("!admin room ".length).trim();
        if (!argsStr) return;

        const parts = argsStr.split(/\s+/);
        const targetRoomUid = parts[0];
        const targetUser = parts[1] ? parts[1].replace(/^@/, "").trim() : senderUsername;

        if (!targetRoomUid || !targetUser || targetUser === "someone") return;

        emitAddAdminForRoom(targetRoomUid, targetUser, true);
      } else if (message.toLowerCase() === "!admin" || message.toLowerCase().startsWith("!admin ")) {
        if (!isAllowedAdminUser(senderUsername, senderIsAdmin)) {
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
          return;
        }

        const targetUser = message.toLowerCase() === "!admin"
          ? senderUsername
          : message.slice("!admin ".length).trim().replace(/^@/, "");

        if (!targetUser || targetUser === "someone") return;

        emitAddAdminForRoom(roomUid, targetUser, true);
      } else if (message.toLowerCase().startsWith("!unadmin room ")) {
        if (!isAllowedAdminUser(senderUsername, senderIsAdmin)) {
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
          return;
        }

        const argsStr = message.slice("!unadmin room ".length).trim();
        if (!argsStr) return;

        const parts = argsStr.split(/\s+/);
        const targetRoomUid = parts[0];
        const targetUser = parts[1] ? parts[1].replace(/^@/, "").trim() : senderUsername;

        if (!targetRoomUid || !targetUser || targetUser === "someone") return;

        // Protection: Only room owner can unadmin allowed admins
        const normalizedTarget = targetUser.toLowerCase().trim();
        if (loadAllowedAdmins().includes(normalizedTarget) && senderUsername.toLowerCase().trim() !== OWNER_USERNAME.toLowerCase().trim()) {
          return;
        }

        emitAddAdminForRoom(targetRoomUid, targetUser, false);
      } else if (message.toLowerCase() === "!unadmin" || message.toLowerCase().startsWith("!unadmin ")) {
        if (!isAllowedAdminUser(senderUsername, senderIsAdmin)) {
          sendChatMessage(`@${senderUsername} you do not have admin permissions.`, roomUid);
          return;
        }

        const targetUser = message.toLowerCase() === "!unadmin"
          ? senderUsername
          : message.slice("!unadmin ".length).trim().replace(/^@/, "");

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
        const normalizedTarget = targetUser.replace(/^@/, "").toLowerCase().trim();

        const currentAdminsList = loadAllowedAdmins();
        if (currentAdminsList.includes(normalizedTarget)) {
          sendChatMessage(`@${normalizedTarget} is already an allowed admin.`, roomUid);
          return;
        }

        currentAdminsList.push(normalizedTarget);
        await saveAllowedAdminsAndSync(currentAdminsList, roomUid);
        sendChatMessage(`Added @${normalizedTarget} to allowed admins.`, roomUid);
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
        const normalizedTarget = targetUser.replace(/^@/, "").toLowerCase().trim();

        const currentAdminsList = loadAllowedAdmins();
        if (!currentAdminsList.includes(normalizedTarget)) {
          sendChatMessage(`@${normalizedTarget} is not in the allowed admins list.`, roomUid);
          return;
        }

        const updatedAdmins = currentAdminsList.filter(u => u !== normalizedTarget);
        await saveAllowedAdminsAndSync(updatedAdmins, roomUid);
        sendChatMessage(`Removed @${normalizedTarget} from allowed admins.`, roomUid);
      } else if (message.toLowerCase() === "!allowed" || message.toLowerCase() === "! allowed") {
        if (senderUsername.toLowerCase().trim() !== OWNER_USERNAME.toLowerCase().trim()) {
          sendChatMessage(`@${senderUsername} only the owner can use !allowed.`, roomUid);
          return;
        }

        const list = loadAllowedAdmins();
        let lines = [
          "╭── 👑 ALLOWED ADMINS ──╮",
          "│"
        ];
        if (list.length === 0) {
          lines.push(`│ (No users except @${OWNER_USERNAME})`);
        } else {
          list.forEach((u) => {
            lines.push(`│ • @${u}`);
          });
        }
        lines.push("│");
        lines.push("╰─────────────────────╯");
        sendChatMessage(lines.join("\n"), roomUid);

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
  setupChatHandler,
  isRoomLocked,
  setRoomLocked
};
