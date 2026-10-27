const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { OWNER_USERNAME, ROOM_NAME, ROOM_DESC } = require("../../config/constants");
const { getRoomDetails, getGroicHeaders } = require("../api");

const ALLOWED_USERS_FILE = path.join(__dirname, "../../allowed_users.json");
const LOCK_FILE = path.join(__dirname, "../../room_lock.json");

let allowedUsersCache = null;
let roomLocked = false;

// Initialize lock state from lock file if present
try {
  if (fs.existsSync(LOCK_FILE)) {
    const data = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    roomLocked = Boolean(data?.locked);
  }
} catch (err) {
  roomLocked = false;
}

function getProxyAgent() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
  return proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
}

function encodeUUID(uuid) {
  if (!uuid) return "";
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) return "";

  return hex.split("").map(char => {
    const num = parseInt(char, 16);
    return num.toString(2).padStart(4, "0")
      .replace(/0/g, "\u200C")
      .replace(/1/g, "\u200D");
  }).join("");
}

function decodeUUIDs(encodedStr) {
  if (!encodedStr) return [];
  const match = encodedStr.match(/[\u200C\u200D\u200B]+/g);
  if (!match) return [];
  const combined = match.join("").replace(/\u200B/g, "");
  const uuids = [];
  for (let offset = 0; offset + 128 <= combined.length; offset += 128) {
    const bits = combined.substring(offset, offset + 128);
    let hex = "";
    for (let i = 0; i < bits.length; i += 4) {
      const chunk = bits.substring(i, i + 4);
      const binary = chunk.replace(/\u200C/g, "0").replace(/\u200D/g, "1");
      hex += parseInt(binary, 2).toString(16);
    }
    uuids.push(`${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`);
  }
  return uuids;
}

/**
 * Loads allowed users list from local allowed_users.json.
 */
function loadAllowedUsers() {
  if (allowedUsersCache) return allowedUsersCache;

  if (!fs.existsSync(ALLOWED_USERS_FILE)) {
    const defaults = [OWNER_USERNAME.toLowerCase().trim()];
    try {
      fs.writeFileSync(ALLOWED_USERS_FILE, JSON.stringify(defaults, null, 2), "utf8");
    } catch (err) {
      console.error("[AllowedUsers] Failed to write allowed_users.json:", err.message);
    }
    allowedUsersCache = defaults;
    return allowedUsersCache;
  }

  try {
    const raw = fs.readFileSync(ALLOWED_USERS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      allowedUsersCache = parsed.map(u => String(u).toLowerCase().trim()).filter(Boolean);
    } else if (parsed && Array.isArray(parsed.users)) {
      allowedUsersCache = parsed.users.map(u => String(u).toLowerCase().trim()).filter(Boolean);
    } else {
      allowedUsersCache = [OWNER_USERNAME.toLowerCase().trim()];
    }
  } catch (err) {
    console.error("[AllowedUsers] Failed to read allowed_users.json:", err.message);
    allowedUsersCache = [OWNER_USERNAME.toLowerCase().trim()];
  }

  return allowedUsersCache;
}

/**
 * Saves allowed users list to local file.
 */
function saveAllowedUsersLocally(list) {
  allowedUsersCache = Array.from(new Set(list.map(u => String(u).toLowerCase().trim()).filter(Boolean)));
  try {
    fs.writeFileSync(ALLOWED_USERS_FILE, JSON.stringify(allowedUsersCache, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error("[AllowedUsers] Failed to save allowed_users.json:", err.message);
    return false;
  }
}

/**
 * Syncs allowed users from cloud JSONBlob (identically to allowed_admins).
 */
async function syncAllowedUsersFromCloud(roomUid) {
  const envBlobId = process.env.ALLOWED_USERS_BLOB_ID || process.env.AUTH_USERS_BLOB_ID || process.env.ALLOWED_USER_BLOB_ID;
  if (envBlobId) {
    console.log(`[AllowedUsers] Syncing allowed users using env blob ID: ${envBlobId}`);
    try {
      const agent = getProxyAgent();
      const res = await axios.get(`https://jsonblob.com/api/jsonBlob/${envBlobId}`, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        },
        ...(agent ? { httpsAgent: agent } : {}),
        timeout: 10000
      });
      applyCloudData(res.data);
      return;
    } catch (err) {
      console.error(`[AllowedUsers] Failed to read env JSON Blob ${envBlobId}:`, err.message);
    }
    loadAllowedUsers();
    return;
  }

  if (!roomUid) {
    loadAllowedUsers();
    return;
  }

  try {
    const details = await getRoomDetails(roomUid);
    if (!details) {
      loadAllowedUsers();
      return;
    }

    const desc = details.roomDesc || "";
    const uuids = decodeUUIDs(desc);
    const userBlobId = uuids.length > 1 ? uuids[1] : null;

    if (userBlobId) {
      console.log(`[AllowedUsers] Found room-encoded JSONBlob ID: ${userBlobId}`);
      try {
        const agent = getProxyAgent();
        const res = await axios.get(`https://jsonblob.com/api/jsonBlob/${userBlobId}`, {
          headers: { Accept: "application/json" },
          ...(agent ? { httpsAgent: agent } : {}),
          timeout: 10000
        });
        applyCloudData(res.data);
        return;
      } catch (getErr) {
        console.error(`[AllowedUsers] Failed to fetch cloud JSONBlob ${userBlobId}:`, getErr.message);
      }
    }
  } catch (err) {
    console.error("[AllowedUsers] Error in syncAllowedUsersFromCloud:", err.message);
  }

  loadAllowedUsers();
}

function applyCloudData(data) {
  if (Array.isArray(data)) {
    const fromCloud = data.map(u => String(u).toLowerCase().trim()).filter(Boolean);
    saveAllowedUsersLocally(fromCloud);
    console.log(`[AllowedUsers] Successfully synced ${fromCloud.length} allowed users from cloud.`);
  } else if (data && typeof data === "object") {
    if (Array.isArray(data.users)) {
      const fromCloud = data.users.map(u => String(u).toLowerCase().trim()).filter(Boolean);
      saveAllowedUsersLocally(fromCloud);
      console.log(`[AllowedUsers] Successfully synced ${fromCloud.length} allowed users from cloud.`);
    }
    if (typeof data.locked === "boolean") {
      setRoomLocked(data.locked);
      console.log(`[AllowedUsers] Synced room lock status from cloud: ${data.locked ? "LOCKED" : "UNLOCKED"}`);
    }
  }
}

/**
 * Saves locally and syncs to JSONBlob (identically to allowed_admins).
 */
async function saveAllowedUsersAndSync(list, roomUid) {
  saveAllowedUsersLocally(list);

  const payloadData = {
    locked: isRoomLocked(),
    users: allowedUsersCache
  };

  const envBlobId = process.env.ALLOWED_USERS_BLOB_ID || process.env.AUTH_USERS_BLOB_ID || process.env.ALLOWED_USER_BLOB_ID;
  if (envBlobId) {
    try {
      const agent = getProxyAgent();
      await axios.put(`https://jsonblob.com/api/jsonBlob/${envBlobId}`, payloadData, {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        },
        ...(agent ? { httpsAgent: agent } : {}),
        timeout: 10000
      });
      console.log(`[AllowedUsers] Updated cloud JSONBlob ${envBlobId}.`);
    } catch (err) {
      console.error("[AllowedUsers] Failed to update cloud allowed users via env blob ID:", err.message);
    }
    return;
  }

  if (!roomUid) return;

  try {
    const details = await getRoomDetails(roomUid);
    if (!details) return;

    const desc = details.roomDesc || "";
    const uuids = decodeUUIDs(desc);
    const adminBlobId = uuids.length > 0 ? uuids[0] : null;
    let userBlobId = uuids.length > 1 ? uuids[1] : null;

    const agent = getProxyAgent();

    if (userBlobId) {
      await axios.put(`https://jsonblob.com/api/jsonBlob/${userBlobId}`, payloadData, {
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        ...(agent ? { httpsAgent: agent } : {}),
        timeout: 10000
      });
      console.log(`[AllowedUsers] Updated cloud JSONBlob ${userBlobId}.`);
    } else {
      console.log("[AllowedUsers] Creating new cloud JSONBlob for allowed users...");
      const createRes = await axios.post("https://jsonblob.com/api/jsonBlob", payloadData, {
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        ...(agent ? { httpsAgent: agent } : {}),
        timeout: 10000
      });
      const location = createRes.headers["location"] || "";
      const newBlobId = location.split("/").pop();
      if (!newBlobId) return;

      console.log(`[AllowedUsers] New JSONBlob ID created for allowed users: ${newBlobId}`);

      const baseDesc = desc.replace(/[\u200C\u200D\u200B]+/g, "").trim();
      const targetDesc = ROOM_DESC || baseDesc;
      const adminPart = adminBlobId ? encodeUUID(adminBlobId) : "";
      const userPart = encodeUUID(newBlobId);
      const newDesc = `${targetDesc}\n\n${adminPart}${userPart}`.trim();

      const patchPayload = {
        roomName: details.roomName || ROOM_NAME,
        roomDesc: newDesc,
        roomGenre: details.roomGenre || ["Popular"],
        roomCountry: "IN",
        maxParticipants: details.maxParticipants || 50
      };

      await axios.patch(`https://api.groic.in/api/room/${roomUid}`, patchPayload, {
        headers: getGroicHeaders(),
        timeout: 10000
      });
      console.log("[AllowedUsers] Registered allowed users JSONBlob ID in room description invisibly.");
    }
  } catch (err) {
    console.error("[AllowedUsers] Failed to sync allowed users to cloud room description:", err.message);
  }
}

/**
 * Checks if a user is authorized to enter when the room is locked.
 */
function isAllowedUser(username) {
  if (!username) return false;
  const clean = username.toLowerCase().trim();
  if (clean === OWNER_USERNAME.toLowerCase().trim()) return true;

  const list = loadAllowedUsers();
  return list.includes(clean);
}

/**
 * Adds a user to the allowed list.
 */
async function addAllowedUser(username, roomUid) {
  const clean = username.toLowerCase().trim();
  const list = loadAllowedUsers();
  if (!list.includes(clean)) {
    list.push(clean);
    await saveAllowedUsersAndSync(list, roomUid);
    return true;
  }
  return false;
}

/**
 * Removes a user from the allowed list.
 */
async function removeAllowedUser(username, roomUid) {
  const clean = username.toLowerCase().trim();
  const list = loadAllowedUsers();
  const index = list.indexOf(clean);
  if (index !== -1) {
    list.splice(index, 1);
    await saveAllowedUsersAndSync(list, roomUid);
    return true;
  }
  return false;
}

/**
 * Lock state getters and setters.
 */
function isRoomLocked() {
  return roomLocked;
}

function setRoomLocked(locked, roomUid) {
  roomLocked = Boolean(locked);
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ locked: roomLocked, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  } catch (err) {
    console.error("[AllowedUsers] Failed to save room_lock.json:", err.message);
  }

  const envBlobId = process.env.ALLOWED_USERS_BLOB_ID || process.env.AUTH_USERS_BLOB_ID || process.env.ALLOWED_USER_BLOB_ID;
  if (roomUid || envBlobId) {
    saveAllowedUsersAndSync(loadAllowedUsers(), roomUid).catch(() => {});
  }
}

module.exports = {
  loadAllowedUsers,
  isAllowedUser,
  addAllowedUser,
  removeAllowedUser,
  syncAllowedUsersFromCloud,
  saveAllowedUsersAndSync,
  isRoomLocked,
  setRoomLocked
};
