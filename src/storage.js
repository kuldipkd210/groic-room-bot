const fs = require("fs");
const path = require("path");
const { ROOM_FILE } = require("../config/constants");

const CALL_SETTINGS_FILE = path.join(__dirname, "../call_settings.json");

function saveRoomUid(roomUid) {
  fs.writeFileSync(ROOM_FILE, JSON.stringify({ roomUid }, null, 2));
}

function loadRoomUid() {
  if (!fs.existsSync(ROOM_FILE)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(ROOM_FILE, "utf8"));
    return data.roomUid || null;
  } catch {
    return null;
  }
}

function loadDisabledCalls() {
  if (!fs.existsSync(CALL_SETTINGS_FILE)) {
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(CALL_SETTINGS_FILE, "utf8"));
    return Array.isArray(data.disabled) ? data.disabled : [];
  } catch {
    return [];
  }
}

function saveDisabledCalls(list) {
  try {
    fs.writeFileSync(CALL_SETTINGS_FILE, JSON.stringify({ disabled: list }, null, 2));
  } catch (err) {
    console.error("[Storage] Failed to save call settings:", err.message);
  }
}

function isCallDisabled(username) {
  if (!username) return false;
  const norm = username.toLowerCase().trim();
  const list = loadDisabledCalls();
  return list.includes(norm);
}

function setCallDisabled(username, disabled) {
  if (!username) return;
  const norm = username.toLowerCase().trim();
  let list = loadDisabledCalls();
  if (disabled) {
    if (!list.includes(norm)) {
      list.push(norm);
    }
  } else {
    list = list.filter((u) => u !== norm);
  }
  saveDisabledCalls(list);
}

module.exports = {
  saveRoomUid,
  loadRoomUid,
  isCallDisabled,
  setCallDisabled,
  loadDisabledCalls
};

