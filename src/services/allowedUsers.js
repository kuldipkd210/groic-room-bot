const fs = require("fs");
const path = require("path");
const { OWNER_USERNAME, DEFAULT_ALLOWED_USERS } = require("../../config/constants");

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

/**
 * Loads allowed users list from local allowed_users.json.
 */
function loadAllowedUsers() {
  if (allowedUsersCache) return allowedUsersCache;

  const defaults = DEFAULT_ALLOWED_USERS.map(u => u.toLowerCase().trim());

  if (!fs.existsSync(ALLOWED_USERS_FILE)) {
    saveAllowedUsersLocally(defaults);
    return allowedUsersCache;
  }

  try {
    const raw = fs.readFileSync(ALLOWED_USERS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    let list = [];
    if (Array.isArray(parsed)) {
      list = parsed.map(u => String(u).toLowerCase().trim()).filter(Boolean);
    } else if (parsed && Array.isArray(parsed.users)) {
      list = parsed.users.map(u => String(u).toLowerCase().trim()).filter(Boolean);
    }
    // Ensure all hardcoded default allowed users are always present
    const merged = Array.from(new Set([...defaults, ...list]));
    saveAllowedUsersLocally(merged);
    return allowedUsersCache;
  } catch (err) {
    console.error("[AllowedUsers] Failed to read allowed_users.json:", err.message);
    saveAllowedUsersLocally(defaults);
    return allowedUsersCache;
  }
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

const { getBasket, setBasket } = require("./pantry");

/**
 * Syncs allowed users from Pantry cloud storage on startup or room join.
 */
async function syncAllowedUsersFromCloud() {
  console.log("[AllowedUsers] Syncing allowed users from Pantry cloud basket: 'allowed_users'");
  const cloudData = await getBasket("allowed_users");

  if (cloudData && typeof cloudData === "object") {
    await applyCloudData(cloudData);
    return;
  }

  // If Pantry is empty, push local data (including hardcoded users) up to Pantry
  const localList = loadAllowedUsers();
  if (localList.length > 0) {
    console.log(`[AllowedUsers] Pantry basket empty. Pushing ${localList.length} local allowed users to Pantry...`);
    await setBasket("allowed_users", {
      locked: isRoomLocked(),
      users: localList
    });
    return;
  }

  loadAllowedUsers();
}

async function applyCloudData(data) {
  const defaults = DEFAULT_ALLOWED_USERS.map(u => u.toLowerCase().trim());
  let fromCloud = [];

  if (Array.isArray(data)) {
    fromCloud = data.map(u => String(u).toLowerCase().trim()).filter(Boolean);
  } else if (data && typeof data === "object") {
    if (Array.isArray(data.users)) {
      fromCloud = data.users.map(u => String(u).toLowerCase().trim()).filter(Boolean);
    }
    if (typeof data.locked === "boolean") {
      setRoomLocked(data.locked, null, true);
      console.log(`[AllowedUsers] Synced room lock status from cloud: ${data.locked ? "LOCKED" : "UNLOCKED"}`);
    }
  }

  // Guarantee hardcoded users are always present
  const merged = Array.from(new Set([...defaults, ...fromCloud]));
  saveAllowedUsersLocally(merged);
  console.log(`[AllowedUsers] Successfully synced ${merged.length} allowed users from cloud.`);

  // If cloud was missing any hardcoded defaults, update Pantry so it has all of them
  if (merged.length !== fromCloud.length) {
    await setBasket("allowed_users", {
      locked: isRoomLocked(),
      users: merged
    });
  }
}

/**
 * Saves locally and syncs to Pantry cloud storage.
 */
async function saveAllowedUsersAndSync(list) {
  saveAllowedUsersLocally(list);

  const payloadData = {
    locked: isRoomLocked(),
    users: allowedUsersCache
  };

  console.log("[AllowedUsers] Uploading allowed users to Pantry cloud basket: 'allowed_users'");
  const syncResult = await setBasket("allowed_users", payloadData);
  return syncResult;
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

function setRoomLocked(locked, roomUid, skipCloudSync = false) {
  roomLocked = Boolean(locked);
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ locked: roomLocked, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  } catch (err) {
    console.error("[AllowedUsers] Failed to save room_lock.json:", err.message);
  }

  if (!skipCloudSync) {
    saveAllowedUsersAndSync(loadAllowedUsers()).catch(() => {});
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
