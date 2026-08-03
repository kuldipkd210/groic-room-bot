module.exports = {
  USER_ID: "ZD8n4XeV1Ad3R9EgyRa5ASa8S8s1",
  OWNER_USERNAME: "kd_zoro",
  BOT_NAME: "xaix",
  BOT_IMAGE_URL: "https://i.ibb.co/wNVgfQRK/fgdsgf.jpg",
  ROOM_NAME: "Wolf in the North",
  ROOM_DESC: "The North Remembers.",
  ROOM_GENRE: ["Classical", "Popular"],
  MAX_PARTICIPANTS: 50,
  ROOM_FILE: "room.json",
  // You can pass a string ID, or an object with custom properties.

  GHOST_ROOMS: [
    { uid: "", copyAvatarFrom: "" },
    // Example 1: { uid: "room_id", copyAvatarFrom: "username" } -> Copies the avatar of a specific user already in the room
    // Example 2: { uid: "room_id", imageUrl: "https://example.com/img.jpg" } -> Sets a custom direct image URL
  ],

  OWNER_NOTIFY_TRIGGERS: [
    "@owner",
    "owner",
    "@kd",
    "kd",
    "kd_zoro"
  ],
  EXPLICIT_CALL_COMMANDS: [
    "!callowner",
    "!callkd",
    "!kd"
  ],
  FRIEND_CALL_COMMANDS: [
    {
      commands: ["!404", "!ded"],
      username: "dedsec_404",
      topic: "dedsec_404",
      triggers: []
    }
  ],
  NOTIFY_COOLDOWN_MS: 60000 // 1 minute (60 seconds) between phone alerts
};
