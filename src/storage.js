const fs = require("fs");
const { ROOM_FILE } = require("../config/constants");

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

module.exports = {
  saveRoomUid,
  loadRoomUid
};
