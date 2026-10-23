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
  DEFAULT_SPOTIFY_PLAYLIST:
    process.env.SPOTIFY_PLAYLIST_URL ||
    "https://open.spotify.com/playlist/4PzvrgzKxotDakMn5v4QCG?si=n8syYPnDQFCZI1CyrS1JrQ",

  // Hardcoded default playlists
  DEFAULT_PLAYLISTS: {
    soft: "https://open.spotify.com/playlist/4PzvrgzKxotDakMn5v4QCG?si=n8syYPnDQFCZI1CyrS1JrQ",
    v2: "https://open.spotify.com/playlist/57R2ymQ9Ulb3c7AR92XBvk?si=E132XELtT_qyU5M3ogp1QA"
  }
};

