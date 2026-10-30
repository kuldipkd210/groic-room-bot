module.exports = {
  OWNER_USERNAME: "kd_zoro",
  BOT_NAME: "xaix",
  BOT_IMAGE_URL: "https://i.ibb.co/wNVgfQRK/fgdsgf.jpg",
  ROOM_FILE: "room.json",

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
  NOTIFY_COOLDOWN_MS: 60000, // 1 minute (60 seconds) between phone alerts

  // Spotify default playlist (can also be set via SPOTIFY_PLAYLIST_URL in .env)
  DEFAULT_SPOTIFY_PLAYLIST: process.env.SPOTIFY_PLAYLIST_URL || "",

  // Hardcoded default playlists (empty by default; managed manually via bot commands)
  DEFAULT_PLAYLISTS: {},

  // Hardcoded default allowed admins (always permitted, synced with Pantry 'allowed_admins')
  DEFAULT_ALLOWED_ADMINS: [
    "kd_zoro",
    "_its_shru_",
    "dedsec_404",
    "_kevin_11_"
  ],

  // Hardcoded default allowed users (always permitted, synced with Pantry 'allowed_users')
  DEFAULT_ALLOWED_USERS: [
    "kd_zoro",
    "_its_shru_",
    "dedsec_404",
    "_kevin_11_"
  ]
};

